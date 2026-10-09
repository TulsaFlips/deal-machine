/* Pure helpers: file unpacking, CSV, geography, Oklahoma's tax calendar. No DOM access. */
(function (root) {
  "use strict";
  const td = new TextDecoder();

  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ZIP (as GitHub delivers artifacts): central directory sizes, stored or deflate entries.
  async function readZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not_zip");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad_zip");
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(bytes.subarray(p + 46, p + 46 + nlen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (!name.endsWith("/")) out[name] = method === 0 ? data : method === 8 ? await inflate(data, "deflate-raw") : null;
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  function untar(bytes) {
    const out = {};
    let p = 0;
    while (p + 512 <= bytes.length) {
      const nameRaw = td.decode(bytes.subarray(p, p + 100)).replace(/\0[\s\S]*$/, "");
      if (!nameRaw) break;
      const prefix = td.decode(bytes.subarray(p + 345, p + 500)).replace(/\0[\s\S]*$/, "");
      const size = parseInt(td.decode(bytes.subarray(p + 124, p + 136)).replace(/\0/g, "").trim() || "0", 8);
      const type = String.fromCharCode(bytes[p + 156]);
      const name = ((prefix ? prefix + "/" : "") + nameRaw).replace(/^\.\//, "");
      if (type === "0" || type === "\0") out[name] = bytes.subarray(p + 512, p + 512 + size);
      p += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  }

  // `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`: "Salted__" + salt, key and IV from PBKDF2-SHA256.
  async function decryptOpenSSL(bytes, password) {
    if (td.decode(bytes.subarray(0, 8)) !== "Salted__") throw new Error("not_locked");
    const salt = bytes.subarray(8, 16);
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 200000 }, material, 384));
    const key = await crypto.subtle.importKey("raw", bits.subarray(0, 32), "AES-CBC", false, ["decrypt"]);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: bits.subarray(32, 48) }, key, bytes.subarray(16)));
    } catch (e) { throw new Error("wrong_password"); }
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, q = false;
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const NUM = new Set(["score", "acres", "land_value", "improvement_value", "total_value", "cost", "arv", "repairs", "mao", "offer", "building_sqft", "year_built", "lat", "lon"]);
  function leadsFromCSV(text) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error("empty_csv");
    const cols = rows[0].map(s => s.trim());
    if (!cols.includes("score") || !cols.includes("parcel_id")) throw new Error("not_leads_csv");
    return rows.slice(1).filter(r => r.length >= cols.length - 1).map(r => {
      const o = {};
      cols.forEach((c, k) => {
        const v = (r[k] ?? "").trim();
        o[c] = v === "" ? null : NUM.has(c) ? (Number.isFinite(+v) ? +v : null) : v;
      });
      return o;
    });
  }

  // Unpack whatever the viewer picked: the GitHub artifact zip, the tarball, the locked .enc, or leads.csv.
  async function unpack(bytes, askPassword) {
    const sig = bytes.subarray(0, 8);
    if (sig[0] === 0x50 && sig[1] === 0x4b) {
      const files = await readZip(bytes);
      const pick = Object.keys(files).find(n => /leads\.csv$/i.test(n))
        || Object.keys(files).find(n => /\.tar\.gz\.enc$|\.enc$/i.test(n))
        || Object.keys(files).find(n => /\.(tar\.gz|tgz)$/i.test(n));
      if (!pick || !files[pick]) throw new Error("zip_without_leads");
      return unpack(files[pick], askPassword);
    }
    if (td.decode(sig) === "Salted__") {
      let tries = 0;
      while (true) {
        const pw = await askPassword(tries++ ? "That passphrase didn't unlock it. Check it and try again." : "");
        if (pw == null) throw new Error("cancelled");
        try { return await unpack(await decryptOpenSSL(bytes, pw), askPassword); }
        catch (e) { if (e.message !== "wrong_password") throw e; }
      }
    }
    if (sig[0] === 0x1f && sig[1] === 0x8b) return unpack(await inflate(bytes, "gzip"), askPassword);
    if (bytes.length > 262 && td.decode(bytes.subarray(257, 262)) === "ustar") {
      const files = untar(bytes);
      const pick = Object.keys(files).find(n => /leads\.csv$/i.test(n));
      if (!pick) throw new Error("tar_without_leads");
      return unpack(files[pick], askPassword);
    }
    return leadsFromCSV(td.decode(bytes));
  }

  function miles(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2
      + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
  }

  function nthWeekday(year, month, weekday, n) {
    const d = new Date(Date.UTC(year, month, 1));
    const shift = (weekday - d.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month, 1 + shift + 7 * (n - 1)));
  }
  // 68 O.S. §§ 2913, 3105, 3125, 3135: the dates every Oklahoma county runs on.
  function taxCalendar(today) {
    const out = [];
    for (const y of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
      out.push({ when: new Date(Date.UTC(y, 0, 1)), name: "Property taxes go delinquent", play: "Earliest sign an owner is falling behind", law: "68 O.S. § 2913" });
      out.push({ when: new Date(Date.UTC(y, 4, 15)), name: "Counties post resale lists (about mid-May)", play: "You get a phone alert; mail those owners first", law: "" });
      out.push({ when: nthWeekday(y, 5, 1, 2), name: "Tax resale auctions, all 77 counties", play: "Bid on resale deeds", law: "68 O.S. § 3125" });
      out.push({ when: new Date(Date.UTC(y, 5, 30)), name: "Unsold parcels become county-owned (late June)", play: "Commissioner's-sale bids, often a few hundred dollars", law: "68 O.S. § 3135" });
      out.push({ when: nthWeekday(y, 9, 1, 1), name: "Tax-lien certificate sale", play: "Owners are 2–3 years from losing the property", law: "68 O.S. § 3105" });
    }
    const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return out.filter(e => e.when.getTime() >= t0).sort((a, b) => a.when - b.when).slice(0, 6);
  }

  // ---- tracker sync: one JSON file per project, merged entry by entry --------------------------------
  // Entries are {key, status, note, updatedAt, ...}; a cleared entry is a tombstone {key, deleted: true,
  // updatedAt} so the clear reaches other devices. The newer updatedAt wins; ties keep the first map's.
  function mergeTracking(base, incoming) {
    const out = Object.assign({}, base || {});
    for (const [k, v] of Object.entries(incoming || {})) {
      const cur = out[k];
      if (!cur || String(v && v.updatedAt || "") > String(cur.updatedAt || "")) out[k] = v;
    }
    return out;
  }
  function pruneTombstones(map, now, days) {
    const cut = new Date(now.getTime() - (days || 90) * 864e5).toISOString();
    const out = {};
    for (const [k, v] of Object.entries(map || {})) if (!(v && v.deleted && String(v.updatedAt || "") < cut)) out[k] = v;
    return out;
  }
  function liveTracking(map) {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) if (v && !v.deleted) out[k] = v;
    return out;
  }
  // JSON with sorted keys, so "did anything change?" doesn't depend on key order.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  // GitHub's contents API speaks base64; these keep non-ASCII text (owner notes) intact.
  function b64encode(text) {
    const bytes = new TextEncoder().encode(text);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(b64) {
    const bin = atob(String(b64 || "").replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  root.DM = { readZip, untar, decryptOpenSSL, parseCSV, leadsFromCSV, unpack, miles, taxCalendar, nthWeekday,
    mergeTracking, pruneTombstones, liveTracking, stable, b64encode, b64decode };
})(typeof window !== "undefined" ? window : globalThis);
