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

/** `datetime-local` (YYYY-MM-DDTHH:mm) or ISO — always this machine's local timezone (platform UI matches). */
export function parsePublishSchedule(at: string): PlatformSchedule {
  const v = at.trim();
  if (!v) throw new Error("Pick a date and time.");
  let when: Date;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    when = new Date(v);
  } else {
    when = new Date(v);
  }
  if (Number.isNaN(when.getTime())) throw new Error("Invalid date and time.");
  if (when.getTime() <= Date.now() + 60_000) throw new Error("Schedule must be at least one minute in the future.");
  return { at: when };
}