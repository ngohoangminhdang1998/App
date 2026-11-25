import type { PlatformSchedule } from "./types.js";

/** Parts for native date/time pickers — local PC time (same as datetime-local). */
export function scheduleParts(schedule: PlatformSchedule) {
  const d = schedule.at;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    dateIso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeHm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    label: d.toLocaleString(),
  };
}

function partsInTimeZone(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const h = Number(map.hour);
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    h: h === 24 ? 0 : h,
    min: Number(map.minute),
  };
}

/** Wall clock in an IANA zone → UTC `Date`. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) throw new Error("Use YYYY-MM-DDTHH:mm for schedule.");
  const want = { y: +m[1]!, m: +m[2]!, d: +m[3]!, h: +m[4]!, min: +m[5]! };
  let utc = Date.UTC(want.y, want.m - 1, want.d, want.h, want.min);
  for (let i = 0; i < 6; i++) {
    const got = partsInTimeZone(utc, timeZone);
    const gotMs = Date.UTC(got.y, got.m - 1, got.d, got.h, got.min);
    const wantMs = Date.UTC(want.y, want.m - 1, want.d, want.h, want.min);
    const delta = wantMs - gotMs;
    if (Math.abs(delta) < 30_000) break;
    utc += delta;
  }
  return new Date(utc);
}

/** `datetime-local` (YYYY-MM-DDTHH:mm) or ISO; optional IANA zone for API scheduling. */
export function parsePublishSchedule(at: string, timeZone?: string): PlatformSchedule {
  const v = at.trim();
  if (!v) throw new Error("Pick a date and time.");
  let when: Date;
  const tz = timeZone?.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && tz) {
    when = zonedLocalToUtc(v, tz);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    when = new Date(v);
  } else {
    when = new Date(v);
  }
  if (Number.isNaN(when.getTime())) throw new Error("Invalid date and time.");
  if (when.getTime() <= Date.now() + 60_000) throw new Error("Schedule must be at least one minute in the future.");
  return { at: when, timeZone: tz || undefined };
}