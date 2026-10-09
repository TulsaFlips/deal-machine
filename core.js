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

  // ---- reasons: the robot's signal codes, grouped into the filters people pick from ------------------
  const TAGS = [
    { id: "buy", label: "Buy now from the county", codes: ["county_owned_for_sale"] },
    { id: "auction", label: "June tax auction", codes: ["on_resale_list"] },
    { id: "delinquent", label: "Behind on taxes", codes: ["tax_delinquent", "past_resale_list"] },
    { id: "heirs", label: "Heirs / estate", codes: ["estate_or_heirs", "probate", "life_event_transfer"] },
    { id: "foreclosure", label: "Pre-foreclosure", codes: ["sheriff_sale", "lis_pendens"] },
    { id: "storm", label: "Storm damage", codes: ["storm_damage"] },
    { id: "abandoned", label: "Abandoned building", codes: ["abandoned_building"] },
    { id: "code", label: "Code cases / city liens", codes: ["code_violations", "utility_lien"] },
    { id: "rundown", label: "Run-down", codes: ["poor_condition", "low_improvement_ratio"] },
    { id: "vacant", label: "Vacant land", codes: ["vacant_land"] },
    { id: "absentee", label: "Absentee owner", codes: ["absentee_owner", "out_of_state_owner"] },
    { id: "outofstate", label: "Out-of-state owner", codes: ["out_of_state_owner"] },
    { id: "tenure", label: "Long-time owner", codes: ["long_tenure"] },
    { id: "portfolio", label: "Owns several lots", codes: ["lot_portfolio_owner"] },
    { id: "trouble", label: "Behind on other parcels too", codes: ["owner_trouble_elsewhere"] },
    { id: "trust", label: "Trust-owned", codes: ["trust_owned"] },
    { id: "rental", label: "Not owner-occupied", codes: ["no_homestead"] },
    { id: "bank", label: "Bank / agency owned", codes: ["bank_owned"] },
    { id: "public", label: "City / public owner", codes: ["government_owned"] },
    { id: "discount", label: "Bid far below value", codes: ["deep_discount"] },
    { id: "excess", label: "Unclaimed excess proceeds", codes: ["excess_proceeds"] },
  ];
  // Files from before the robot shipped codes: read them back from the reason sentences (okdeals/signals.py).
  const WHY_CODES = [
    [/^County-owned: buyable|^Struck off to the county/, "county_owned_for_sale"],
    [/^Listed for the June tax resale/, "on_resale_list"],
    [/^Was on the .* tax resale list/, "past_resale_list"],
    [/^Delinquent property taxes/, "tax_delinquent"],
    [/^Owner name indicates estate/, "estate_or_heirs"],
    [/^Probate case/, "probate"],
    [/^Last transfer: /, "life_event_transfer"],
    [/^Scheduled sheriff's sale/, "sheriff_sale"],
    [/^Lis pendens/, "lis_pendens"],
    [/damage surveyed|storm damage/i, "storm_damage"],
    [/^On the city's declared-abandoned/, "abandoned_building"],
    [/code case\(s\)/, "code_violations"],
    [/^Assessor rates condition/, "poor_condition"],
    [/^Structure is only/, "low_improvement_ratio"],
    [/^Vacant land/, "vacant_land"],
    [/^Owner's mailing address differs/, "absentee_owner"],
    [/^Owner mails to /, "out_of_state_owner"],
    [/^Same owner for/, "long_tenure"],
    [/^Owner holds \d+ vacant parcels/, "lot_portfolio_owner"],
    [/^Owner is also delinquent/, "owner_trouble_elsewhere"],
    [/^Held in a trust/, "trust_owned"],
    [/^No homestead exemption/, "no_homestead"],
    [/^Lender\/agency owned/, "bank_owned"],
    [/^Publicly owned:/, "government_owned"],
    [/^Bid \$[\d,]+ is \d+% of/, "deep_discount"],
    [/^Former owner has unclaimed/, "excess_proceeds"],
    [/lien/i, "utility_lien"],
  ];
  function signalCodes(deal) {
    if (deal && deal.signals) return new Set(String(deal.signals).split(/\s+/).filter(Boolean));
    const codes = new Set();
    for (const part of String(deal && deal.why || "").split(" · ")) {
      const hit = WHY_CODES.find(([re]) => re.test(part.trim()));
      if (hit) codes.add(hit[1]);
    }
    return codes;
  }
  function tagsOf(deal) {
    const codes = signalCodes(deal);
    return TAGS.filter(t => t.codes.some(c => codes.has(c))).map(t => t.id);
  }

  // ---- spreadsheets: a small .xlsx writer (typed cells, money formats, frozen header, filters) and CSV --
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function zip(files) {  // [[name, Uint8Array]] -> .zip bytes, deflated when the browser can
    const te = new TextEncoder(), body = [], central = [];
    let offset = 0;
    for (const [name, data] of files) {
      const nb = te.encode(name), crc = crc32(data);
      let packed = null;
      if (typeof CompressionStream !== "undefined") {
        packed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
      }
      const method = packed ? 8 : 0, stored = packed || data;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
      h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, stored.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, nb.length, true);
      body.push(new Uint8Array(h.buffer), nb, stored);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, method, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, stored.length, true);
      c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + stored.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, size, true); e.setUint32(16, offset, true);
    return concat([...body, ...central, new Uint8Array(e.buffer)]);
  }
  const xml = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function colName(i) { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; }
  // columns: [{name, type: text|int|num|dec1|dec2|money|link, width, label}]; rows: arrays of plain values.
  const STYLE_OF = { int: 3, dec1: 4, dec2: 5, money: 2, link: 6, num: 0 };
  async function xlsx(sheetName, columns, rows) {
    const te = new TextEncoder();
    const cell = (ref, v, col) => {
      if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return "";
      if (col.type === "link") {
        const label = xml(col.label || "Open");
        return `<c r="${ref}" s="6" t="str"><f>HYPERLINK("${xml(String(v).replace(/"/g, '""'))}","${label}")</f><v>${label}</v></c>`;
      }
      if (col.type !== "text" && typeof v === "number") return `<c r="${ref}"${STYLE_OF[col.type] ? ` s="${STYLE_OF[col.type]}"` : ""}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    };
    const last = colName(columns.length - 1) + (rows.length + 1);
    const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
      "<cols>" + columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`).join("") + "</cols>",
      '<sheetData><row r="1">' + columns.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${xml(c.name)}</t></is></c>`).join("") + "</row>"];
    rows.forEach((r, n) => { out.push(`<row r="${n + 2}">` + columns.map((c, i) => cell(colName(i) + (n + 2), r[i], c)).join("") + "</row>"); });
    out.push(`</sheetData><autoFilter ref="A1:${last}"/></worksheet>`);
    const name = xml(String(sheetName || "Sheet1").replace(/[[\]:*?/\\]/g, " ").slice(0, 31));
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const files = {
      "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${last.replace(/(\d+)$/, "$$$1")}</definedName></definedNames></workbook>`,
      "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
      "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet ${ns}><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts>`
        + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF1C5D8C"/><name val="Calibri"/></font></fonts>'
        + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EDE8"/><bgColor indexed="64"/></patternFill></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
      "xl/worksheets/sheet1.xml": out.join(""),
    };
    return zip(Object.entries(files).map(([n, s]) => [n, te.encode(s)]));
  }
  // CSV for mail-merge tools. Text that starts like a formula gets a leading ' so spreadsheets show it as text.
  function csv(columns, rows) {
    const q = v => {
      if (v == null || (typeof v === "number" && !isFinite(v))) return "";
      let s = String(v);
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + [columns.map(c => q(c.name)), ...rows.map(r => r.map(q))].map(r => r.join(",")).join("\r\n") + "\r\n";
  }

  root.DM = { readZip, untar, decryptOpenSSL, parseCSV, leadsFromCSV, unpack, miles, taxCalendar, nthWeekday,
    mergeTracking, pruneTombstones, liveTracking, stable, b64encode, b64decode,
    TAGS, signalCodes, tagsOf, crc32, zip, xlsx, csv };
})(typeof window !== "undefined" ? window : globalThis);
