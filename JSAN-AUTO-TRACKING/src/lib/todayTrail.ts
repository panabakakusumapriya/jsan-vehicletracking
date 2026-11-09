import { Directory, File, Paths } from 'expo-file-system';

/**
 * Today's green lines, kept on the phone until midnight.
 *
 * The green breadcrumb used to be the CURRENT trip only, held in memory: a break of a few minutes
 * ends the trip, and an app restart clears memory — either way the lines the driver had been
 * working from vanished, and they could no longer tell which streets they had just done (driver
 * feedback, 9 Nov 2026). Now every trip of the day keeps its line, saved per driver and per local
 * date, and is drawn until the date changes.
 *
 * File-backed like localSnapStore (expo-file-system v19 object API). Display only: nothing here
 * feeds the figures, which come from the server.
 */

export type Line = [number, number][];
export interface TodayTrail {
  /** Local date (YYYY-MM-DD) the lines belong to. */
  date: string;
  /** Earlier trips of the day, oldest first. */
  lines: Line[];
}

const ROOT_DIR_NAME = 'jsan-map';
/** A day of driving at ~11 m spacing, with room to spare; past this the oldest points go first. */
export const MAX_DAY_POINTS = 12_000;

/** The phone's local date, YYYY-MM-DD. */
export const localDate = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function file(driverId: string): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, `today-trail-${driverId.replace(/[^\w-]/g, '_').slice(0, 64)}.json`);
  } catch {
    return null;
  }
}

/** Today's earlier lines for this driver; empty on a new day, another driver, or no file. */
export function loadTodayTrail(driverId: string | null): TodayTrail {
  const today = localDate();
  if (!driverId) return { date: today, lines: [] };
  try {
    const f = file(driverId);
    if (f && f.exists) {
      const saved = JSON.parse(f.textSync()) as TodayTrail;
      if (saved && saved.date === today && Array.isArray(saved.lines)) {
        return { date: today, lines: saved.lines.filter((l) => Array.isArray(l) && l.length >= 2) };
      }
    }
  } catch {
    /* unreadable: start the day's lines afresh — only the display is affected */
  }
  return { date: today, lines: [] };
}

export function saveTodayTrail(driverId: string | null, trail: TodayTrail): void {
  if (!driverId) return;
  try {
    const f = file(driverId);
    if (!f) return;
    if (!f.exists) f.create();
    f.write(JSON.stringify(trail));
  } catch {
    /* not saved this time — the lines are still on screen */
  }
}

/** Keep the day under MAX_DAY_POINTS, dropping the oldest points first. Mutates and returns `lines`. */
export function capDay(lines: Line[], current: Line): Line[] {
  let total = lines.reduce((n, l) => n + l.length, 0) + current.length;
  while (total > MAX_DAY_POINTS && lines.length) {
    const first = lines[0];
    const drop = Math.min(first.length, total - MAX_DAY_POINTS);
    first.splice(0, drop);
    total -= drop;
    if (first.length < 2) {
      total -= first.length;
      lines.shift();
    }
  }
  return lines;
}
