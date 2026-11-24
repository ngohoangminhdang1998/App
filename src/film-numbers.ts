import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

const FILE = join(HOME_DIR, "film-numbers.json");

export type FilmNumberEntry = {
  no: string;
  created_at: string;
  tedverse_project?: string;
};

type Store = {
  /** Next serial to hand out (1 → 0001). */
  next: number;
  films: FilmNumberEntry[];
};

function load(): Store {
  try {
    if (!existsSync(FILE)) return { next: 1, films: [] };
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Store;
    if (typeof raw.next !== "number" || !Array.isArray(raw.films)) return { next: 1, films: [] };
    const maxFromList = raw.films.reduce((m, f) => {
      const n = Number(String(f.no).replace(/\D/g, ""));
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    if (maxFromList >= raw.next) raw.next = maxFromList + 1;
    return raw;
  } catch {
    return { next: 1, films: [] };
  }
}

function persist(s: Store): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function formatFilmNo(serial: number): string {
  return String(serial).padStart(4, "0");
}

export function isFilmNo(project: string): boolean {
  return /^\d{4}$/.test(String(project || "").trim());
}

/** Flow tile title for a scene in batch `no`, e.g. 0001-3. */
export function filmClipFlowTitle(filmNo: string, sceneNumber: number): string {
  const no = String(filmNo).trim();
  return `${no}-${sceneNumber}`;
}

/** Flow scene title after merge — e.g. 0001-Final; non-film projects keep "Final". */
export function filmFinalSceneName(projectOrNo: string): string {
  const p = String(projectOrNo || "").trim();
  return isFilmNo(p) ? `${p}-Final` : "Final";
}

/** Prefix typed into Flow's asset search when adding clips (0001 finds 0001-1, 0001-2…). */
export function filmClipSearchPrefix(flowTitle: string): string | undefined {
  const m = String(flowTitle).trim().match(/^(\d{4})-\d+/);
  return m?.[1];
}

export function peekFilmNo(): { no: string; next: number; films: FilmNumberEntry[] } {
  const s = load();
  return { no: formatFilmNo(s.next), next: s.next, films: s.films };
}

export function allocateFilmNo(tedverse_project?: string): { no: string; next: number; films: FilmNumberEntry[] } {
  const s = load();
  const no = formatFilmNo(s.next);
  s.films.push({ no, created_at: new Date().toISOString(), tedverse_project: tedverse_project?.trim() || no });
  s.next += 1;
  persist(s);
  return { no, next: s.next, films: s.films };
}

export function listFilmNumbers(): { next: number; films: FilmNumberEntry[] } {
  const s = load();
  return { next: s.next, films: s.films };
}

/** Keep the allocator at or above `minNext` (e.g. after the UI bumps 0001 → 0002, pass 3). */
export function ensureFilmSerialNext(minNext: number): { next: number } {
  const s = load();
  const m = Math.max(1, Math.floor(minNext));
  if (s.next < m) s.next = m;
  persist(s);
  return { next: s.next };
}