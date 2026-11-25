import assert from "node:assert/strict";
import {
  buildFilmTemplateWorkbook,
  filmScriptFromTemplateRows,
  parseFilmTemplateWorkbook,
  parseFilmTemplateXlsx,
} from "../dist/film-excel.js";

const rows = [
  { scene_no: 1, hook: "", prompt: "Prompt scene one." },
  { scene_no: 2, hook: "", prompt: "Prompt scene two." },
];

const script = filmScriptFromTemplateRows(rows);
assert.match(script, /^=== SCENE 001 ===\nPrompt scene one\./);
assert.match(script, /=== SCENE 002 ===\nPrompt scene two\./);

const xlsx = await buildFilmTemplateWorkbook([
  {
    no: "0001",
    rows,
    publish: { caption: "Nếu VN ko có tết?", tiktok: false, youtube: true, facebook: false, publish_mode: "now" },
  },
]);
const parsed = parseFilmTemplateXlsx(xlsx);
assert.equal(parsed.no, "0001");
assert.equal(parsed.hook, "Nếu VN ko có tết?");
assert.equal(parsed.publish?.youtube, true);
assert.equal(parsed.publish?.publish_mode, "now");
assert.equal(parsed.rows.length, 2);
assert.match(parsed.script, /SCENE 001/);

const sched = await buildFilmTemplateWorkbook([
  {
    no: "0012",
    rows,
    publish: {
      caption: "Hook sched",
      tiktok: true,
      youtube: false,
      facebook: true,
      publish_mode: "schedule",
      schedule_at: "2026-12-01T18:00",
      schedule_timezone: "Asia/Ho_Chi_Minh",
    },
  },
]);
const schedParsed = parseFilmTemplateWorkbook(sched);
assert.equal(schedParsed.films[0].publish?.publish_mode, "schedule");
assert.equal(schedParsed.films[0].publish?.schedule_at, "2026-12-01T18:00");
assert.equal(schedParsed.films[0].publish?.tiktok, true);

const empty = await buildFilmTemplateWorkbook([{ no: "0001", publish: { publish_mode: "now" } }]);
assert.ok(empty.length > 100, "empty template should still be a valid xlsx");

const multi = await buildFilmTemplateWorkbook([
  { no: "0007", rows, publish: { caption: "H7" } },
  { no: "0008", rows: [{ scene_no: 1, hook: "", prompt: "Scene eight." }], publish: { caption: "H8" } },
]);
const imported = parseFilmTemplateWorkbook(multi);
assert.equal(imported.films.length, 2);
assert.equal(imported.films[0].hook, "H7");
assert.equal(imported.films[1].hook, "H8");

console.log("film-excel tests passed");