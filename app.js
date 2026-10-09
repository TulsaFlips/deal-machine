/* Oklahoma Deal Machine web app: deals, map and tracker, read from the owner's private GitHub project. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = v => v == null || !isFinite(v) ? "—" : "$" + Math.round(v).toLocaleString("en-US");
  const title = s => s ? String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(Ne|Nw|Se|Sw|Po|Llc|Ok)\b/g, m => m.toUpperCase()) : "";

  // ---- plays ------------------------------------------------------------------------------------
  const PLAYS = {
    "Commissioner's sale bid": { g: "buy", label: "Buy now from the county", todo: ["Call this county's treasurer.", "Give them the parcel number and ask how to bid at the commissioner's sale. Prices are often a few hundred dollars. Ask a title company about a quiet-title action before you count on reselling."] },
    "June tax resale": { g: "auction", label: "June tax auction", todo: ["Mark the auction on your calendar.", "It runs the second Monday of June at the county treasurer. Until then, a letter to the owner can get you a deal before the auction does."] },
    "Pre-foreclosure": { g: "owner", label: "Pre-foreclosure", todo: ["Mail the owner a letter.", "They may want out before the foreclosure finishes."] },
    "REO / agency-owned": { g: "bank", label: "Bank or agency owned", todo: ["Ask for the owner's REO department.", "Banks and agencies sell repossessed property, sometimes in bulk. The listing agent or the asset manager is the person to reach."] },
    "Probate / heirs": { g: "owner", label: "Heirs / estate", todo: ["Mail the family a letter.", "Settling an estate is a lot of work. Be patient and respectful; the letter offers to work with their attorney or title company."] },
    "Tax-delinquent owner": { g: "owner", label: "Behind on taxes", todo: ["Mail the owner a letter.", "Owners behind on taxes often want a simple way out before the county sells the property."] },
    "Storm-damaged": { g: "owner", label: "Storm damage", todo: ["Mail the owner a letter.", "A surveyed tornado or wind hit. Some owners would rather sell than manage the repair."] },
    "Public owner: land bank / surplus": { g: "bank", label: "City / land bank", todo: ["Ask the owner about surplus sales.", "Cities, school districts and land banks sell property they don't need, sometimes cheaply to buyers who will fix it up."] },
    "Neglected property": { g: "owner", label: "Neglected", todo: ["Drive by, then mail the owner.", "Vacant land or a run-down house with an owner who lives elsewhere."] },
    "Absentee owner": { g: "owner", label: "Absentee owner", todo: ["Mail the owner a letter.", "The owner lives somewhere else. Landlords and inheritors are often ready to be done with it."] },
    "Watchlist": { g: "watch", label: "Watchlist", todo: ["Keep an eye on it.", "Some distress, not enough to act on yet."] },
  };
  const GROUP_COLOR = { buy: "--accent", auction: "--amber", owner: "--ink", bank: "--slate", watch: "--muted" };
  function playOf(d) {
    const raw = d.deal_type || "Watchlist";
    const m = raw.match(/^(.*?)(?: \((lot|house)\))?$/);
    const base = m[1].startsWith("Public owner") ? "Public owner: land bank / surplus" : m[1];
    const info = PLAYS[base] || { g: "owner", label: base, todo: ["Mail the owner a letter.", ""] };
    return { base, kind: m[2] || "", ...info };
  }
  const STATUSES = ["To mail", "Mailed", "Called", "Talking", "Under contract", "Bought", "Pass"];

  // ---- state ------------------------------------------------------------------------------------
  const S = {
    deals: [], byKey: new Map(), meta: null, sample: false,
    filter: null,  // set at boot from FILTER_DEFAULTS and what this device remembers
    shown: 60, sel: null, view: "deals", spot: null, tracked: {}, newCut: null,
    gh: null, index: null, loading: false, loadError: "", keyProblem: false, showConnect: false,
    latestRun: null, asked: null, failedRun: null, installEvt: null,
    sync: { at: 0, problem: "", pending: false },
  };
  const FILTER_DEFAULTS = { tags: [], match: "any", counties: [], q: "", sort: "score", hidePass: true, onlyNew: false, kind: "", maxPrice: null, minAcres: null, minScore: null, minTaxYears: null };
  const keyOf = d => d.county + "|" + d.parcel_id;
  const safeUrl = u => /^https:\/\//i.test(String(u || "")) ? String(u) : "";
  const clock = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const runLabel = day => day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "latest";

  // ---- local storage helpers (per-device conveniences) --------------------------------------------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("dm:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("dm:" + k, JSON.stringify(v)); } catch (e) {} },
  };
  const IDB = {
    open() { return new Promise((res, rej) => { try { const r = indexedDB.open("deal-machine", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    async get(k) { try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv").objectStore("kv").get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
    async set(k, v) { try { const db = await this.open(); await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} },
  };

  // ---- toast + status -----------------------------------------------------------------------------
  let toastTimer;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
  function setStatus(html) { $("status").innerHTML = html; }

  // ---- GitHub ---------------------------------------------------------------------------------------
  // Everything lives in the owner's private GitHub project, reached with a fine-grained key that stays on
  // this device: the robot's weekly deals (app-data branch), the tracker (one JSON file on the
  // app-tracking branch) and the robot itself (the harvest workflow, for a fresh run).
  const API = "https://api.github.com";
  const DEFAULT_REPO = "TulsaFlips/development";
  const DATA_BRANCH = "app-data", TRACK_BRANCH = "app-tracking", TRACK_FILE = "tracking.json", WORKFLOW = "harvest.yml";
  const RUN_MINUTES = 25;

  function keyUrl(repo) {
    const q = new URLSearchParams({
      name: "Deal Machine app",
      description: "Lets the Deal Machine web app read this week's deals, save your tracker and start a fresh run.",
      target_name: String(repo || DEFAULT_REPO).split("/")[0], expires_in: "366", contents: "write", actions: "write",
    });
    return "https://github.com/settings/personal-access-tokens/new?" + q;
  }

  class GHError extends Error {
    constructor(status, detail) { super("github_" + status); this.status = status; this.detail = detail || ""; }
  }
  let connecting = false;
  async function gh(path, { method = "GET", body, raw = false } = {}) {
    const cfg = S.gh;
    if (!cfg) throw new GHError(0, "not_connected");
    let r;
    try {
      r = await fetch(API + "/repos/" + cfg.repo + path, {
        method, cache: "no-store", referrerPolicy: "no-referrer",
        headers: {
          Authorization: "Bearer " + cfg.token, "X-GitHub-Api-Version": "2022-11-28",
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw new GHError(0, "offline"); }
    if (r.status === 401 && !connecting) keyStopped();
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new GHError(429);
    if (!r.ok) throw new GHError(r.status, await r.text().catch(() => ""));
    return r;
  }
  async function ghJSON(path, opts) { const r = await gh(path, opts); return r.status === 204 ? null : r.json(); }
  const ghText = (file, ref) => gh(`/contents/${file}?ref=${encodeURIComponent(ref)}`, { raw: true }).then(r => r.text());

  function keyStopped() {
    if (S.keyProblem) return;
    S.keyProblem = true;
    renderAll();
  }

  async function connect(token, repo) {
    token = String(token || "").trim();
    repo = String(repo || DEFAULT_REPO).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/+$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "That doesn't look like a GitHub project. It should look like TulsaFlips/development.";
    if (!/^(github_pat_|ghp_)\w{20,}$/.test(token)) return "That doesn't look like a GitHub key. Copy the whole thing; it starts with github_pat_.";
    const prev = S.gh;
    S.gh = { token, repo };
    connecting = true;
    try {
      const info = await ghJSON("");
      S.gh.branch = info.default_branch;
    } catch (e) {
      S.gh = prev;
      if (e.status === 401) return "GitHub didn't accept that key. Copy it again and paste the whole thing.";
      if (e.status === 403 || e.status === 404) return `That key can't see ${repo}. On GitHub, open the key and set Repository access to Only select repositories → ${repo.split("/")[1]}.`;
      return "Couldn't reach GitHub. Check your internet connection and try again.";
    } finally { connecting = false; }
    if (prev && prev.repo !== repo) { T = {}; persistTracking(); setTracked(); await IDB.set("pack", null); S.deals = []; S.byKey = new Map(); S.meta = null; }
    LS.set("gh", S.gh);
    S.keyProblem = false; S.showConnect = false; S.loadError = "";
    if (S.sample) { S.deals = []; S.byKey = new Map(); S.sample = false; }
    renderAll();
    refresh({ announce: true }); syncTracking(); checkRun();
    return "";
  }

  async function disconnect() {
    if (!confirm("Disconnect this device? Its GitHub key and its copy of the deals are removed. Your tracker stays in your GitHub project.")) return;
    await syncTracking().catch(() => {});
    S.gh = null; ["gh", "index", "asked", "failedRun"].forEach(k => LS.set(k, null));
    await IDB.set("pack", null);
    T = {}; persistTracking(); setTracked();
    Object.assign(S, { deals: [], byKey: new Map(), meta: null, sample: false, index: null, sel: null, latestRun: null, asked: null, failedRun: null, keyProblem: false, showConnect: false, loadError: "" });
    showView("deals"); renderAll();
  }

  // ---- this week's deals ----------------------------------------------------------------------------
  function compact(deals, source) {
    const cols = Array.from(deals.reduce((s, d) => { Object.keys(d).forEach(k => s.add(k)); return s; }, new Set()));
    return { v: 1, loadedAt: new Date().toISOString(), source, cols, rows: deals.map(d => cols.map(c => d[c] ?? null)) };
  }
  function expand(pack) { return pack.rows.map(r => Object.fromEntries(pack.cols.map((c, i) => [c, r[i]]))); }
  const metaOf = pack => ({ loadedAt: pack.loadedAt, generatedAt: pack.generatedAt, runDate: pack.runDate, source: pack.source });

  function setDeals(deals, meta, sample) {
    deals.forEach(d => {
      d.key = keyOf(d); d.p = playOf(d); d.tags = DM.tagsOf(d); d.tagSet = new Set(d.tags);
      const t = DM.taxInfo(d); d.taxYears = t.years; d.taxOwed = t.owed;
    });
    deals.sort((a, b) => (b.score || 0) - (a.score || 0));
    S.deals = deals; S.meta = meta; S.sample = !!sample;
    S.byKey = new Map(deals.map(d => [d.key, d]));
    const seen = Array.from(new Set(deals.map(d => (d.first_seen || "").slice(0, 10)).filter(Boolean))).sort();
    S.newCut = seen.length > 1 ? seen[seen.length - 1] : null;  // "new" only means something once history exists
    S.shown = 60;
    buildFilterOptions();
    renderAll();
  }

  async function loadCached() {
    const pack = await IDB.get("pack");
    if (pack && pack.rows && pack.rows.length) setDeals(expand(pack), metaOf(pack), false);
  }

  let refreshing = null, lastRefresh = 0;
  function refresh(opts) {
    if (!refreshing) refreshing = doRefresh(opts || {}).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function doRefresh({ announce }) {
    if (!S.gh || S.keyProblem) return;
    lastRefresh = Date.now();
    S.loading = !S.deals.length || S.sample;
    if (S.loading) renderAll();
    try {
      const idx = JSON.parse(await ghText("index.json", DATA_BRANCH));
      S.index = idx; LS.set("index", idx); S.loadError = "";
      const have = S.meta && S.meta.generatedAt;
      if (have === idx.generated_at && S.deals.length && !S.sample) {
        if (announce === "button") toast("You already have the newest deals.");
        return;
      }
      setStatus('<span class="busy" aria-hidden="true"></span> Getting this week\'s deals…');
      const parts = await Promise.all(idx.parts.map(n => ghText(n, DATA_BRANCH).then(t => JSON.parse(t).rows)));
      const pack = { v: 1, cols: idx.cols, rows: [].concat(...parts), generatedAt: idx.generated_at, loadedAt: idx.generated_at, runDate: idx.run_date, source: "github" };
      await IDB.set("pack", pack);
      S.loading = false;
      setDeals(expand(pack), metaOf(pack), false);
      if (announce || (have && have !== idx.generated_at)) toast(`${pack.rows.length.toLocaleString()} deals from the ${runLabel(pack.runDate)} run.`);
    } catch (e) {
      if (e.status === 401) return;
      S.loadError = e.status === 404 ? "nodata" : e.status === 0 ? "offline" : "github";
      if (announce === "button") toast(S.loadError === "offline" ? "You're offline. Showing the deals saved on this device." : "Couldn't check GitHub just now. Try again in a minute.");
    } finally { S.loading = false; renderAll(); }
  }

  function updateStatus() {
    if (S.sample) { setStatus("Showing sample deals · connect your GitHub project to see real ones"); return; }
    if (!S.deals.length) { setStatus(!S.gh ? "Not connected yet" : S.loading ? "Getting this week's deals…" : "No deals on this device yet"); return; }
    const n = S.deals.length.toLocaleString();
    const off = S.loadError === "offline" ? " · offline" : "";
    if (S.meta && S.meta.source === "github") { setStatus(`${n} deals from the ${runLabel(S.meta.runDate)} run · new ones every Monday${off}`); return; }
    const when = S.meta && S.meta.loadedAt ? new Date(S.meta.loadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    setStatus(`${n} deals · loaded from a file ${when}${off}`);
  }

  // This week's letters and the mailing list sit next to the deals; save either as a file.
  async function saveWeekFile(kind, btn) {
    const files = (S.index && S.index.files) || {};
    if (!files[kind]) return;
    const date = (S.index && S.index.run_date) || new Date().toISOString().slice(0, 10);
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Getting it…";
    try {
      const text = await ghText(files[kind], DATA_BRANCH);
      saveBlob(new Blob([text], { type: kind === "letters" ? "text/html" : "text/csv" }), kind === "letters" ? `letters-${date}.html` : `mailing-list-${date}.csv`);
      toast(kind === "letters" ? "Saved. Open the file and print it." : "Saved. Send it to your mail house.");
    } catch (e) {
      if (e.status !== 401) toast(e.status === 0 ? "You're offline. Try again when you have signal." : "Couldn't get that file just now. Try again in a minute.");
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  function weekFilesHTML(withRun = true) {
    const files = S.gh && S.index && S.index.files;
    if (!files || S.sample) return "";
    return `<div class="row weekbar">${files.letters ? '<button class="btn small" type="button" data-act="save-letters">Letters to print</button>' : ""}${files.mailing ? '<button class="btn small" type="button" data-act="save-mailing">Mailing list</button>' : ""}${withRun ? runControlsHTML(true) : ""}</div>`;
  }

  // ---- loading a file (no GitHub key needed) ------------------------------------------------------
  let pwResolve = null;
  function askPassword(msg) {
    return new Promise(res => {
      pwResolve = res;
      $("pw-err").textContent = msg || "";
      $("pw").value = "";
      $("pw-modal").hidden = false;
      setTimeout(() => $("pw").focus(), 30);
    });
  }
  $("pw-form").addEventListener("submit", e => { e.preventDefault(); const v = $("pw").value; $("pw-modal").hidden = true; if (pwResolve) pwResolve(v); pwResolve = null; });
  $("pw-cancel").addEventListener("click", () => { $("pw-modal").hidden = true; if (pwResolve) pwResolve(null); pwResolve = null; });

  const LOAD_ERRORS = {
    not_zip: "That file isn't the weekly download. Pick the leads-… zip from the harvest run, or leads.csv.",
    bad_zip: "That zip looks damaged. Download it again from the harvest run.",
    zip_without_leads: "That zip has no deals in it. It must be the leads-… download from a finished harvest run.",
    tar_without_leads: "That archive has no leads.csv inside.",
    not_leads_csv: "That spreadsheet isn't leads.csv from the Deal Machine.",
    empty_csv: "That file is empty.",
  };
  async function loadFile(file) {
    if (!file) return;
    setStatus('<span class="busy" aria-hidden="true"></span> Opening the file…');
    try {
      const deals = await DM.unpack(new Uint8Array(await file.arrayBuffer()), askPassword);
      if (!deals.length) throw new Error("empty_csv");
      const pack = compact(deals, file.name);
      pack.generatedAt = pack.loadedAt;
      await IDB.set("pack", pack);
      S.showConnect = false;
      setDeals(expand(pack), metaOf(pack), false);
      toast(`Loaded ${deals.length.toLocaleString()} deals. Saved on this device.`);
      showView("deals");
    } catch (e) {
      if (e.message !== "cancelled") toast(LOAD_ERRORS[e.message] || "Couldn't open that file. Pick the leads-… zip from the harvest run.");
    } finally { $("file").value = ""; updateStatus(); }
  }
  $("file").addEventListener("change", e => loadFile(e.target.files[0]));
  document.addEventListener("dragover", e => { e.preventDefault(); });
  document.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  // ---- the robot: its newest run, and "Get fresh deals now" -----------------------------------------
  let runTimer = null, watching = null;
  const activeRun = () => {
    const r = S.latestRun;
    return r && r.status !== "completed" && Date.now() - Date.parse(r.created) < 3 * 3600e3 ? r : null;
  };
  const waitingForMine = () => !!(S.asked && !activeRun() && Date.now() - S.asked.at < 10 * 60000);

  async function checkRun() {
    if (!S.gh || S.keyProblem) return;
    clearTimeout(runTimer);
    try {
      const j = await ghJSON(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
      const r = (j && j.workflow_runs || [])[0];
      S.latestRun = r ? { id: r.id, status: r.status, conclusion: r.conclusion, created: r.created_at, started: r.run_started_at || r.created_at, url: safeUrl(r.html_url) } : null;
    } catch (e) { scheduleRunCheck(); return; }
    const r = S.latestRun;
    const mine = !!(r && S.asked && Date.parse(r.created) >= S.asked.at - 120000);
    if (r && r.status === "completed" && (mine || watching === r.id)) {
      S.asked = null; LS.set("asked", null); watching = null;
      if (r.conclusion === "success") { S.failedRun = null; LS.set("failedRun", null); refresh({ announce: true }); }
      else if (r.conclusion !== "cancelled") { S.failedRun = { url: r.url, at: r.created }; LS.set("failedRun", S.failedRun); }
    } else if (r && r.status !== "completed") watching = r.id;
    if (S.asked && !mine && Date.now() - S.asked.at > 10 * 60000) {  // GitHub never picked it up
      S.asked = null; LS.set("asked", null); S.failedRun = { url: "", at: new Date().toISOString() }; LS.set("failedRun", S.failedRun);
    }
    renderRun();
    scheduleRunCheck();
  }
  function scheduleRunCheck() {
    clearTimeout(runTimer);
    if (activeRun() || waitingForMine()) runTimer = setTimeout(checkRun, 30000);
  }

  async function startRun() {
    try {
      if (!S.gh.branch) { S.gh.branch = (await ghJSON("")).default_branch; LS.set("gh", S.gh); }
      await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: S.gh.branch, inputs: { limit: "", only: "" } } });
    } catch (e) {
      if (e.status === 403 || e.status === 404) toast("Your key can't start the robot. Make a new key with Actions set to Read and write.");
      else if (e.status === 0) toast("You're offline. Try again when you have signal.");
      else if (e.status !== 401) toast("Couldn't start the robot just now. Try again in a minute.");
      return false;
    }
    S.asked = { at: Date.now() }; LS.set("asked", S.asked);
    S.failedRun = null; LS.set("failedRun", null);
    toast(`Started. It takes about ${RUN_MINUTES} minutes; the new deals show up here by themselves.`);
    renderAll();
    setTimeout(checkRun, 8000);
    return true;
  }

  function runBarHTML() {
    if (!S.gh || S.keyProblem) return "";
    const r = activeRun();
    if (r) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(r.started)) / 60000));
      const left = mins < RUN_MINUTES ? `about ${Math.max(1, RUN_MINUTES - mins)} min to go` : "taking a little longer than usual";
      return `<div class="runbar" role="status"><span class="busy" aria-hidden="true"></span><span><b>The robot is running.</b> Started ${esc(clock(r.started))}, ${left}. The new deals show up here by themselves.</span></div>`;
    }
    if (waitingForMine()) return '<div class="runbar" role="status"><span class="busy" aria-hidden="true"></span><span><b>Starting the robot…</b> GitHub usually picks it up within a minute or two.</span></div>';
    if (S.failedRun) {
      return `<div class="runbar bad" role="alert"><span><b>The robot's last run didn't finish.</b> Your deals from before are still here.</span>`
        + (S.failedRun.url ? `<a class="btn small" href="${esc(S.failedRun.url)}" target="_blank" rel="noopener">See what happened ↗</a>` : "")
        + '<button class="btn small" type="button" data-act="dismiss-fail">OK</button></div>';
    }
    return "";
  }
  function renderRun() { $("run-slot").innerHTML = runBarHTML(); }
  function runControlsHTML(small) {
    if (!S.gh || S.keyProblem) return "";
    if (activeRun() || waitingForMine()) return small ? "" : '<p class="hint">The robot is running now. The new deals show up here by themselves.</p>';
    return `<span class="row" data-runbox><button class="btn${small ? " small" : ""}" type="button" data-act="run-ask">Get fresh deals now</button></span>`;
  }

  // ---- tracking: saved on this device at once, then synced through the project ----------------------
  let T = LS.get("trackAll", {}) || {};  // every entry, cleared ones included as tombstones
  function setTracked() { S.tracked = DM.liveTracking(T); }
  function persistTracking() { LS.set("trackAll", T); }
  function afterTrackingChange() {
    renderTrackedCount(); renderList();
    if (S.view === "tracked") renderTracked();
  }
  function writeTrack(key, patch) {
    const d = S.byKey.get(key) || {};
    const cur = S.tracked[key] || {};
    const now = new Date().toISOString();
    const next = { ...cur, ...patch, key, county: d.county || cur.county, parcel_id: d.parcel_id || cur.parcel_id,
      address: d.situs_address || cur.address || null, city: d.situs_city || cur.city || null,
      play: d.deal_type || cur.play || null, score: d.score ?? cur.score ?? null, updatedAt: now };
    const clear = !next.status && !(next.note || "").trim();
    T[key] = clear ? { key, deleted: true, updatedAt: now } : next;
    setTracked(); persistTracking(); afterTrackingChange();
    S.sync.pending = true; renderSyncNote();
    clearTimeout(syncTimer); syncTimer = setTimeout(syncTracking, 1500);
  }

  let syncTimer = null, syncing = null, syncAgain = false;
  function syncTracking() {
    if (!S.gh || S.keyProblem) return Promise.resolve();
    if (syncing) { syncAgain = true; return syncing; }
    syncing = doSync().then(
      () => { S.sync = { at: Date.now(), problem: "", pending: false }; },
      e => { S.sync.problem = e.status === 403 ? "readonly" : e.status === 0 ? "offline" : "github"; },
    ).finally(() => {
      syncing = null; renderSyncNote();
      if (syncAgain) { syncAgain = false; syncTracking(); }
    });
    return syncing;
  }
  async function doSync() {
    for (let attempt = 0; attempt < 4; attempt++) {
      let remote = {}, sha = null, found = true;
      try {
        const j = await ghJSON(`/contents/${TRACK_FILE}?ref=${TRACK_BRANCH}`);
        sha = j.sha;
        remote = (JSON.parse(DM.b64decode(j.content)) || {}).items || {};
      } catch (e) { if (e.status !== 404) throw e; found = false; }
      const merged = DM.pruneTombstones(DM.mergeTracking(remote, T), new Date());
      if (DM.stable(merged) !== DM.stable(T)) {
        T = merged; persistTracking(); setTracked(); afterTrackingChange();
        const typing = document.activeElement && document.activeElement.id === "note";
        if (S.sel && !typing) renderPanel();
      }
      if (found && DM.stable(merged) === DM.stable(remote)) return;
      const text = JSON.stringify({ v: 1, about: "The Deal Machine app's tracker. The app edits this file; the newest change to each deal wins.", items: merged }, null, 1);
      try {
        if (found) await gh(`/contents/${TRACK_FILE}`, { method: "PUT", body: { message: "Tracker update [skip ci]", content: DM.b64encode(text), sha, branch: TRACK_BRANCH } });
        else await createTracker(text);
        return;
      } catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }  // another device saved first: merge again
    }
    throw new GHError(409);
  }
  async function createTracker(text) {
    try {
      await gh(`/contents/${TRACK_FILE}`, { method: "PUT", body: { message: "Start the deal tracker [skip ci]", content: DM.b64encode(text), branch: TRACK_BRANCH } });
      return;
    } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
    // no tracker branch yet: give it a first commit of its own
    const tree = await ghJSON("/git/trees", { method: "POST", body: { tree: [{ path: TRACK_FILE, mode: "100644", type: "blob", content: text }] } });
    const commit = await ghJSON("/git/commits", { method: "POST", body: { message: "Start the deal tracker [skip ci]", tree: tree.sha, parents: [] } });
    await ghJSON("/git/refs", { method: "POST", body: { ref: "refs/heads/" + TRACK_BRANCH, sha: commit.sha } });
  }
  function syncLine() {
    if (!S.gh) return "Saved on this device.";
    if (S.sync.problem === "readonly") return "Saved on this device only: your GitHub key can't save the tracker. Make a new key with Contents set to Read and write.";
    if (S.sync.problem) return "Saved on this device. It syncs to your other devices when GitHub is reachable again.";
    if (S.sync.pending) return "Saved on this device. Syncing to your other devices…";
    return S.sync.at ? "Saved and synced to your other devices." : "Saved; your other devices get it within a few minutes.";
  }
  function renderSyncNote() { const n = $("sync-note"); if (n) n.textContent = syncLine(); }

  // ---- filters ------------------------------------------------------------------------------------
  // Pick any number of reasons (match any or all of them), any number of counties, and a few limits.
  // Every choice is remembered on this device; the search box is not.
  const TAG_LABEL = Object.fromEntries(DM.TAGS.map(t => [t.id, t.label]));
  const priceOf = d => d.cost ?? d.offer ?? d.mao ?? null;  // what you'd pay: the county's bid, else our offer
  function saveFilters() { const { q, ...keep } = S.filter; LS.set("filters", keep); }
  const numOrNull = v => { const n = parseFloat(String(v).replace(/[$,\s]/g, "")); return isFinite(n) && n >= 0 ? n : null; };

  function passesBase(d, f) {  // every filter except the reasons
    if (f.countySet.size && !f.countySet.has(d.county)) return false;
    if (f.hidePass && (S.tracked[d.key] || {}).status === "Pass") return false;
    if (f.onlyNew && !isNew(d)) return false;
    if (f.kind && d.p.kind !== f.kind) return false;
    if (f.minScore != null && (d.score || 0) < f.minScore) return false;
    if (f.minTaxYears != null && !(d.taxYears >= f.minTaxYears)) return false;
    if (f.minAcres != null && !(d.acres >= f.minAcres)) return false;
    if (f.maxPrice != null) { const p = priceOf(d); if (p == null || p > f.maxPrice) return false; }
    if (f.q) {
      const hay = (d.situs_address + " " + d.situs_city + " " + d.owner_name + " " + d.owner_name2 + " " + d.parcel_id + " " + d.county).toUpperCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }
  const passesTags = (d, tags, match) => !tags.length || (match === "all" ? tags.every(t => d.tagSet.has(t)) : tags.some(t => d.tagSet.has(t)));
  const withSets = f => ({ ...f, countySet: new Set(f.counties) });

  function filtered() {
    const f = withSets(S.filter);
    let out = S.deals.filter(d => passesBase(d, f) && passesTags(d, f.tags, f.match));
    if (f.sort === "near" && S.spot) {
      out.forEach(d => { d._mi = d.lat != null && d.lon != null ? DM.miles(S.spot.lat, S.spot.lon, d.lat, d.lon) : Infinity; });
      out.sort((a, b) => a._mi - b._mi);
    } else if (f.sort === "bid") {
      out = out.filter(d => d.cost != null).sort((a, b) => a.cost - b.cost);
    } else if (f.sort === "discount") {
      out = out.filter(d => d.cost != null && d.total_value).sort((a, b) => a.cost / a.total_value - b.cost / b.total_value);
    } else if (f.sort === "new") {
      out.sort((a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")) || b.score - a.score);
    } else if (f.sort === "taxes") {
      out.sort((a, b) => (b.taxYears || 0) - (a.taxYears || 0) || (b.taxOwed || 0) - (a.taxOwed || 0) || b.score - a.score);
    }
    return out;
  }
  const isNew = d => !!(S.newCut && (d.first_seen || "").slice(0, 10) === S.newCut);

  // Reason chips, with counts that follow the other filters; the any/all switch shows both totals.
  function renderChips() {
    const f = withSets(S.filter);
    const base = S.deals.filter(d => passesBase(d, f));
    const counts = {};
    base.forEach(d => d.tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const avail = DM.TAGS.filter(t => counts[t.id] || f.tags.includes(t.id));
    const FEW = 8, open = LS.get("allKinds", false);
    const shown = open ? avail : avail.filter((t, i) => i < FEW || f.tags.includes(t.id));
    const hiddenN = avail.length - shown.length;
    $("tag-chips").innerHTML = `<button class="chip" type="button" data-tag="" aria-pressed="${!f.tags.length}">All<span class="c">${base.length.toLocaleString()}</span></button>`
      + shown.map(t => `<button class="chip" type="button" data-tag="${t.id}" aria-pressed="${f.tags.includes(t.id)}">${esc(t.label)}<span class="c">${(counts[t.id] || 0).toLocaleString()}</span></button>`).join("")
      + (hiddenN > 0 ? `<button class="chip more-kinds" type="button" data-kinds="open">+${hiddenN} more</button>` : open && avail.length > FEW ? '<button class="chip more-kinds" type="button" data-kinds="close">Fewer</button>' : "");
    const many = f.tags.length > 1;
    $("match").hidden = !many;
    if (many) {
      const any = base.filter(d => passesTags(d, f.tags, "any")).length, all = base.filter(d => passesTags(d, f.tags, "all")).length;
      $("match").innerHTML = `<span>Show deals with</span><button type="button" class="seg" data-match="any" aria-pressed="${f.match !== "all"}">any of these <b>${any.toLocaleString()}</b></button><button type="button" class="seg" data-match="all" aria-pressed="${f.match === "all"}">all of these <b>${all.toLocaleString()}</b></button>`;
    }
    $("tags-n").textContent = f.tags.length ? `${f.tags.length} picked` : "";
  }

  function renderCountyPick() {
    const f = S.filter, counts = {};
    S.deals.forEach(d => { counts[d.county] = (counts[d.county] || 0) + 1; });
    const q = ($("county-q").value || "").trim().toLowerCase();
    const names = Object.keys(counts).sort().filter(c => !q || c.toLowerCase().includes(q) || f.counties.includes(c));
    $("county-list").innerHTML = names.length ? names.map(c => `<label class="pick-row"><input type="checkbox" value="${esc(c)}"${f.counties.includes(c) ? " checked" : ""}> <span>${esc(c)}</span><small>${counts[c].toLocaleString()}</small></label>`).join("")
      : '<p class="hint">No county by that name in this week\'s deals.</p>';
    $("county-sum").textContent = !f.counties.length ? "All counties" : f.counties.length === 1 ? f.counties[0] : `${f.counties[0]} + ${f.counties.length - 1} more`;
  }

  function filtersActive() {
    const f = S.filter;
    return !!(f.tags.length || f.counties.length || f.q || f.onlyNew || f.kind || f.minScore != null || f.minAcres != null || f.maxPrice != null || f.minTaxYears != null);
  }
  function syncFilterInputs() {
    const f = S.filter;
    $("sort").value = f.sort; $("hide-pass").checked = f.hidePass; $("only-new").checked = f.onlyNew;
    $("kind").value = f.kind || "";
    $("tax-years").value = f.minTaxYears ?? "";
    $("max-price").value = f.maxPrice ?? ""; $("min-acres").value = f.minAcres ?? ""; $("min-score").value = f.minScore ?? "";
    syncMoreCount();
  }
  function filtersChanged() {
    S.shown = 60;
    saveFilters(); syncFilterInputs(); renderChips(); renderCountyPick(); renderList(); drawMap();
  }

  function buildFilterOptions() {
    // keep only reasons and counties this week's deals can match; a remembered pick that can't match is dropped
    const counties = new Set(S.deals.map(d => d.county));
    S.filter.counties = S.filter.counties.filter(c => counties.has(c));
    $("only-new").parentElement.hidden = !S.newCut;
    if (!S.newCut) S.filter.onlyNew = false;
    renderTaxYears(); syncFilterInputs(); renderChips(); renderCountyPick();
  }
  function buildTowns() {
    $("spot-city").innerHTML = '<option value="">Tap the map, or pick a town</option>'
      + TOWNS.slice().sort((a, b) => a[0].localeCompare(b[0])).map(t => `<option value="${esc(t[0])}">${esc(t[0])}</option>`).join("");
    if (S.spot && S.spot.name) $("spot-city").value = S.spot.name;
  }

  $("tag-chips").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.kinds) { LS.set("allKinds", b.dataset.kinds === "open"); renderChips(); return; }
    const t = b.dataset.tag, tags = S.filter.tags;
    S.filter.tags = !t ? [] : tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t];
    filtersChanged();
  });
  $("match").addEventListener("click", e => { const b = e.target.closest("[data-match]"); if (b) { S.filter.match = b.dataset.match; filtersChanged(); } });
  $("county-list").addEventListener("change", e => {
    const c = e.target.value;
    S.filter.counties = e.target.checked ? [...S.filter.counties, c].sort() : S.filter.counties.filter(x => x !== c);
    filtersChanged();
  });
  $("county-q").addEventListener("input", renderCountyPick);
  document.addEventListener("click", e => {  // tap outside the county list to close it
    const pick = $("county-pick");
    if (pick.open && !pick.contains(e.target)) pick.open = false;
  });
  let qTimer;
  $("q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value.trim().toUpperCase(); S.shown = 60; renderChips(); renderList(); drawMap(); updateFilterBar(); }, 150); });
  $("sort").addEventListener("change", e => { S.filter.sort = e.target.value; if (e.target.value === "near" && !S.spot) toast("Set your spot on the Map tab first."); filtersChanged(); });
  $("hide-pass").addEventListener("change", e => { S.filter.hidePass = e.target.checked; filtersChanged(); });
  $("only-new").addEventListener("change", e => { S.filter.onlyNew = e.target.checked; filtersChanged(); });
  $("kind").addEventListener("change", e => { S.filter.kind = e.target.value; filtersChanged(); });
  $("tax-years").addEventListener("change", e => { S.filter.minTaxYears = e.target.value ? +e.target.value : null; filtersChanged(); });
  let nTimer;
  [["max-price", "maxPrice"], ["min-acres", "minAcres"], ["min-score", "minScore"]].forEach(([id, key]) => {
    $(id).addEventListener("input", e => { clearTimeout(nTimer); nTimer = setTimeout(() => { S.filter[key] = numOrNull(e.target.value); S.shown = 60; saveFilters(); renderChips(); renderList(); drawMap(); syncMoreCount(); }, 300); });
  });
  const yearsLabel = y => y >= 3 ? "3+ yrs" : `${y} yr${y > 1 ? "s" : ""}`;
  function renderTaxYears() {
    const levels = [...new Set(S.deals.map(d => Math.min(d.taxYears || 0, 3)).filter(Boolean))].sort();
    const at = y => S.deals.filter(d => d.taxYears >= y).length;
    if (S.filter.minTaxYears != null && !levels.includes(S.filter.minTaxYears)) levels.push(S.filter.minTaxYears);
    $("tax-years").innerHTML = '<option value="">Any</option>' + levels.sort().map(y => `<option value="${y}">${y >= 3 ? "3+ years" : y + "+ year" + (y > 1 ? "s" : "")} behind (${at(y).toLocaleString()})</option>`).join("");
    $("tax-years").value = S.filter.minTaxYears ?? "";
  }
  function syncMoreCount() {
    const f = S.filter, extra = [f.kind, f.maxPrice, f.minAcres, f.minScore, f.minTaxYears].filter(v => v != null && v !== "").length;
    $("more-n").textContent = extra ? ` (${extra} on)` : "";
  }
  function clearFilters() {
    const keep = { sort: S.filter.sort, hidePass: S.filter.hidePass };
    S.filter = { ...FILTER_DEFAULTS, ...keep, tags: [], counties: [] };
    $("q").value = ""; $("county-q").value = "";
    filtersChanged();
  }
  function updateFilterBar() { $("clear-filters").hidden = !filtersActive(); }
  $("more").addEventListener("click", () => { S.shown += 60; renderList(); });

  // ---- export: the whole filtered list, in the order you see it ----------------------------------------
  function exportColumns() {
    const t = k => d => (S.tracked[d.key] || {})[k] || null;
    const cols = [
      ["Score", "dec1", 7, d => d.score], ["Kind of deal", "text", 26, d => d.p.label + (d.p.kind ? ` (${d.p.kind})` : "")],
      ["Reasons", "text", 40, d => d.tags.map(x => TAG_LABEL[x]).join(", ")],
      ["Years behind on taxes (at least)", "num", 12, d => d.taxYears], ["Taxes owed", "money", 11, d => d.taxOwed],
      ["Tracker status", "text", 14, t("status")], ["Tracker notes", "text", 30, t("note")],
      ["County", "text", 12, d => d.county], ["Parcel", "text", 24, d => d.parcel_id],
      ["Property address", "text", 30, d => d.situs_address], ["Property city", "text", 16, d => d.situs_city],
      ["Owner", "text", 32, d => d.owner_name], ["Owner 2", "text", 24, d => d.owner_name2],
      ["Mailing address", "text", 30, d => d.mail_address], ["Mailing city", "text", 18, d => d.mail_city],
      ["State", "text", 6, d => d.mail_state], ["ZIP", "text", 8, d => d.mail_zip == null ? null : String(d.mail_zip).replace(/-0000$/, "")],
      ["County bid", "money", 12, d => d.cost], ["Opening offer", "money", 13, d => d.offer], ["Max offer (70% rule)", "money", 13, d => d.mao],
      ["After-repair value", "money", 13, d => d.arv], ["Repairs (est.)", "money", 12, d => d.repairs],
      ["Assessed value", "money", 13, d => d.total_value], ["Land value", "money", 12, d => d.land_value],
      ["Acres", "dec2", 8, d => d.acres], ["Living sq ft", "int", 10, d => d.building_sqft], ["Year built", "num", 9, d => d.year_built],
      ["Condition", "text", 10, d => d.condition], ["Land use", "text", 20, d => d.land_use],
      ["Why it's on the list", "text", 70, d => d.why], ["First seen", "text", 11, d => (d.first_seen || "").slice(0, 10) || null],
    ];
    if (S.spot) cols.push(["Miles from my spot", "dec1", 10, d => d.lat != null && d.lon != null ? Math.round(DM.miles(S.spot.lat, S.spot.lon, d.lat, d.lon) * 10) / 10 : null]);
    cols.push(["Latitude", "num", 10, d => d.lat], ["Longitude", "num", 11, d => d.lon],
      ["Directions", "link", 12, d => d.lat != null && d.lon != null ? `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}` : null, "Directions"],
      ["County record", "link", 14, d => safeUrl(d.assessor_url) || null, "County record"]);
    return cols.map(([name, type, width, get, label]) => ({ name, type, width, get, label }));
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function exportList(format, btn) {
    const list = filtered();
    if (!list.length) { toast("No deals match these filters, so there's nothing to export."); return; }
    const cols = exportColumns(), rows = list.map(d => cols.map(c => c.get(d)));
    const run = (S.meta && S.meta.runDate) || new Date().toISOString().slice(0, 10);
    const name = `deal-machine-${run}-${list.length}-deals`;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Making it…";
    try {
      if (format === "csv") saveBlob(new Blob([DM.csv(cols, rows)], { type: "text/csv" }), name + ".csv");
      else saveBlob(new Blob([await DM.xlsx("Deals", cols, rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name + ".xlsx");
      toast(`Saved ${list.length.toLocaleString()} deals. Open the file in Excel, Google Sheets or Numbers.`);
    } catch (e) {
      toast("Couldn't make the spreadsheet. Try the CSV button instead.");
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---- rendering: list -----------------------------------------------------------------------------
  function headline(d) {
    if (d.cost != null) return [money(d.cost), "bid"];
    if (d.offer != null) return [money(d.offer), "offer"];
    if (d.mao != null) return [money(d.mao), "max offer"];
    if (d.total_value != null) return [money(d.total_value), "assessed"];
    return ["", ""];
  }
  function scoreClass(s) { return s >= 80 ? "hi" : s >= 60 ? "mid" : ""; }
  function card(d) {
    const [m, ml] = headline(d);
    const t = S.tracked[d.key];
    const st = t && t.status ? `<span class="tag st${t.status === "Pass" ? " pass" : t.status === "Bought" || t.status === "Under contract" ? " won" : ""}">${esc(t.status)}</span>` : "";
    const dist = S.filter.sort === "near" && S.spot && isFinite(d._mi) ? `<span class="tag">${d._mi < 10 ? d._mi.toFixed(1) : Math.round(d._mi)} mi</span>` : "";
    const yrs = d.taxYears ? `<span class="tag tax${d.taxYears >= 3 ? " deep" : ""}">${yearsLabel(d.taxYears)} behind on taxes</span>` : "";
    const where = [title(d.situs_city), d.county + " County"].filter(Boolean).join(" · ");
    return `<button class="deal${S.sel === d.key ? " sel" : ""}" type="button" data-key="${esc(d.key)}">
      <span class="score ${scoreClass(d.score)}">${Math.round(d.score || 0)}</span>
      <span class="dbody">
        <span class="play g-${d.p.g}">${esc(d.p.label)}${d.p.kind ? " · " + d.p.kind : ""}</span>
        <span class="addr">${esc(title(d.situs_address) || "Parcel " + d.parcel_id)}</span>
        <span class="where">${esc(where)}</span>
        <span class="why">${esc((d.why || "").split(" · ").slice(0, 2).join(" · "))}</span>
        ${st || dist || yrs || isNew(d) || S.sample ? `<span class="tags">${S.sample ? '<span class="tag sample">Sample</span>' : ""}${isNew(d) ? '<span class="tag new">New this week</span>' : ""}${yrs}${st}${dist}</span>` : ""}
      </span>
      <span class="money">${m ? `<b>${m}</b><small>${ml}</small>` : ""}</span>
    </button>`;
  }
  function renderList() {
    if (!S.deals.length) return;
    const list = filtered();
    $("count-line").textContent = list.length === S.deals.length ? `${list.length.toLocaleString()} deals` : `${list.length.toLocaleString()} of ${S.deals.length.toLocaleString()} deals match`;
    updateFilterBar();
    $("deal-list").innerHTML = list.length ? list.slice(0, S.shown).map(card).join("")
      : '<div class="panel-empty">No deals match. Clear the search or pick "All".</div>';
    $("more").hidden = list.length <= S.shown;
    $("more").textContent = `Show more (${(list.length - S.shown).toLocaleString()} left)`;
  }
  $("deal-list").addEventListener("click", e => { const b = e.target.closest(".deal"); if (b) select(b.dataset.key); });

  // ---- rendering: detail panel ---------------------------------------------------------------------
  function select(key) {
    S.sel = key;
    renderPanel();
    document.querySelectorAll(".deal.sel").forEach(x => x.classList.remove("sel"));
    const el = document.querySelector(`.deal[data-key="${CSS.escape(key)}"]`);
    if (el) el.classList.add("sel");
    const panel = $("panel");
    panel.scrollTop = 0;
    if (window.matchMedia("(max-width: 999px)").matches) { panel.hidden = false; panel.focus({ preventScroll: true }); }
    drawMap();
  }
  function closePanel() { S.sel = null; renderPanel(); document.querySelectorAll(".deal.sel").forEach(x => x.classList.remove("sel")); drawMap(); }

  function kv(label, value) { return value == null || value === "" || value === "—" ? "" : `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
  function renderPanel() {
    const panel = $("panel");
    if (S.view === "help") { panel.hidden = true; return; }
    const phone = window.matchMedia("(max-width: 999px)").matches;
    const d = S.sel ? S.byKey.get(S.sel) : null;
    const t = S.sel ? S.tracked[S.sel] : null;
    if (!d && !t) {
      panel.hidden = phone;
      panel.innerHTML = `<div class="panel-empty">${S.deals.length ? "Pick a deal to see the owner, the numbers and what to do next." : "Your deals will open here."}</div>`;
      return;
    }
    panel.hidden = false;
    if (!d) { // tracked deal that isn't in this week's list
      panel.innerHTML = `<div class="p-head"><div><span class="play g-watch">Not in this week's list</span><h2>${esc(title(t.address) || "Parcel " + t.parcel_id)}</h2><div class="where">${esc([title(t.city), t.county + " County"].filter(Boolean).join(" · "))}</div></div><button class="close" type="button" data-close aria-label="Close">×</button></div>
        <div class="p-body">${trackSection(t.key)}</div>`;
      wirePanel(t.key);
      return;
    }
    const p = d.p;
    const where = [title(d.situs_city), d.county + " County"].filter(Boolean).join(" · ");
    const owner = [d.owner_name, d.owner_name2].filter(Boolean).map(title).join(" & ");
    const mail = [title(d.mail_address), [title(d.mail_city), d.mail_state, String(d.mail_zip || "").replace(/-0000$/, "")].filter(Boolean).join(" ")].filter(Boolean);
    const mapUrl = d.lat != null && d.lon != null ? `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}` : d.map_url;
    const discount = d.cost != null && d.total_value ? Math.round(100 * d.cost / d.total_value) + "% of assessed value" : null;
    panel.innerHTML = `
      <div class="p-head">
        <div><span class="play g-${p.g}">${esc(p.label)}${p.kind ? " · " + p.kind : ""} · score ${Math.round(d.score)}</span>
          <h2>${esc(title(d.situs_address) || "Parcel " + d.parcel_id)}</h2>
          <div class="where">${esc(where)}</div></div>
        <button class="close${phone ? "" : " phone-only"}" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="p-body">
        ${S.sample ? '<div class="banner"><span><b>Sample deal.</b> Invented for the demo. Connect your GitHub project to see real ones.</span></div>' : ""}
        <div class="todo"><b>${esc(p.todo[0])}</b>${esc(p.todo[1])}</div>
        <div class="p-sec"><h3>The numbers</h3><div class="kv">
          ${kv("Behind on taxes", d.taxYears ? (d.taxYears >= 3 ? "3+ years" : d.taxYears + (d.taxYears > 1 ? " years" : " year")) : null)}${kv("Taxes owed", d.taxOwed != null ? money(d.taxOwed) : null)}
          ${kv("County bid", d.cost != null ? money(d.cost) : null)}${kv("Bid vs value", discount)}
          ${kv("Opening offer", d.offer != null ? money(d.offer) : null)}${kv("After-repair value", d.arv != null ? money(d.arv) : null)}
          ${kv("Repairs (est.)", d.repairs != null ? money(d.repairs) : null)}${kv("Max offer (70% rule)", d.mao != null ? money(d.mao) : null)}
          ${kv("Assessed value", d.total_value != null ? money(d.total_value) : null)}${kv("Land value", d.land_value != null ? money(d.land_value) : null)}
          ${kv("Acres", d.acres != null ? (+d.acres).toFixed(2) : null)}${kv("Living sq ft", d.building_sqft != null ? Math.round(d.building_sqft).toLocaleString() : null)}
          ${kv("Built", d.year_built || null)}${kv("Condition", title(d.condition))}
          ${kv("Land use", title(d.land_use))}${kv("Parcel", d.parcel_id)}
        </div>${d.arv_basis ? `<p class="hint">Value based on ${esc(d.arv_basis)}.</p>` : ""}</div>
        <div class="p-sec"><h3>Why it's on the list</h3><ul class="reasons">${(d.why || "").split(" · ").filter(Boolean).map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>
        ${owner || mail.length ? `<div class="p-sec"><h3>Owner</h3><div class="owner-box"><b>${esc(owner || "Owner not listed")}</b>${mail.map(l => `<span>${esc(l)}</span>`).join("")}</div>
          ${mail.length ? '<div class="links"><button class="btn small" type="button" data-copy-mail>Copy mailing address</button></div>' : ""}</div>` : ""}
        <div class="p-sec"><h3>Look it up</h3><div class="links">
          ${safeUrl(d.assessor_url) ? `<a class="btn small" href="${esc(safeUrl(d.assessor_url))}" target="_blank" rel="noopener">County record ↗</a>` : ""}
          ${mapUrl ? `<a class="btn small" href="${esc(mapUrl)}" target="_blank" rel="noopener">Directions ↗</a>` : ""}
          <button class="btn small" type="button" data-copy-parcel>Copy parcel number</button>
        </div></div>
        ${trackSection(d.key)}
      </div>`;
    wirePanel(d.key, d, owner, mail);
  }
  function trackSection(key) {
    const t = S.tracked[key] || {};
    return `<div class="p-sec"><h3>Track it</h3>
      <div class="statuses" role="group" aria-label="Where this deal stands">${STATUSES.map(s => `<button class="status-btn" type="button" data-status="${esc(s)}" aria-pressed="${t.status === s}">${esc(s)}</button>`).join("")}</div>
      <label class="field"><span>Notes</span><textarea id="note" placeholder="Who you talked to, what they want, next step">${esc(t.note || "")}</textarea></label>
      <div class="saved" id="saved">${t.updatedAt ? "Last change " + new Date(t.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + "." : ""}</div>
      <div class="saved" id="sync-note">${esc(syncLine())}</div></div>`;
  }
  function copyText(text, btn) {
    const done = m => { const old = btn.textContent; btn.textContent = m; setTimeout(() => { btn.textContent = old; }, 1500); };
    try { navigator.clipboard.writeText(text).then(() => done("Copied"), () => done("Select and copy it above")); } catch (e) { done("Select and copy it above"); }
  }
  function wirePanel(key, d, owner, mail) {
    const panel = $("panel");
    panel.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closePanel));
    panel.querySelectorAll("[data-status]").forEach(b => b.addEventListener("click", () => {
      const cur = (S.tracked[key] || {}).status;
      const status = cur === b.dataset.status ? null : b.dataset.status;
      writeTrack(key, { status });
      panel.querySelectorAll("[data-status]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.status === status)));
      $("saved").textContent = status ? `Marked "${status}".` : "Status cleared.";
    }));
    const note = $("note");
    let nTimer;
    const saveNote = () => { clearTimeout(nTimer); const v = note.value; if ((S.tracked[key] || {}).note === v || (!S.tracked[key] && !v)) return; writeTrack(key, { note: v }); $("saved").textContent = "Note saved."; };
    note.addEventListener("input", () => { clearTimeout(nTimer); nTimer = setTimeout(saveNote, 900); });
    note.addEventListener("blur", saveNote);
    const cm = panel.querySelector("[data-copy-mail]");
    if (cm) cm.addEventListener("click", () => copyText([owner, ...mail].filter(Boolean).join("\n"), cm));
    const cp = panel.querySelector("[data-copy-parcel]");
    if (cp && d) cp.addEventListener("click", () => copyText(d.parcel_id, cp));
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("county-pick").open) { $("county-pick").open = false; return; }
    if (S.sel && $("pw-modal").hidden) closePanel();
  });

  // ---- tracked view --------------------------------------------------------------------------------
  function renderTrackedCount() { const n = Object.keys(S.tracked).length; $("tracked-n").textContent = n ? String(n) : ""; }
  function renderTracked() {
    const all = Object.values(S.tracked);
    if (!all.length) {
      $("pipe").innerHTML = '<div class="welcome"><h2>Nothing tracked yet</h2><p>Open any deal and tap Mailed, Called, Under contract or another step. It shows up here, grouped by where it stands, so you always know who to follow up with.</p></div>';
      return;
    }
    $("pipe").innerHTML = STATUSES.concat([""]).map(s => {
      const rows = all.filter(t => (t.status || "") === s).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (!rows.length) return "";
      return `<div class="pipe-group"><h3>${esc(s || "Notes only")} <span>${rows.length}</span></h3>${rows.map(t => `
        <button class="pipe-row" type="button" data-key="${esc(t.key)}"><span><b>${esc(title(t.address) || "Parcel " + t.parcel_id)}</b><br><small>${esc([title(t.city), t.county + " County", t.play && playOf({ deal_type: t.play }).label].filter(Boolean).join(" · "))}${t.note ? " · " + esc(t.note.slice(0, 80)) : ""}</small></span>
        <small>${t.updatedAt ? new Date(t.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</small></button>`).join("")}</div>`;
    }).join("");
  }
  $("pipe").addEventListener("click", e => { const b = e.target.closest(".pipe-row"); if (b) select(b.dataset.key); });

  // ---- map -----------------------------------------------------------------------------------------
  const OK_OUTLINE = [[-103.002, 37.0], [-94.618, 37.0], [-94.431, 35.397], [-94.485, 33.637], [-94.75, 33.68], [-95.05, 33.86], [-95.3, 33.88], [-95.6, 33.94], [-95.85, 33.86], [-96.15, 33.84], [-96.45, 33.78], [-96.62, 33.85], [-96.88, 33.95], [-97.15, 33.74], [-97.4, 33.82], [-97.6, 33.87], [-97.95, 33.89], [-98.1, 34.13], [-98.35, 34.14], [-98.6, 34.16], [-98.95, 34.21], [-99.2, 34.33], [-99.45, 34.38], [-99.7, 34.38], [-100.0, 34.56], [-100.0, 36.5], [-103.002, 36.5]];
  const TOWNS = [["Oklahoma City", 35.468, -97.516], ["Tulsa", 36.154, -95.993], ["Norman", 35.222, -97.439], ["Broken Arrow", 36.053, -95.791], ["Edmond", 35.653, -97.478], ["Lawton", 34.604, -98.395], ["Moore", 35.339, -97.487], ["Midwest City", 35.449, -97.397], ["Enid", 36.396, -97.878], ["Stillwater", 36.116, -97.058], ["Owasso", 36.27, -95.855], ["Muskogee", 35.748, -95.37], ["Shawnee", 35.327, -96.925], ["Bartlesville", 36.747, -95.981], ["Ardmore", 34.174, -97.144], ["Ponca City", 36.707, -97.085], ["Sapulpa", 35.999, -96.114], ["Duncan", 34.502, -97.958], ["Yukon", 35.507, -97.762], ["Claremore", 36.313, -95.616], ["Durant", 33.994, -96.371], ["McAlester", 34.933, -95.77], ["Tahlequah", 35.915, -94.97], ["Chickasha", 35.053, -97.936], ["Ada", 34.775, -96.679], ["El Reno", 35.532, -97.955], ["Elk City", 35.412, -99.404], ["Woodward", 36.434, -99.39], ["Guymon", 36.683, -101.481], ["Altus", 34.638, -99.334], ["Okmulgee", 35.623, -95.961], ["Grove", 36.594, -94.769], ["Poteau", 35.054, -94.623], ["Idabel", 33.896, -94.826], ["Pawhuska", 36.668, -96.337]];
  const MAPLABELS = ["Oklahoma City", "Tulsa", "Lawton", "Enid", "Muskogee", "Ardmore", "McAlester", "Woodward", "Guymon", "Elk City", "Durant", "Stillwater"];
  const view = { z: 1, cx: -98.7, cy: 35.3 };
  const KX = Math.cos(35.3 * Math.PI / 180);
  let mapDots = [];
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
  function mapSize() {
    const c = $("map"); const w = c.parentElement.clientWidth || 600;
    const h = Math.max(260, Math.min(560, Math.round(w / 2.05)));
    return { w, h };
  }
  function proj(lon, lat, w, h) {
    const base = Math.min(w / (8.9 * KX), h / 3.75);
    const s = base * view.z;
    return [w / 2 + (lon - view.cx) * KX * s, h / 2 - (lat - view.cy) * s, s];
  }
  function unproj(x, y, w, h) {
    const base = Math.min(w / (8.9 * KX), h / 3.75), s = base * view.z;
    return [view.cx + (x - w / 2) / (KX * s), view.cy - (y - h / 2) / s];
  }
  function drawMap() {
    if (S.view !== "map") return;
    const c = $("map"), { w, h } = mapSize(), dpr = window.devicePixelRatio || 1;
    c.style.height = h + "px"; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = token("--surface"); g.fillRect(0, 0, w, h);
    g.beginPath(); OK_OUTLINE.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat, w, h); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath();
    g.fillStyle = token("--map-land"); g.fill(); g.lineWidth = 1.5; g.strokeStyle = token("--map-edge"); g.stroke();
    const list = S.deals.length ? filtered() : [];
    mapDots = [];
    const order = { watch: 0, owner: 1, bank: 2, auction: 3, buy: 4 };
    const pts = list.filter(d => d.lat != null && d.lon != null).sort((a, b) => order[a.p.g] - order[b.p.g]);
    const colors = {}; Object.entries(GROUP_COLOR).forEach(([k, v]) => { colors[k] = token(v); });
    const r = Math.max(2.2, Math.min(6, 2 + view.z * 0.7));
    pts.forEach(d => {
      const [x, y] = proj(d.lon, d.lat, w, h);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) return;
      g.beginPath(); g.arc(x, y, d.p.g === "buy" || d.p.g === "auction" ? r + 1 : r, 0, 6.283);
      g.fillStyle = colors[d.p.g]; g.globalAlpha = d.p.g === "owner" || d.p.g === "watch" ? 0.55 : 0.95; g.fill(); g.globalAlpha = 1;
      mapDots.push([x, y, d.key]);
    });
    g.font = "600 12px " + token("--body"); g.textAlign = "left"; g.textBaseline = "middle";
    TOWNS.filter(t => MAPLABELS.includes(t[0]) || view.z >= 3).forEach(([name, lat, lon]) => {
      const [x, y] = proj(lon, lat, w, h);
      if (x < 0 || y < 0 || x > w || y > h) return;
      g.fillStyle = token("--map-label"); g.fillText(name, x + 5, y - 7);
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    });
    if (S.sel && S.byKey.get(S.sel)) {
      const d = S.byKey.get(S.sel);
      if (d.lat != null) { const [x, y] = proj(d.lon, d.lat, w, h); g.beginPath(); g.arc(x, y, r + 6, 0, 6.283); g.lineWidth = 2.5; g.strokeStyle = token("--ink"); g.stroke(); }
    }
    if (S.spot) {
      const [x, y] = proj(S.spot.lon, S.spot.lat, w, h);
      g.beginPath(); g.arc(x, y, 8, 0, 6.283); g.fillStyle = token("--stamp"); g.fill();
      g.lineWidth = 3; g.strokeStyle = token("--surface"); g.stroke();
      g.fillStyle = token("--ink"); g.font = "700 12px " + token("--body"); g.fillText("My spot", x + 12, y);
    }
    $("legend").innerHTML = [["buy", "Buy now"], ["auction", "Tax auction"], ["owner", "Mail the owner"], ["bank", "Bank / public"], ["watch", "Watchlist"]]
      .map(([k, l]) => `<span><i style="background:var(${GROUP_COLOR[k]})"></i>${l}</span>`).join("") + `<span>${pts.length.toLocaleString()} on the map</span>`;
  }
  let spotMode = false, drag = null;
  const mapEl = $("map");
  mapEl.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }; mapEl.setPointerCapture(e.pointerId); });
  mapEl.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const { w, h } = mapSize(); const s = Math.min(w / (8.9 * KX), h / 3.75) * view.z;
    view.cx = drag.cx - dx / (KX * s); view.cy = drag.cy + dy / s; drawMap();
  });
  mapEl.addEventListener("pointerup", e => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    const rect = mapEl.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (spotMode) {
      const { w, h } = mapSize(); const [lon, lat] = unproj(x, y, w, h);
      setSpot({ lat, lon, name: "" }); spotMode = false; $("spot-mode").setAttribute("aria-pressed", "false"); $("spot-mode").textContent = "Tap map to set my spot";
      return;
    }
    let best = null, bd = 16 * 16;
    mapDots.forEach(([px, py, k]) => { const dd = (px - x) ** 2 + (py - y) ** 2; if (dd < bd) { bd = dd; best = k; } });
    if (best) select(best);
  });
  mapEl.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.4 : 1 / 1.4); }, { passive: false });
  function zoomAt(f) { view.z = Math.max(1, Math.min(40, view.z * f)); if (view.z === 1) { view.cx = -98.7; view.cy = 35.3; } drawMap(); }
  $("zoom-in").addEventListener("click", () => zoomAt(1.6));
  $("zoom-out").addEventListener("click", () => zoomAt(1 / 1.6));
  $("zoom-reset").addEventListener("click", () => { view.z = 1; view.cx = -98.7; view.cy = 35.3; drawMap(); });
  $("spot-mode").addEventListener("click", () => { spotMode = !spotMode; $("spot-mode").setAttribute("aria-pressed", String(spotMode)); $("spot-mode").textContent = spotMode ? "Now tap the map…" : "Tap map to set my spot"; });
  $("spot-city").addEventListener("change", e => { const t = TOWNS.find(x => x[0] === e.target.value); setSpot(t ? { name: t[0], lat: t[1], lon: t[2] } : null); });
  $("spot-clear").addEventListener("click", () => setSpot(null));
  function setSpot(spot) {
    S.spot = spot; LS.set("spot", spot);
    $("spot-clear").hidden = !spot;
    $("spot-city").value = spot && spot.name ? spot.name : "";
    if (spot) { S.filter.sort = "near"; $("sort").value = "near"; view.cx = spot.lon; view.cy = spot.lat; view.z = Math.max(view.z, 4); toast(`Spot set${spot.name ? " to " + spot.name : ""}. Deals now sort by distance.`); }
    else if (S.filter.sort === "near") { S.filter.sort = "score"; $("sort").value = "score"; }
    renderList(); drawMap();
  }
  window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { drawMap(); renderPanel(); }, 150); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", drawMap);

  // ---- help ----------------------------------------------------------------------------------------
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function mondayHTML() {
    if (!S.gh) return `<div><h2>Get connected first</h2><p>Connect this device to your private GitHub project on the Deals tab. It takes about two minutes, once per device.</p></div>`;
    return `<div><h2>Every Monday: nothing to do</h2>
      <p>The robot runs early every Monday (about 6:15 am Central) and takes about ${RUN_MINUTES} minutes. Open the app after that and the new deals are already here, on every device you've connected.</p>
      <div style="margin-top:10px">${runControlsHTML(false)}</div>
      ${weekFilesHTML(false) ? `<p style="margin-top:12px">This week's letters to print, or the mailing list for a mail house:</p>${weekFilesHTML(false)}` : ""}</div>`;
  }
  function installHTML() {
    if (standalone()) return "";
    return `<div><h2>Put it on your home screen or taskbar</h2><ul>
      ${S.installEvt ? '<li><button class="btn small primary" type="button" data-act="install">Install the app</button></li>' : ""}
      <li><b>Android phone (Chrome):</b> tap <b>⋮</b> at the top right, then <b>Add to Home screen</b> (or <b>Install app</b>).</li>
      <li><b>Computer (Chrome or Edge):</b> click the install icon at the right end of the address bar, or <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b>. Then right-click its taskbar icon → <b>Pin to taskbar</b>.</li>
      <li><b>iPhone (Safari):</b> tap <b>Share</b>, then <b>Add to Home Screen</b>.</li>
    </ul></div>`;
  }
  function renderHelp() {
    const cal = DM.taxCalendar(new Date()).map(e => `<tr><td>${e.when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</td><td>${esc(e.name)}<br><small style="color:var(--muted)">${esc(e.play)}</small></td><td class="mono" style="color:var(--muted)">${esc(e.law)}</td></tr>`).join("");
    const repo = S.gh ? S.gh.repo : DEFAULT_REPO;
    $("help").innerHTML = `
      ${mondayHTML()}
      ${installHTML()}
      <div><h2>Using the deals</h2><ul>
        <li><b>Buy now from the county</b> deals are the best: the county owns them. Call that county's treasurer and ask how to bid.</li>
        <li><b>Behind on taxes, Heirs, Absentee, Neglected, Storm damage</b>: the owner might sell. Mail them a letter (<b>Letters to print</b> on the Deals tab), then track it here.</li>
        <li><b>Filters:</b> tap as many kinds as you like (say <b>Heirs / estate</b> and <b>Behind on taxes</b>), then choose <b>any of these</b> or <b>all of these</b>. Pick several counties the same way. <b>More filters</b> adds how many years behind on taxes, a price limit, acres, score and land or houses. "3+ years" means the property is on a June tax resale list, which Oklahoma law reserves for about 3 years of unpaid taxes; Oklahoma County's lien-sale notice only shows the latest unpaid year, so those read "1 year".</li>
        <li><b>Export to spreadsheet</b> saves every deal that matches your filters (not just the ones on screen) as an Excel file, with owners, mailing addresses, the numbers and your tracker notes. <b>CSV</b> is the same list for mail-merge tools.</li>
        <li>On the <b>Map</b> tab, set your spot, then "Nearest to my spot" lists what's close while you drive around. <b>Directions</b> opens Google Maps.</li>
        <li>Tap a status on any deal (Mailed, Called, Under contract…). The <b>Tracked</b> tab keeps your follow-ups in one place on all your devices.</li>
      </ul></div>
      <div><h2>One-time setup (if you haven't)</h2><ol>
        <li>Keep the GitHub project private (<a href="https://github.com/${esc(repo)}/settings" target="_blank" rel="noopener">Settings ↗</a>, Danger Zone). The robot only hands over deals while it is.</li>
        <li>Put your name and phone on the letters: <a href="https://github.com/${esc(repo)}/edit/${esc((S.gh && S.gh.branch) || "main")}/config/outreach.yaml" target="_blank" rel="noopener">edit outreach.yaml ↗</a>.</li>
        <li>Install the <a href="https://github.com/mobile" target="_blank" rel="noopener">GitHub app ↗</a> and turn on notifications: your phone buzzes when a county posts a new sale list.</li>
      </ol></div>
      <div><h2>Rules so you don't get hurt</h2><ul>
        <li>Letters, not robot texts or robo-calls. Oklahoma fines $500 to $1,500 per automated message sent without permission.</li>
        <li>Look before you pay: check the county record, drive by, and ask a title company. Tax-sale property often needs a quiet-title action before you can resell it.</li>
        <li>Selling your contract to someone else in public (wholesaling) needs a real estate license in Oklahoma.</li>
      </ul></div>
      <div><h2>Oklahoma's tax-sale year</h2><div class="tbl-wrap"><table class="cal"><tbody>${cal}</tbody></table></div></div>
      <div><h2>Your data and your key</h2>
        <p>Your deals and your tracker live in your private GitHub project. This device keeps your GitHub key and a copy of this week's deals, so the app opens fast and works without signal. The tracker syncs through your project, so your phone and computer see the same thing.</p>
        ${S.gh ? `<p style="margin-top:8px">Connected to <b>${esc(S.gh.repo)}</b>. ${esc(syncLine())}</p>
        <div class="row" style="margin-top:10px"><button class="btn small" type="button" data-act="disconnect">Disconnect this device</button><a class="btn small" href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Manage keys on GitHub ↗</a></div>` : ""}
        <div class="row" style="margin-top:10px"><button class="btn small" type="button" data-act="load-file">Open a weekly download file instead</button></div>
      </div>`;
  }

  // ---- views ---------------------------------------------------------------------------------------
  function showView(v) {
    S.view = v;
    ["deals", "map", "tracked", "help"].forEach(n => { $("view-" + n).hidden = n !== v; $("tab-" + n).setAttribute("aria-selected", String(n === v)); });
    $("layout").classList.toggle("with-panel", v === "deals" || v === "map" || v === "tracked");
    if (v === "help") $("panel").hidden = true; else renderPanel();
    if (v === "map") drawMap();
    if (v === "tracked") renderTracked();
    if (v === "help") renderHelp();
    LS.set("view", v);
  }
  document.querySelector(".tabs").addEventListener("click", e => { const b = e.target.closest(".tab"); if (b) showView(b.dataset.view); });

  function connectHTML() {
    const repo = (S.gh && S.gh.repo) || DEFAULT_REPO;
    const again = S.keyProblem ? '<div class="banner"><span><b>Your GitHub key stopped working.</b> Keys last a year, or it was deleted on GitHub. Make a new one below; your deals and tracker are safe.</span></div>' : "";
    const second = S.deals.length && !S.sample ? '<button class="btn" type="button" data-act="connect-cancel">Not now</button>' : '<button class="btn" type="button" data-act="sample">Try it with sample deals</button>';
    return `<div class="welcome connect">
      ${again}
      <h2>Connect your Deal Machine</h2>
      <p>The app reads your deals straight from your private GitHub project, using a key from GitHub. The key stays on this device. You do this once on each phone or computer.</p>
      <ol>
        <li><b>Make a key.</b> This opens GitHub with the name, the permissions and a one-year life already filled in.<br><a class="btn" id="key-link" href="${esc(keyUrl(repo))}" target="_blank" rel="noopener">Make a key on GitHub ↗</a></li>
        <li>Under <b>Repository access</b>, pick <b>Only select repositories</b>, then <b>${esc(repo.split("/")[1])}</b>.</li>
        <li>Check that <b>Permissions</b> shows <b>Actions</b> and <b>Contents</b> as <b>Read and write</b>. Click <b>Generate token</b>, then copy it.</li>
        <li>Paste it here.</li>
      </ol>
      <form id="connect-form" autocomplete="off" novalidate>
        <label class="field"><span>Your key</span><input id="key" type="password" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
        <details><summary>A different GitHub project?</summary><label class="field"><span>GitHub project</span><input id="repo" value="${esc(repo)}" spellcheck="false" autocapitalize="off"></label></details>
        <p class="err" id="connect-err" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit" id="connect-go">Connect</button>${second}</div>
      </form>
      <p class="hint">Using the same key on your phone and your computer is fine. GitHub shows a key only once, so keep it in your password manager, or make a second key for the other device.</p>
    </div>`;
  }
  function wireConnect() {
    const f = $("connect-form");
    if (!f) return;
    $("repo").addEventListener("input", e => { $("key-link").href = keyUrl(e.target.value.trim() || DEFAULT_REPO); });
    f.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = $("connect-go");
      btn.disabled = true; btn.innerHTML = '<span class="busy" aria-hidden="true"></span> Connecting…';
      $("connect-err").textContent = "";
      const err = await connect($("key").value, $("repo").value);
      if (err && $("connect-err")) { $("connect-err").textContent = err; btn.disabled = false; btn.textContent = "Connect"; }
    });
  }

  function renderEmpty() {
    const el = $("deals-empty");
    if (!S.gh || S.showConnect || (S.keyProblem && !S.deals.length)) { el.innerHTML = connectHTML(); wireConnect(); return; }
    if (S.loading) {
      el.innerHTML = '<div class="welcome"><h2><span class="busy" aria-hidden="true"></span> Getting this week\'s deals…</h2><p>A few seconds on Wi-Fi, a little longer on a phone connection. After this they stay on this device.</p></div>';
      return;
    }
    const msg = {
      nodata: ["No deals published yet", "The robot puts the deals in your project every Monday while the project is private. Start it now and they show up here in about " + RUN_MINUTES + " minutes."],
      offline: ["Can't reach GitHub", "Check your internet connection. Once deals load, they stay on this device for when you're offline."],
      github: ["GitHub had a hiccup", "Try again in a minute."],
    }[S.loadError] || ["No deals yet", "Tap Try again to check your GitHub project."];
    el.innerHTML = `<div class="welcome">
      <h2>${esc(msg[0])}</h2><p>${esc(msg[1])}</p>
      <div class="row"><button class="btn primary" type="button" data-act="refresh">Try again</button>${runControlsHTML(false)}<button class="btn" type="button" data-act="sample">Try it with sample deals</button></div>
    </div>`;
  }

  function renderBanner() {
    let html = "";
    if (S.sample) {
      html = `<div class="banner" style="margin-bottom:14px"><span><b>Sample deals.</b> These are invented to show how the app works.</span>${S.gh ? "" : '<button class="btn small" type="button" data-act="connect">Connect my project</button>'}<button class="btn small" type="button" data-act="clear-sample">Clear samples</button></div>`;
    } else if (S.keyProblem && S.deals.length && !S.showConnect) {
      html = '<div class="banner" style="margin-bottom:14px"><span><b>Your GitHub key stopped working.</b> These are the last deals this device saw.</span><button class="btn small" type="button" data-act="connect">Connect again</button></div>';
    }
    $("banner-slot").innerHTML = html;
  }

  function renderAll() {
    const has = S.deals.length > 0 && !S.showConnect;
    $("deals-empty").hidden = has; $("deals-ui").hidden = !has;
    if (!has) renderEmpty();
    renderBanner(); renderRun(); updateStatus(); renderList(); renderPanel(); renderTrackedCount();
    if (S.view === "map") drawMap();
    if (S.view === "help") renderHelp();
    $("load-btn").hidden = !S.gh || S.keyProblem || S.showConnect;
    $("weekbar-slot").innerHTML = has && !S.sample ? weekFilesHTML() : "";
  }

  // One handler for every button the views draw.
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "sample") { S.showConnect = false; setDeals(SAMPLE.map(x => ({ ...x })), { loadedAt: new Date().toISOString(), source: "sample" }, true); }
    else if (act === "clear-sample") { S.deals = []; S.byKey = new Map(); S.sample = false; S.sel = null; loadCached().then(renderAll); }
    else if (act === "connect") { S.showConnect = true; showView("deals"); renderAll(); window.scrollTo(0, 0); }
    else if (act === "connect-cancel") { S.showConnect = false; renderAll(); }
    else if (act === "refresh") refresh({ announce: "button" });
    else if (act === "save-letters" || act === "save-mailing") saveWeekFile(act.slice(5), b);
    else if (act === "run-ask") {
      const box = b.closest("[data-runbox]");
      box.innerHTML = `<span>The robot re-checks every county. It takes about ${RUN_MINUTES} minutes and about ${RUN_MINUTES} of your 2,000 free GitHub minutes a month.</span><button class="btn primary small" type="button" data-act="run-go">Start</button><button class="btn small" type="button" data-act="run-cancel">Cancel</button>`;
    }
    else if (act === "run-cancel") renderAll();
    else if (act === "run-go") { b.disabled = true; startRun().then(ok => { if (!ok) renderAll(); }); }
    else if (act === "dismiss-fail") { S.failedRun = null; LS.set("failedRun", null); renderRun(); }
    else if (act === "disconnect") disconnect();
    else if (act === "load-file") $("file").click();
    else if (act === "install") installApp();
    else if (act === "clear-filters") clearFilters();
    else if (act === "county-done") $("county-pick").open = false;
    else if (act === "county-clear") { S.filter.counties = []; $("county-q").value = ""; filtersChanged(); }
    else if (act === "export-xlsx" || act === "export-csv") exportList(act.slice(7), b);
  });
  $("load-btn").addEventListener("click", () => { refresh({ announce: "button" }); checkRun(); syncTracking(); });

  // Chrome offers its own install prompt; keep it for the Install buttons.
  async function installApp() {
    const evt = S.installEvt;
    if (!evt) { showView("help"); return; }
    S.installEvt = null; $("install-btn").hidden = true;
    evt.prompt();
    try { await evt.userChoice; } catch (e) {}
    if (S.view === "help") renderHelp();
  }
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installEvt = e; $("install-btn").hidden = false; if (S.view === "help") renderHelp(); });
  window.addEventListener("appinstalled", () => { S.installEvt = null; $("install-btn").hidden = true; toast("Installed. Deal Machine is on your home screen or taskbar now."); });
  $("install-btn").addEventListener("click", installApp);

  // Sample deals: invented addresses and owners, clearly marked in the UI. Real towns, so the map makes sense.
  const SAMPLE = [
    { score: 98.2, deal_type: "Commissioner's sale bid (lot)", county: "Beckham", parcel_id: "SAMPLE-0001", situs_address: "100 SAMPLE AVE", situs_city: "ELK CITY", owner_name: "BECKHAM COUNTY TREASURER", cost: 708, total_value: 8100, land_value: 8100, acres: 0.32, why: "County-owned: buyable now by commissioner's sale bid (listed $708) · Vacant land (0.32 ac) · Bid $708 is 9% of the $8,100 assessed value", lat: 35.409, lon: -99.41, first_seen: "2026-10-05" },
    { score: 96.9, deal_type: "Tax-delinquent owner (house)", county: "Oklahoma", parcel_id: "SAMPLE-0002", situs_address: "2200 EXAMPLE ST", situs_city: "OKLAHOMA CITY", owner_name: "SAMPLE OWNER", mail_address: "1 DEMO RD", mail_city: "DALLAS", mail_state: "TX", mail_zip: "75201", total_value: 61000, building_sqft: 1150, year_built: 1948, condition: "POOR", arv: 132000, repairs: 46000, mao: 46400, why: "On the city's declared-abandoned-buildings list · Delinquent property taxes (1 yr, $690 owed) · Owner mails to TX · Assessor rates condition Poor", lat: 35.49, lon: -97.48, first_seen: "2026-10-05" },
    { score: 93.4, deal_type: "Probate / heirs (house)", county: "Tulsa", parcel_id: "SAMPLE-0003", situs_address: "415 DEMO PL", situs_city: "TULSA", owner_name: "SAMPLE FAMILY ESTATE", mail_address: "415 DEMO PL", mail_city: "TULSA", mail_state: "OK", mail_zip: "74106", total_value: 74000, building_sqft: 1320, year_built: 1952, condition: "FAIR", arv: 151000, repairs: 26400, mao: 79300, why: "Owner name indicates estate / heirs / multiple owners · Last transfer: personal representative deed, 2024 · Delinquent property taxes (2 yrs, $1,940 owed)", lat: 36.18, lon: -95.97, first_seen: "2026-10-05" },
    { score: 91.0, deal_type: "June tax resale (lot)", county: "Cherokee", parcel_id: "SAMPLE-0004", situs_address: "", situs_city: "TAHLEQUAH", owner_name: "SAMPLE OWNER TWO", cost: 456, total_value: 5200, acres: 1.1, why: "Listed for the June tax resale (min bid $456) · Vacant land (1.10 ac) · Bid $456 is 9% of the $5,200 assessed value", lat: 35.92, lon: -94.99, first_seen: "2026-10-05" },
    { score: 88.6, deal_type: "Storm-damaged (house)", county: "McClain", parcel_id: "SAMPLE-0005", situs_address: "88 EXAMPLE TRL", situs_city: "BLANCHARD", owner_name: "SAMPLE OWNER THREE", mail_address: "88 EXAMPLE TRL", mail_city: "BLANCHARD", mail_state: "OK", mail_zip: "73010", total_value: 142000, why: "EF2 damage surveyed 2026-05-06: one- or two-family residence - roof structure removed · Same owner for 31 years", lat: 35.14, lon: -97.66, first_seen: "2026-10-05" },
    { score: 84.1, deal_type: "Absentee owner (lot)", county: "Creek", parcel_id: "SAMPLE-0006", situs_address: "0 SAMPLE RD", situs_city: "SAPULPA", owner_name: "SAMPLE LAND LLC", mail_address: "9 DEMO WAY", mail_city: "PHOENIX", mail_state: "AZ", mail_zip: "85001", land_value: 14000, total_value: 14000, offer: 4900, acres: 4.8, why: "Vacant land (4.80 ac) · Owner mails to AZ · Owner holds 6 vacant parcels in this county (bulk / tired holder)", lat: 35.98, lon: -96.13, first_seen: "2026-10-05" },
    { score: 79.5, deal_type: "REO / agency-owned (house)", county: "Cleveland", parcel_id: "SAMPLE-0007", situs_address: "1717 DEMO DR", situs_city: "NORMAN", owner_name: "SAMPLE MORTGAGE ASSOCIATION", mail_address: "PO BOX 1", mail_city: "DALLAS", mail_state: "TX", mail_zip: "75201", total_value: 168000, building_sqft: 1610, year_built: 1978, why: "Lender/agency owned (REO) · No homestead exemption (not owner-occupied)", lat: 35.22, lon: -97.44, first_seen: "2026-10-05" },
    { score: 72.3, deal_type: "Neglected property (lot)", county: "Kay", parcel_id: "SAMPLE-0008", situs_address: "310 EXAMPLE AVE", situs_city: "PONCA CITY", owner_name: "SAMPLE OWNER FOUR", mail_address: "3 DEMO CT", mail_city: "WICHITA", mail_state: "KS", mail_zip: "67202", land_value: 6500, total_value: 6500, offer: 2275, why: "Vacant land · Owner mails to KS · Same owner for 24 years", lat: 36.71, lon: -97.08, first_seen: "2026-10-05" },
  ];

  // ---- boot ----------------------------------------------------------------------------------------
  S.spot = LS.get("spot", null);
  if (S.spot) { $("spot-clear").hidden = false; }
  {
    const saved = LS.get("filters", {}) || {};
    S.filter = { ...FILTER_DEFAULTS };
    for (const k of Object.keys(FILTER_DEFAULTS)) {
      if (k !== "q" && k in saved && (Array.isArray(FILTER_DEFAULTS[k]) ? Array.isArray(saved[k]) : true)) S.filter[k] = saved[k];
    }
    S.filter.tags = S.filter.tags.filter(t => TAG_LABEL[t]);
    if (S.filter.sort === "near" && !S.spot) S.filter.sort = "score";
  }
  S.gh = LS.get("gh", null);
  S.index = LS.get("index", null);
  S.asked = LS.get("asked", null);
  S.failedRun = LS.get("failedRun", null);
  if (S.asked && Date.now() - S.asked.at > 3 * 3600e3) { S.asked = null; LS.set("asked", null); }
  S.loading = !!S.gh;
  setTracked();
  buildTowns();
  renderAll();
  const startView = LS.get("view", "deals");
  showView(["deals", "map", "tracked", "help"].includes(startView) ? startView : "deals");

  (async function boot() {
    await loadCached();
    if (S.gh) { refresh(); syncTracking(); checkRun(); }
    else { S.loading = false; renderAll(); }
    if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  })();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !S.gh) return;
    if (Date.now() - lastRefresh > 10 * 60000) refresh();
    syncTracking(); checkRun();
  });
  window.addEventListener("online", () => { if (S.gh) { refresh(); syncTracking(); checkRun(); } });
  setInterval(() => { if (document.visibilityState === "visible" && S.gh) syncTracking(); }, 3 * 60000);
  setInterval(() => { if (activeRun()) renderRun(); }, 60000);  // keep "about N min to go" honest
})();
