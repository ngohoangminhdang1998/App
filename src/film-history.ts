import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { getComposition } from "./flow-composition.js";
import { ensureFilmSerialNext, filmFinalSceneName, formatFilmNo, isFilmNo, listFilmNumbers } from "./film-numbers.js";
import { buildPublishHistory, type HistoryPlatformCell, type PublishHistoryRow } from "./publish-history.js";
import { guessDefaultVideo } from "./publish.js";

const FILE = join(HOME_DIR, "film-history.json");

export type FilmHistoryEntry = {
  no: string;
  hook: string;
  created_at: string;
  video_path?: string;
};

export type FilmHistoryRow = FilmHistoryEntry & {
  video_path?: string;
  tiktok: HistoryPlatformCell;
  youtube: HistoryPlatformCell;
  facebook: HistoryPlatformCell;
};

type Store = { films: FilmHistoryEntry[]; suppressed?: string[] };

function load(): Store {
  try {
    if (!existsSync(FILE)) return { films: [] };
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Store;
    const films = Array.isArray(raw.films) ? raw.films.filter((f) => isFilmNo(f.no)) : [];
    const suppressed = Array.isArray(raw.suppressed)
      ? [...new Set(raw.suppressed.map((n) => String(n).trim()).filter(isFilmNo))]
      : [];
    return { films, suppressed };
  } catch {
    return { films: [] };
  }
}

function suppressedSet(s: Store): Set<string> {
  return new Set(s.suppressed ?? []);
}

function persist(s: Store): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}

/** Pull in rows from film-numbers.json that are not in history yet (no hook). */
export function syncFilmHistoryFromNumbers(): void {
  const s = load();
  const suppressed = suppressedSet(s);
  const have = new Set(s.films.map((f) => f.no));
  let changed = false;
  for (const f of listFilmNumbers().films) {
    const no = String(f.no).trim();
    if (!isFilmNo(no) || have.has(no) || suppressed.has(no)) continue;
    s.films.push({ no, hook: "", created_at: f.created_at || new Date().toISOString() });
    have.add(no);
    changed = true;
  }
  if (changed) persist(s);
}

const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const filmOutputDir = (no: string) => resolve(OUTPUT_ROOT, no.replace(/[^\w.-]+/g, "_"));

export function resolveFilmVideoPath(no: string): string | undefined {
  const batch = String(no).trim();
  if (!isFilmNo(batch)) return undefined;
  const s = load();
  const stored = s.films.find((f) => f.no === batch)?.video_path;
  if (stored && existsSync(stored)) return stored;
  const comp = getComposition(batch);
  if (comp?.cached_video_path && existsSync(comp.cached_video_path)) return comp.cached_video_path;
  const dir = filmOutputDir(batch);
  const guess = guessDefaultVideo(dir, batch);
  if (guess && existsSync(guess)) return guess;
  const finalName = filmFinalSceneName(batch).replace(/[^\w.-]+/g, "_");
  const byFinal = join(dir, `${finalName}.mp4`);
  if (existsSync(byFinal)) return byFinal;
  return undefined;
}

export function recordFilmMerge({
  no,
  hook,
  video_path,
}: {
  no: string;
  hook?: string;
  video_path?: string;
}): FilmHistoryEntry {
  const batch = String(no).trim();
  if (!isFilmNo(batch)) {
    throw new Error(`Film history needs a 4-digit No (got "${no}").`);
  }
  const s = load();
  const text = String(hook ?? "").trim();
  const created_at = new Date().toISOString();
  const ix = s.films.findIndex((f) => f.no === batch);
  const prev = ix >= 0 ? s.films[ix] : undefined;
  const path =
    video_path && existsSync(video_path)
      ? video_path
      : resolveFilmVideoPath(batch) ?? (prev?.video_path && existsSync(prev.video_path) ? prev.video_path : undefined);
  const row: FilmHistoryEntry = {
    no: batch,
    hook: text || (ix >= 0 ? s.films[ix]!.hook : ""),
    created_at,
    ...(path ? { video_path: path } : {}),
  };
  if (ix >= 0) s.films[ix] = { ...s.films[ix]!, ...row };
  else s.films.push(row);
  s.suppressed = (s.suppressed ?? []).filter((n) => n !== batch);
  persist(s);
  return row;
}

/** Remove history rows only (not output files). Suppressed nos stay hidden until the next merge for that no. */
export function deleteFilmHistory(opts: { all?: boolean; nos?: string[] }): { deleted: number; remaining: number } {
  const s = load();
  const suppressed = suppressedSet(s);
  const before = s.films.length;

  if (opts.all) {
    for (const f of s.films) suppressed.add(f.no);
    for (const f of listFilmNumbers().films) {
      const no = String(f.no).trim();
      if (isFilmNo(no)) suppressed.add(no);
    }
    s.films = [];
    s.suppressed = [...suppressed];
    persist(s);
    return { deleted: before, remaining: 0 };
  }

  const want = new Set((opts.nos ?? []).map((n) => String(n).trim()).filter(isFilmNo));
  if (!want.size) {
    throw new Error('Pick rows to delete, or send all: true to clear the list.');
  }
  s.films = s.films.filter((f) => !want.has(f.no));
  for (const no of want) suppressed.add(no);
  s.suppressed = [...suppressed];
  persist(s);
  return { deleted: before - s.films.length, remaining: s.films.length };
}

function matchPublish(no: string, rows: PublishHistoryRow[]): PublishHistoryRow | undefined {
  return rows.find((r) => {
    const p = String(r.project || "").trim();
    if (!p) return false;
    if (p === no) return true;
    if (p.endsWith(`/${no}`) || p.endsWith(`\\${no}`)) return true;
    const base = p.split(/[/\\]/).pop();
    if (base === no) return true;
    return false;
  });
}

const EMPTY_PLAT: Record<"tiktok" | "youtube" | "facebook", HistoryPlatformCell> = {
  tiktok: "—",
  youtube: "—",
  facebook: "—",
};

/** Highest 4-digit film serial known from history + film-numbers registry. */
export function maxKnownFilmSerial(): number {
  syncFilmHistoryFromNumbers();
  const hist = load();
  const reg = listFilmNumbers();
  let max = 0;
  for (const f of hist.films) {
    const n = Number(String(f.no).trim());
    if (isFilmNo(f.no) && Number.isFinite(n)) max = Math.max(max, n);
  }
  for (const f of reg.films) {
    const n = Number(String(f.no).trim());
    if (isFilmNo(f.no) && Number.isFinite(n)) max = Math.max(max, n);
  }
  if (Number.isFinite(reg.next) && reg.next > 1) max = Math.max(max, reg.next - 1);
  return max;
}

/** Next No for a new batch: max(history) + 1; does not register the batch until merge. */
export function nextFilmNoFromHistory(): { no: string; next: number } {
  const serial = maxKnownFilmSerial() + 1;
  const { next } = ensureFilmSerialNext(serial + 1);
  return { no: formatFilmNo(serial), next };
}

export function buildFilmHistory(limit = 100): FilmHistoryRow[] {
  syncFilmHistoryFromNumbers();
  const publishRows = buildPublishHistory(500);
  const films = load().films.slice();
  films.sort((a, b) => Number(b.no) - Number(a.no) || b.created_at.localeCompare(a.created_at));
  return films.slice(0, limit).map((e) => {
    const pub = matchPublish(e.no, publishRows);
    const video_path = resolveFilmVideoPath(e.no) ?? (e.video_path && existsSync(e.video_path) ? e.video_path : undefined);
    return {
      ...e,
      video_path,
      tiktok: pub?.tiktok ?? EMPTY_PLAT.tiktok,
      youtube: pub?.youtube ?? EMPTY_PLAT.youtube,
      facebook: pub?.facebook ?? EMPTY_PLAT.facebook,
    };
  });
}