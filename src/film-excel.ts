import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { isFilmNo } from "./film-numbers.js";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const TEMPLATE_XLSX = join(TEMPLATE_DIR, "tedverse-film-template.xlsx");
const HOOK_PLACEHOLDER = "Input hook here...";
/** Excel 1-based row numbers (match WPS template). */
const ROW_GMT = 6;
const ROW_PUBLISH_TIME = 7;
const SCENE_FIRST_ROW = 10;
/** Default blank scene rows in export; extra template rows are cleared up to this many slots. */
const SCENE_DEFAULT_COUNT = 5;
const SCENE_CLEAR_SLOTS = 12;

function ensureFilmTemplateFile(): void {
  if (!existsSync(TEMPLATE_XLSX)) {
    throw new Error("Missing assets/tedverse-film-template.xlsx — copy your styled WPS template there.");
  }
}

export const TEMPLATE_HEADERS = ["Scene No", "Prompt"] as const;
/** @deprecated old scene table */
export const LEGACY_SCENE_HEADERS = ["Scene No", "Hook", "Prompt"] as const;

export type FilmTemplateRow = { scene_no: number; hook: string; prompt: string };

export type FilmTemplatePublishMeta = {
  caption?: string;
  hashtags?: string;
  tiktok?: boolean;
  youtube?: boolean;
  facebook?: boolean;
  publish_mode?: "now" | "schedule";
  schedule_at?: string;
  schedule_timezone?: string;
  video_path?: string;
  tiktok_status?: string;
  youtube_status?: string;
  facebook_status?: string;
};

const PUBLISH_DEFAULT_TZ = "Asia/Ho_Chi_Minh";

function normalizeHeader(cell: unknown): string {
  return String(cell ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function columnIndex(headers: string[], names: string[]): number {
  for (const name of names) {
    const ix = headers.indexOf(name);
    if (ix >= 0) return ix;
  }
  return -1;
}

function yesNoDisplay(val: boolean | undefined): string {
  return val ? "Yes" : "No";
}

function parseYesNo(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1" || s === "x" || s === "on" || s === "có";
}

function parsePublishMode(raw: unknown): "now" | "schedule" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.includes("schedule") || s === "later") return "schedule";
  return "now";
}

function parseGmtTimezone(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return PUBLISH_DEFAULT_TZ;
  const low = s.toLowerCase();
  if (low.includes("ho_chi_minh") || low.includes("vietnam") || /^gmt\+7$/.test(low) || low === "+7" || low.includes("(gmt+7)")) {
    return PUBLISH_DEFAULT_TZ;
  }
  if (low.includes("bangkok") || low.includes("thailand")) return "Asia/Bangkok";
  if (low.includes("singapore")) return "Asia/Singapore";
  if (low.includes("tokyo")) return "Asia/Tokyo";
  if (low === "utc" || low === "gmt") return "UTC";
  if (/^[a-z]+\/[a-z_]+$/i.test(s)) return s;
  return PUBLISH_DEFAULT_TZ;
}

function parsePublishTimeCell(val: unknown): string {
  if (val == null || val === "") return "";
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return `${val.getFullYear()}-${pad2(val.getMonth() + 1)}-${pad2(val.getDate())}T${pad2(val.getHours())}:${pad2(val.getMinutes())}`;
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    return excelSerialToLocalIso(val);
  }
  const asNum = Number(String(val).trim());
  if (Number.isFinite(asNum) && String(val).trim() !== "" && asNum > 30000) {
    return excelSerialToLocalIso(asNum);
  }
  const s = String(val).trim();
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?$/i);
  if (slash) {
    const [, day, month, year, hRaw, min, ampm] = slash;
    let h = +(hRaw ?? 0);
    if (ampm) {
      const up = ampm.toUpperCase();
      if (up === "PM" && h < 12) h += 12;
      if (up === "AM" && h === 12) h = 0;
    }
    return `${year}-${pad2(+month!)}-${pad2(+day!)}T${pad2(h)}:${pad2(+(min ?? 0))}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  return s;
}

function findSceneHeaderRow(grid: unknown[][]): number {
  for (let i = 0; i < Math.min(grid.length, 50); i++) {
    const row = grid[i] as unknown[];
    const normed = row.map(normalizeHeader);
    const hasScene = columnIndex(normed, ["scene no", "scene", "no", "stt", "cảnh"]) >= 0;
    const hasPrompt = columnIndex(normed, ["prompt", "mô tả", "script"]) >= 0;
    if (hasScene && hasPrompt) return i;
  }
  return -1;
}

const LEGACY_PUBLISH_MAP: Record<string, keyof FilmTemplatePublishMeta> = {
  caption: "caption",
  hashtags: "hashtags",
  tiktok: "tiktok",
  youtube: "youtube",
  facebook: "facebook",
  "publish mode": "publish_mode",
  "schedule at": "schedule_at",
  timezone: "schedule_timezone",
  "schedule timezone": "schedule_timezone",
  gmt: "schedule_timezone",
  "publish time": "schedule_at",
  "video path": "video_path",
};

function parseLegacyPublishBlock(grid: unknown[][], sceneHeaderRow: number): FilmTemplatePublishMeta | undefined {
  if (sceneHeaderRow <= 0) return undefined;
  const out: FilmTemplatePublishMeta = {};
  let saw = false;
  for (let i = 0; i < sceneHeaderRow; i++) {
    const row = grid[i] as unknown[];
    if (!row?.length) continue;
    const a = String(row[0] ?? "").trim();
    const b = row[1];
    if (!a || normalizeHeader(a) === "field" || a.startsWith("---")) continue;
    const key = LEGACY_PUBLISH_MAP[normalizeHeader(a)];
    if (!key) continue;
    saw = true;
    if (key === "tiktok" || key === "youtube" || key === "facebook") out[key] = parseYesNo(b);
    else if (key === "publish_mode") out.publish_mode = parsePublishMode(b);
    else if (key === "schedule_timezone") out[key] = parseGmtTimezone(b);
    else if (key === "schedule_at") out[key] = parsePublishTimeCell(b);
    else out[key] = String(b ?? "").trim();
  }
  return saw ? out : undefined;
}

/** New template: Hook, Youtube, … in column A; values in column B. */
function isTemplatePlaceholderHook(s: string): boolean {
  const low = s.trim().toLowerCase();
  return low.startsWith("input hook");
}

function parsePublishFormBlock(grid: unknown[][], sceneHeaderRow: number): FilmTemplatePublishMeta | undefined {
  if (sceneHeaderRow <= 0) return undefined;
  const out: FilmTemplatePublishMeta = {};
  let saw = false;
  for (let i = 0; i < sceneHeaderRow; i++) {
    const row = grid[i] as unknown[];
    if (!row?.length) continue;
    const label = normalizeHeader(row[0]);
    const value = row[1];
    if (!label) continue;
    if (label === "hook") {
      const h = String(value ?? "").trim();
      if (h && !isTemplatePlaceholderHook(h)) out.caption = h;
      saw = true;
      continue;
    }
    if (label === "youtube") {
      out.youtube = parseYesNo(value);
      saw = true;
      continue;
    }
    if (label === "facebook") {
      out.facebook = parseYesNo(value);
      saw = true;
      continue;
    }
    if (label === "tiktok") {
      out.tiktok = parseYesNo(value);
      saw = true;
      continue;
    }
    if (label === "publish mode") {
      out.publish_mode = parsePublishMode(value);
      saw = true;
      continue;
    }
    if (label === "gmt") {
      out.schedule_timezone = parseGmtTimezone(value);
      saw = true;
      continue;
    }
    if (label === "publish time") {
      out.schedule_at = parsePublishTimeCell(value);
      saw = true;
    }
  }
  if (!saw) return parseLegacyPublishBlock(grid, sceneHeaderRow);
  return out;
}

function gmtLabelForExport(tz: string): string {
  const t = String(tz || "").trim();
  if (t === PUBLISH_DEFAULT_TZ || /vietnam|ho_chi_minh/i.test(t)) return "Vietnam (GMT+7)";
  if (/bangkok/i.test(t)) return "Bangkok (GMT+7)";
  if (t === "UTC") return "UTC";
  return t || "Vietnam (GMT+7)";
}

function ensureListValidation(cell: ExcelJS.Cell, list: string) {
  if (cell.dataValidation?.type === "list") return;
  cell.dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: [`"${list}"`],
    showErrorMessage: true,
    errorTitle: "Invalid choice",
    error: "Pick a value from the list.",
  };
}

function copyCellVisualStyle(source: ExcelJS.Cell, target: ExcelJS.Cell) {
  if (source.font) target.font = structuredClone(source.font);
  if (source.fill) target.fill = structuredClone(source.fill);
  if (source.border) target.border = structuredClone(source.border);
  if (source.alignment) target.alignment = structuredClone(source.alignment);
  if (source.numFmt) target.numFmt = source.numFmt;
}

function localDateTimeFromIso(iso: string): Date | null {
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0);
}

/** WPS template display, e.g. 13/1/2026 6:30:00 PM */
function formatPublishTimeDisplay(iso: string): string {
  const d = localDateTimeFromIso(iso);
  if (!d) return String(iso).trim();
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${h12}:${pad2(d.getMinutes())}:00 ${ampm}`;
}

function excelSerialToLocalIso(serial: number): string {
  const epoch = new Date(1899, 11, 30);
  const days = Math.floor(serial);
  const frac = serial - days;
  const d = new Date(epoch.getTime() + days * 86400000);
  const seconds = Math.round(frac * 86400000) / 1000;
  d.setSeconds(d.getSeconds() + seconds);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function setPublishTimeCell(cell: ExcelJS.Cell, scheduleAt: string | undefined, schedule: boolean) {
  const numFmt = cell.numFmt;
  if (!schedule) {
    cell.value = null;
  } else {
    const at = scheduleAt?.trim() || "";
    cell.value = at ? formatPublishTimeDisplay(at) : null;
  }
  if (numFmt) cell.numFmt = numFmt;
}

function styleSceneDataRow(ws: ExcelJS.Worksheet, row: number) {
  const ref = SCENE_FIRST_ROW;
  if (row === ref) return;
  copyCellVisualStyle(ws.getCell(`A${ref}`), ws.getCell(`A${row}`));
  copyCellVisualStyle(ws.getCell(`B${ref}`), ws.getCell(`B${row}`));
}

function fillTemplateWorksheet(ws: ExcelJS.Worksheet, film: { rows?: FilmTemplateRow[]; publish?: FilmTemplatePublishMeta }) {
  const meta = film.publish;
  const schedule = meta?.publish_mode === "schedule";
  const hook = String(meta?.caption ?? "").trim();

  ws.getCell("B1").value = hook || HOOK_PLACEHOLDER;
  ws.getCell("B2").value = yesNoDisplay(meta?.youtube);
  ws.getCell("B3").value = yesNoDisplay(meta?.facebook);
  ws.getCell("B4").value = yesNoDisplay(meta?.tiktok);
  ws.getCell("B5").value = schedule ? "Schedule" : "Publish Now";
  ensureListValidation(ws.getCell("B2"), "Yes,No");
  ensureListValidation(ws.getCell("B3"), "Yes,No");
  ensureListValidation(ws.getCell("B4"), "Yes,No");
  ensureListValidation(ws.getCell("B5"), "Publish Now,Schedule");
  ensureListValidation(ws.getCell("B6"), "Vietnam (GMT+7),Bangkok (GMT+7),UTC");

  ws.getRow(ROW_GMT).hidden = false;
  ws.getRow(ROW_PUBLISH_TIME).hidden = false;
  ws.getCell("B6").value = gmtLabelForExport(meta?.schedule_timezone || PUBLISH_DEFAULT_TZ);
  setPublishTimeCell(ws.getCell("B7"), meta?.schedule_at, schedule);

  const scenes = (film.rows?.length ? film.rows : defaultTemplateRows()).filter((r) => Number(r.scene_no) > 0);
  const sceneSlots = Math.max(scenes.length, SCENE_DEFAULT_COUNT);
  for (let i = 0; i < sceneSlots; i++) {
    const row = SCENE_FIRST_ROW + i;
    const sc = scenes[i];
    styleSceneDataRow(ws, row);
    if (sc) {
      ws.getCell(`A${row}`).value = sc.scene_no;
      ws.getCell(`B${row}`).value = sc.prompt || "";
    } else {
      ws.getCell(`A${row}`).value = i + 1;
      ws.getCell(`B${row}`).value = "";
    }
  }
  for (let i = sceneSlots; i < SCENE_CLEAR_SLOTS; i++) {
    const row = SCENE_FIRST_ROW + i;
    ws.getCell(`A${row}`).value = null;
    ws.getCell(`B${row}`).value = null;
  }
}

function cloneTemplateSheet(source: ExcelJS.Worksheet, targetWb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = targetWb.addWorksheet(name);
  ws.model = structuredClone(source.model);
  ws.name = name;
  return ws;
}

/** Build TedVerse full script text from template rows. */
export function filmScriptFromTemplateRows(rows: FilmTemplateRow[]): string {
  const usable = rows
    .map((r) => ({
      scene_no: Number(r.scene_no),
      hook: String(r.hook ?? "").trim(),
      prompt: String(r.prompt ?? "").trim(),
    }))
    .filter((r) => Number.isFinite(r.scene_no) && r.scene_no > 0 && r.prompt);
  if (!usable.length) return "";
  usable.sort((a, b) => a.scene_no - b.scene_no || 0);
  return usable
    .map((r) => {
      const head = `=== SCENE ${String(r.scene_no).padStart(3, "0")} ===`;
      return `${head}\n${r.prompt}`;
    })
    .join("\n\n");
}

/** Hook: first non-empty Hook cell in scenes (legacy), else empty. */
export function hookFromTemplateRows(rows: FilmTemplateRow[]): string {
  const ordered = [...rows].sort((a, b) => a.scene_no - b.scene_no);
  for (const r of ordered) {
    const h = String(r.hook ?? "").trim();
    if (h) return h;
  }
  return "";
}

function sanitizeSheetName(name: string): string {
  const n = String(name || "")
    .trim()
    .replace(/[:\\/?*[\]]/g, "")
    .slice(0, 31);
  return n || "0001";
}

function defaultTemplateRows(count = SCENE_DEFAULT_COUNT): FilmTemplateRow[] {
  return Array.from({ length: count }, (_, i) => ({
    scene_no: i + 1,
    hook: "",
    prompt: "",
  }));
}

function sheetToRows(ws: XLSX.WorkSheet): { rows: FilmTemplateRow[]; warnings: string[] } {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  if (!grid.length) return { rows: [], warnings: [] };

  const headerRow = findSceneHeaderRow(grid);
  if (headerRow < 0) {
    throw new Error(`Missing scene table. Need columns: ${TEMPLATE_HEADERS.join(", ")}.`);
  }

  const headers = (grid[headerRow] as unknown[]).map(normalizeHeader);
  const ixScene = columnIndex(headers, ["scene no", "scene", "no", "stt", "cảnh"]);
  const ixHook = columnIndex(headers, ["hook", "móc", "opening hook"]);
  const ixPrompt = columnIndex(headers, ["prompt", "mô tả", "script"]);
  if (ixScene < 0 || ixPrompt < 0) {
    throw new Error(`Columns not found. Need Scene No and Prompt. Got: ${headers.join(" | ")}`);
  }

  const warnings: string[] = [];
  const rows: FilmTemplateRow[] = [];
  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i] as unknown[];
    if (!row?.length) continue;
    const sceneRaw = row[ixScene];
    const scene_no = Number(String(sceneRaw ?? "").trim().replace(/[^\d]/g, "") || "0");
    const prompt = String(row[ixPrompt] ?? "").trim();
    const hook = ixHook >= 0 ? String(row[ixHook] ?? "").trim() : "";
    if (!Number.isFinite(scene_no) || scene_no < 1) {
      if (prompt) warnings.push(`Row ${i + 1}: skipped — missing Scene No.`);
      continue;
    }
    if (!prompt) continue;
    rows.push({ scene_no, hook, prompt });
  }
  if (!rows.length) throw new Error("No data rows. Fill Scene No and Prompt below the header.");
  return { rows, warnings };
}

function filmNoFromSheetName(sheetName: string): string {
  const sheetNo = String(sheetName).trim();
  if (isFilmNo(sheetNo)) return sheetNo;
  const padded = sheetNo.padStart(4, "0").slice(-4);
  return isFilmNo(padded) ? padded : "";
}

export async function buildFilmTemplateXlsx(opts: { no: string; rows?: FilmTemplateRow[] }): Promise<Buffer> {
  return buildFilmTemplateWorkbook([opts]);
}

export async function buildFilmTemplateWorkbook(
  films: { no: string; rows?: FilmTemplateRow[]; publish?: FilmTemplatePublishMeta }[],
): Promise<Buffer> {
  ensureFilmTemplateFile();
  const tpl = new ExcelJS.Workbook();
  await tpl.xlsx.readFile(TEMPLATE_XLSX);
  const source = tpl.worksheets[0];
  if (!source) throw new Error("Template workbook has no sheets.");

  const out = new ExcelJS.Workbook();
  const usedNames = new Set<string>();
  for (const film of films) {
    const no = isFilmNo(film.no) ? film.no : "0001";
    let sheetName = sanitizeSheetName(no);
    let n = 2;
    while (usedNames.has(sheetName)) {
      sheetName = sanitizeSheetName(`${no}_${n++}`);
    }
    usedNames.add(sheetName);
    const ws = cloneTemplateSheet(source, out, sheetName);
    fillTemplateWorksheet(ws, film);
  }
  const buf = await out.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export type FilmTemplateImport = {
  no: string;
  hook: string;
  script: string;
  rows: FilmTemplateRow[];
  warnings: string[];
  publish?: FilmTemplatePublishMeta;
};

export function parseFilmTemplateSheet(ws: XLSX.WorkSheet, sheetName: string): FilmTemplateImport {
  const no = filmNoFromSheetName(sheetName);
  if (!no) {
    throw new Error(`Sheet name must be the 4-digit film No (e.g. 0001). Got "${sheetName}".`);
  }
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  const sceneHeaderRow = findSceneHeaderRow(grid);
  const publish = sceneHeaderRow >= 0 ? parsePublishFormBlock(grid, sceneHeaderRow) : undefined;
  const { rows, warnings } = sheetToRows(ws);
  const script = filmScriptFromTemplateRows(rows);
  const hookFromForm = String(publish?.caption ?? "").trim();
  const hook = hookFromForm || hookFromTemplateRows(rows);
  if (publish && hookFromForm) publish.caption = hookFromForm;
  return { no, hook, script, rows, warnings, publish };
}

/** @deprecated use parseFilmTemplateWorkbook */
export function parseFilmTemplateXlsx(buf: Buffer): FilmTemplateImport {
  const { films } = parseFilmTemplateWorkbook(buf);
  if (films.length !== 1) {
    throw new Error(`This file has ${films.length} sheets. Use import from the Auto Film list.`);
  }
  return films[0]!;
}

export function parseFilmTemplateWorkbook(buf: Buffer): { films: FilmTemplateImport[]; errors: string[] } {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const names = wb.SheetNames.filter((n) => String(n).trim());
  if (!names.length) throw new Error("The workbook has no sheets.");

  const films: FilmTemplateImport[] = [];
  const errors: string[] = [];
  for (const sheetName of names) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    try {
      films.push(parseFilmTemplateSheet(ws, sheetName));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${sheetName}: ${msg}`);
    }
  }
  if (!films.length) {
    throw new Error(errors.length ? errors.join(" ") : "No valid film sheets found.");
  }
  return { films, errors };
}

export async function exportFilmTemplatePayload(
  opts: {
    no?: string;
    rows?: FilmTemplateRow[];
    publish?: FilmTemplatePublishMeta;
    films?: { no: string; rows?: FilmTemplateRow[]; publish?: FilmTemplatePublishMeta }[];
  } = {},
): Promise<{
  filename: string;
  mime: string;
  data: string;
}> {
  const list =
    opts.films?.length ? opts.films
    : [
        {
          no: isFilmNo(String(opts.no ?? "").trim()) ? String(opts.no).trim() : "0001",
          rows: opts.rows,
          publish: opts.publish,
        },
      ];
  const buf = await buildFilmTemplateWorkbook(list);
  const filename =
    list.length === 1 ? `tedverse-film-${list[0]!.no}.xlsx` : `tedverse-films-${list.length}-sheets.xlsx`;
  return {
    filename,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: buf.toString("base64"),
  };
}

export function importFilmTemplatePayload(data: string): {
  films: FilmTemplateImport[];
  errors: string[];
  filename_hint: string;
} {
  const buf = Buffer.from(data, "base64");
  if (!buf.length) throw new Error("Empty file.");
  const parsed = parseFilmTemplateWorkbook(buf);
  const nos = parsed.films.map((f) => f.no).join("-");
  return {
    ...parsed,
    filename_hint: parsed.films.length === 1 ? `film-${parsed.films[0]!.no}.xlsx` : `films-${nos}.xlsx`,
  };
}