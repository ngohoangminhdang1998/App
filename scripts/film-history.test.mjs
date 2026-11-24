import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = join(tmpdir(), `film-history-test-${Date.now()}`);
process.env.FLOW_MCP_HOME = home;
mkdirSync(home, { recursive: true });

const {
  deleteFilmHistory,
  buildFilmHistory,
  maxKnownFilmSerial,
  nextFilmNoFromHistory,
  recordFilmMerge,
  syncFilmHistoryFromNumbers,
} = await import("../dist/film-history.js");
const { listFilmNumbers } = await import("../dist/film-numbers.js");

writeFileSync(
  join(home, "film-numbers.json"),
  JSON.stringify({
    next: 3,
    films: [
      { no: "0001", created_at: "2026-01-01T00:00:00.000Z" },
      { no: "0002", created_at: "2026-01-02T00:00:00.000Z" },
    ],
  }),
  "utf8",
);

syncFilmHistoryFromNumbers();
let rows = buildFilmHistory(50);
assert.equal(rows.length, 2);
assert.equal(maxKnownFilmSerial(), 2);
assert.deepEqual(nextFilmNoFromHistory(), { no: "0003", next: 4 });

recordFilmMerge({ no: "0001", hook: "Hook one" });
rows = buildFilmHistory(50);
assert.equal(rows.find((r) => r.no === "0001")?.hook, "Hook one");

const one = deleteFilmHistory({ nos: ["0001"] });
assert.equal(one.deleted, 1);
assert.equal(one.remaining, 1);
rows = buildFilmHistory(50);
assert.equal(rows.length, 1);
assert.equal(rows[0].no, "0002");

syncFilmHistoryFromNumbers();
rows = buildFilmHistory(50);
assert.equal(rows.length, 1, "suppressed 0001 must not reappear");

const all = deleteFilmHistory({ all: true });
assert.equal(all.remaining, 0);
assert.equal(buildFilmHistory(50).length, 0);

rmSync(home, { recursive: true, force: true });
console.log("film-history tests passed");