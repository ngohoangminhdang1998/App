import assert from "node:assert/strict";
import {
  buildFilmTemplateWorkbook,
  buildFilmTemplateXlsx,
  filmScriptFromTemplateRows,
  parseFilmTemplateWorkbook,
  parseFilmTemplateXlsx,
} from "../dist/film-excel.js";

const rows = [
  { scene_no: 1, hook: "Nếu VN ko có tết?", prompt: "Prompt scene one." },
  { scene_no: 2, hook: "", prompt: "Prompt scene two." },
];

const script = filmScriptFromTemplateRows(rows);
assert.match(script, /^=== SCENE 001 ===\nPrompt scene one\./);
assert.match(script, /=== SCENE 002 ===\nPrompt scene two\./);

const xlsx = buildFilmTemplateXlsx({ no: "0001", rows });
const parsed = parseFilmTemplateXlsx(xlsx);
assert.equal(parsed.no, "0001");
assert.equal(parsed.hook, "Nếu VN ko có tết?");
assert.equal(parsed.rows.length, 2);
assert.match(parsed.script, /SCENE 001/);

const empty = buildFilmTemplateXlsx({ no: "0001" });
assert.ok(empty.length > 100, "empty template should still be a valid xlsx");

const multi = buildFilmTemplateWorkbook([
  { no: "0007", rows },
  { no: "0008", rows: [{ scene_no: 1, hook: "H8", prompt: "Scene eight." }] },
]);
const imported = parseFilmTemplateWorkbook(multi);
assert.equal(imported.films.length, 2);
assert.equal(imported.films[0].no, "0007");
assert.equal(imported.films[1].no, "0008");

console.log("film-excel tests passed");