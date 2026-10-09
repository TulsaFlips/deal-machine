// node --test webapp/tests: the web app's pure helpers (tracker merge, base64, tax calendar).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

createRequire(import.meta.url)("../core.js");
const DM = globalThis.DM;

test("newer change to a deal wins, from either side", () => {
  const remote = { a: { key: "a", status: "Mailed", updatedAt: "2026-10-01T10:00:00Z" }, b: { key: "b", status: "Called", updatedAt: "2026-10-03T10:00:00Z" } };
  const local = { a: { key: "a", status: "Called", updatedAt: "2026-10-02T10:00:00Z" }, b: { key: "b", status: "Pass", updatedAt: "2026-10-02T10:00:00Z" }, c: { key: "c", note: "new", updatedAt: "2026-10-04T10:00:00Z" } };
  const m = DM.mergeTracking(remote, local);
  assert.equal(m.a.status, "Called");
  assert.equal(m.b.status, "Called");
  assert.equal(m.c.note, "new");
  assert.deepEqual(DM.mergeTracking(m, remote), m, "merging again changes nothing");
});

test("a cleared deal stays cleared on the other device, and old clears are pruned", () => {
  const remote = { a: { key: "a", status: "Mailed", updatedAt: "2026-10-01T10:00:00Z" } };
  const local = { a: { key: "a", deleted: true, updatedAt: "2026-10-05T10:00:00Z" } };
  const m = DM.mergeTracking(remote, local);
  assert.equal(m.a.deleted, true);
  assert.deepEqual(DM.liveTracking(m), {});
  assert.ok(DM.pruneTombstones(m, new Date("2026-11-01T00:00:00Z")).a, "kept while recent");
  assert.equal(DM.pruneTombstones(m, new Date("2027-03-01T00:00:00Z")).a, undefined, "dropped after 90 days");
});

test("stable JSON ignores key order", () => {
  assert.equal(DM.stable({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), DM.stable({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(DM.stable({ a: 1 }), DM.stable({ a: 2 }));
});

test("base64 round-trips notes with any characters", () => {
  const text = JSON.stringify({ note: "Talked to Mrs. Núñez — wants $4,500 ✓", big: "x".repeat(100000) });
  assert.equal(DM.b64decode(DM.b64encode(text)), text);
  assert.equal(DM.b64decode(DM.b64encode(text).replace(/(.{60})/g, "$1\n")), text, "GitHub wraps base64 lines");
});

test("tax calendar lists the upcoming dates in order", () => {
  const cal = DM.taxCalendar(new Date(Date.UTC(2026, 9, 9)));
  assert.equal(cal.length, 5, "after October's lien sale, next year's five dates");
  assert.equal(DM.taxCalendar(new Date(Date.UTC(2026, 0, 2))).length, 6);
  assert.ok(cal.every((e, i) => i === 0 || cal[i - 1].when <= e.when));
  assert.ok(cal[0].when >= new Date(Date.UTC(2026, 9, 9)));
});

test("reasons come from the robot's codes, or from its sentences in older files", () => {
  assert.deepEqual(DM.tagsOf({ signals: "tax_delinquent estate_or_heirs out_of_state_owner" }), ["delinquent", "heirs", "absentee", "outofstate"]);
  const why = "County-owned: buyable now by commissioner's sale bid (listed $708) · Vacant land (0.32 ac) · Bid $708 is 9% of the $8,100 assessed value"
    + " · Last transfer: Personal Representative Deed (estate sale), 2024 · Delinquent property taxes (2 yrs, $1,940 owed) · EF2 damage surveyed 2026-05-06: roof removed";
  assert.deepEqual(DM.tagsOf({ why }), ["buy", "delinquent", "heirs", "storm", "vacant", "discount"]);
  assert.deepEqual(DM.tagsOf({ why: "" }), []);
  for (const t of DM.TAGS) assert.ok(t.codes.length && t.label, t.id);
});

test("spreadsheet: a valid zip with typed cells, and CSV that can't run formulas", async () => {
  const cols = [{ name: "Parcel", type: "text" }, { name: "Bid", type: "money" }, { name: "Owner", type: "text" }, { name: "Map", type: "link", label: "Directions" }];
  const rows = [["00123", 708, "=HYPERLINK(\"x\") & <b>", "https://www.google.com/maps/dir/?api=1&destination=35.4,-99.4"], ["38975923302580", null, "Núñez", null]];
  const files = await DM.readZip(await DM.xlsx("Deals", cols, rows));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">00123<\/t>/, "parcel stays text");
  assert.match(sheet, /<c r="B2" s="2"><v>708<\/v>/, "money is a number with a $ format");
  assert.match(sheet, /=HYPERLINK\(&quot;x&quot;\) &amp; &lt;b&gt;/, "owner text is escaped, not a formula");
  assert.match(sheet, /<f>HYPERLINK\(/, "links are clickable");
  assert.match(sheet, /<autoFilter ref="A1:D3"\/>/);
  assert.equal(DM.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const text = DM.csv(cols, rows);
  assert.ok(text.startsWith("﻿Parcel,Bid,Owner,Map\r\n00123,708,\"'=HYPERLINK(\"\"x\"\") & <b>\""), text.slice(0, 80));
});

test("years behind on taxes: the robot's number, or read from its sentences", () => {
  assert.deepEqual(DM.taxInfo({ tax_years: 2, tax_owed: 1940 }), { years: 2, owed: 1940 });
  assert.deepEqual(DM.taxInfo({ why: "Vacant land · Delinquent property taxes (1 yr, $406 owed)" }), { years: 1, owed: 406 });
  assert.deepEqual(DM.taxInfo({ why: "Delinquent property taxes (2 yrs, $1,940 owed) · Listed for the June tax resale (min bid $666)" }), { years: 3, owed: 1940 });
  assert.deepEqual(DM.taxInfo({ why: "Was on the June 2024 tax resale list (3+ years delinquent)" }), { years: 3, owed: null });
  assert.deepEqual(DM.taxInfo({ why: "Absentee owner" }), { years: null, owed: null });
  assert.deepEqual(DM.taxInfo({ tax_years: null, tax_owed: null, why: "Delinquent property taxes (1 yr)" }), { years: 1, owed: null });
});
