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
