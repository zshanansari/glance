import type { WeekStartsOn } from "./settings";
import { dateFormat } from "./region";

export type CalendarDay = {
  iso: string;
  year: number;
  month: number;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  weekNumber: number;
};

export type CalendarMonth = {
  year: number;
  month: number;
  label: string;
  weekdayLabels: { short: string; long: string; narrow: string }[];
  weeks: CalendarDay[][];
};

const WEEKDAY_COUNT = 7;
const WEEK_COUNT = 6;

/** Local calendar date at noon, so DST does not skip or duplicate a day. */
export function atNoon(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 12, 0, 0, 0);
}

export function toIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromIso(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return atNoon(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const next = atNoon(year, month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

export function addDays(date: Date, days: number): Date {
  return atNoon(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfMonth(year: number, month: number): Date {
  return atNoon(year, month, 1);
}

export function endOfMonth(year: number, month: number): Date {
  return atNoon(year, month + 1, 0);
}

/**
 * ISO-8601 week number. Week 1 contains the year's first Thursday.
 * Independent of the displayed week start, so the number stays stable
 * when the user switches Sunday/Monday/Saturday.
 */
export function isoWeekNumber(date: Date): number {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const day = new Date(utc).getUTCDay();
  const thursday = new Date(utc);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (day || 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / 86_400_000 / 7) + 1;
}

export function weekdayIndex(date: Date, weekStartsOn: WeekStartsOn): number {
  return (date.getDay() - weekStartsOn + WEEKDAY_COUNT) % WEEKDAY_COUNT;
}

/** "November 2026", in full, for the grid's caption and VoiceOver. */
export function monthTitle(year: number, month: number, locale?: string): string {
  return dateFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(atNoon(year, month, 1));
}

export function weekdayLabels(
  weekStartsOn: WeekStartsOn,
  locale?: string,
): { short: string; long: string; narrow: string }[] {
  const short = dateFormat(locale, { weekday: "short" });
  const long = dateFormat(locale, { weekday: "long" });
  const narrow = dateFormat(locale, { weekday: "narrow" });
  // 5 Jan 2020 is a Sunday, so offsets land on a known weekday.
  return Array.from({ length: WEEKDAY_COUNT }, (_, index) => {
    const date = atNoon(2020, 0, 5 + weekStartsOn + index);
    return {
      short: short.format(date),
      long: long.format(date),
      narrow: narrow.format(date),
    };
  });
}

/**
 * The ISO week a row of the month belongs to: the week of its Monday. The
 * first column is a Sunday or Saturday when the week starts there, and that
 * day still belongs to the ISO week before.
 */
export function rowWeekNumber(
  row: readonly CalendarDay[],
  numbering: "iso" | "us" = "iso",
): number | null {
  if (numbering === "us") return rowUsWeekNumber(row);
  const monday = row.find((day) => new Date(day.year, day.month, day.day).getDay() === 1);
  return (monday ?? row[0])?.weekNumber ?? null;
}

/**
 * The US week number of a date: week 1 holds 1 January, and each week
 * starts on Sunday, so the year's first week may be short.
 */
export function usWeekNumber(date: Date): number {
  const january = new Date(date.getFullYear(), 0, 1);
  const day = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - january.getTime()) /
      86_400_000,
  );
  return Math.floor((day + january.getDay()) / 7) + 1;
}

/**
 * The US week a row belongs to. A row holding 1 January is week 1 of the new
 * year; any other row takes the week of its first day. On a Sunday-first
 * month that is the week's own Sunday. On a Monday-first month the row's
 * Sunday is its last day and already belongs to the next US week, so
 * numbering by it would skip a week: January 2026 would read 1, 3, 4, 5.
 * Six of the row's seven days are in the first day's week, so that is the
 * one the row is labelled with.
 */
export function rowUsWeekNumber(row: readonly CalendarDay[]): number | null {
  if (row.some((day) => day.month === 0 && day.day === 1)) return 1;
  const pick = row[0];
  return pick ? usWeekNumber(new Date(pick.year, pick.month, pick.day)) : null;
}

export function buildMonth(
  year: number,
  month: number,
  weekStartsOn: WeekStartsOn,
  today = new Date(),
  locale?: string,
): CalendarMonth {
  const first = startOfMonth(year, month);
  const gridStart = addDays(first, -weekdayIndex(first, weekStartsOn));
  const todayIso = toIso(today);
  const weeks: CalendarDay[][] = [];

  for (let week = 0; week < WEEK_COUNT; week += 1) {
    const days: CalendarDay[] = [];
    for (let weekday = 0; weekday < WEEKDAY_COUNT; weekday += 1) {
      const date = addDays(gridStart, week * WEEKDAY_COUNT + weekday);
      days.push({
        iso: toIso(date),
        year: date.getFullYear(),
        month: date.getMonth(),
        day: date.getDate(),
        inMonth: date.getMonth() === month,
        isToday: toIso(date) === todayIso,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        weekNumber: isoWeekNumber(date),
      });
    }
    weeks.push(days);
  }

  return {
    year,
    month,
    label: monthTitle(year, month, locale),
    weekdayLabels: weekdayLabels(weekStartsOn, locale),
    weeks,
  };
}

export function dayName(date: Date, locale?: string): string {
  return dateFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Whether the selection should move to today when the clock or an open
 * finds a new day: only when it was on the day the month last showed as
 * today. A day picked on purpose stays picked.
 */
export function selectionFollowsToday(
  renderedToday: string,
  selected: string,
  today: string,
): boolean {
  return renderedToday !== "" && renderedToday !== today && selected === renderedToday;
}

/**
 * Whether the hourly chime is due on this tick: the hour has turned and the
 * clock is at its top. Waking at 11:07 turns the hour too, without a chime.
 */
export function chimeDue(lastHour: number, now: Date): boolean {
  return now.getHours() !== lastHour && now.getMinutes() === 0;
}
