import * as XLSX from "xlsx";
import { isFilmNo } from "./film-numbers.js";

export const TEMPLATE_HEADERS = ["Scene No", "Hook", "Prompt"] as const;

export type FilmTemplateRow = { scene_no: number; hook: string; prompt: string };

function normalizeHeader(cell: unknown): string {
  return String(cell ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function columnIndex(headers: string[], names: string[]): number {
  for (const name of names) {
    const ix = headers.indexOf(name);
    if (ix >= 0) return ix;
  }
  return -1;
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

/** Hook: first non-empty Hook cell (usually scene 1), else empty. */
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

function defaultTemplateRows(count = 5): FilmTemplateRow[] {
  return Array.from({ length: count }, (_, i) => ({
    scene_no: i + 1,
    hook: "",
    prompt: "",
  }));
}

function sheetToRows(ws: XLSX.WorkSheet): { rows: FilmTemplateRow[]; warnings: string[] } {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  if (!grid.length) return { rows: [], warnings: [] };

  let headerRow = 0;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const row = grid[i] as unknown[];
    const normed = row.map(normalizeHeader);
    if (
      columnIndex(normed, ["scene no", "scene", "no", "stt", "cảnh"]) >= 0 &&
      columnIndex(normed, ["prompt"]) >= 0
    ) {
      headerRow = i;
      headers = normed;
      break;
    }
  }
  if (!headers.length) {
    throw new Error(`Missing header row. Need: ${TEMPLATE_HEADERS.join(", ")}.`);
  }

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

export function buildFilmTemplateXlsx(opts: { no: string; rows?: FilmTemplateRow[] }): Buffer {
  return buildFilmTemplateWorkbook([opts]);
}

export function buildFilmTemplateWorkbook(films: { no: string; rows?: FilmTemplateRow[] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  for (const film of films) {
    const no = isFilmNo(film.no) ? film.no : "0001";
    let sheetName = sanitizeSheetName(no);
    let n = 2;
    while (usedNames.has(sheetName)) {
      sheetName = sanitizeSheetName(`${no}_${n++}`);
    }
    usedNames.add(sheetName);
    const rows = (film.rows?.length ? film.rows : defaultTemplateRows()).map((r) => [
      Number(r.scene_no) || 0,
      String(r.hook ?? ""),
      String(r.prompt ?? ""),
    ]);
    const aoa = [TEMPLATE_HEADERS.slice(), ...rows.filter((r) => Number(r[0]) > 0)];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 10 }, { wch: 36 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export type FilmTemplateImport = {
  no: string;
  hook: string;
  script: string;
  rows: FilmTemplateRow[];
  warnings: string[];
};

export function parseFilmTemplateSheet(ws: XLSX.WorkSheet, sheetName: string): FilmTemplateImport {
  const no = filmNoFromSheetName(sheetName);
  if (!no) {
    throw new Error(`Sheet name must be the 4-digit film No (e.g. 0001). Got "${sheetName}".`);
  }
  const { rows, warnings } = sheetToRows(ws);
  const script = filmScriptFromTemplateRows(rows);
  const hook = hookFromTemplateRows(rows);
  return { no, hook, script, rows, warnings };
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
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
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

export function exportFilmTemplatePayload(
  opts: { no?: string; rows?: FilmTemplateRow[]; films?: { no: string; rows?: FilmTemplateRow[] }[] } = {},
): {
  filename: string;
  mime: string;
  data: string;
} {
  const list =
    opts.films?.length ? opts.films
    : [{ no: isFilmNo(String(opts.no ?? "").trim()) ? String(opts.no).trim() : "0001", rows: opts.rows }];
  const buf = buildFilmTemplateWorkbook(list);
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