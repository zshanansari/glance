/**
 * Quick add: a line such as "Lunch with Sam tomorrow 1pm at Blue Tokai"
 * turned into an event. macOS finds the date (the host's detect_dates); the
 * rest — guests, call, length, place and title — is read here.
 */
import { dateFormat } from "./region";

/** A date the host found, in UTF-16 offsets like a JavaScript string. */
export type DetectedDate = { start: number; length: number; at: number; duration: number };

export type CallKind = "meet" | "zoom" | "teams";

export type QuickDraft = {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location: string | null;
  guests: string[];
  /** A call asked for with words such as "on zoom" or "google meet". */
  call: CallKind | null;
};

/** What Return does with a draft. */
export type QuickAction =
  | { kind: "create"; url: string | null }
  | { kind: "google" };

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CALL =
  /\b(?:(?:on|via|over|in|with)\s+)?(google\s+meet|g\s?meet|zoom|teams|meet)(?:\s+(?:call|meeting|link))?\b/gi;
// "meet" alone is a verb ("Meet Sam"), so it counts only after on/via/over
// or before call/link.
const MEET_ALONE = /^meet$/i;
const LENGTH =
  /\bfor\s+(?:(an?|half an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m))\b|\bfor\s+half\s+an\s+hour\b/i;
const HAS_TIME =
  /\d\s*(?:am|pm|a\.m\.|p\.m\.)|\d:\d\d|\bnoon\b|\bmidnight\b|\btonight\b|\bmorning\b|\bafternoon\b|\bevening\b|\bo'?clock\b/i;
const HAS_DAY =
  /\b(?:today|tonight|tomorrow|tmrw|mon|tue|wed|thu|fri|sat|sun|week|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}[/.-]\d{1,2}|\b\d{1,2}(?:st|nd|rd|th)\b/i;
const DANGLING = /^(?:on|at|for|with|and|from|by|to|in|,|-|–|·)\s+|\s+(?:on|at|for|with|and|from|by|to|in|,|-|–|·)$/i;

function cut(text: string, start: number, length: number): string {
  return `${text.slice(0, start)} ${text.slice(start + length)}`;
}

function tidy(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(DANGLING, "").replace(/^[,·–-]+|[,·–-]+$/g, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function lengthMs(amount: string, unit: string): number {
  const count = /^an?$/i.test(amount) ? 1 : /^half/i.test(amount) ? 0.5 : Number(amount);
  return count * (/^h/i.test(unit) ? HOUR_MS : 60_000);
}

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function addDays(at: number, days: number): number {
  const day = new Date(at);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

/**
 * The event a line describes, or null with no date in it. A time already
 * past today with no day named moves to tomorrow; a date with no time is
 * all day; a timed event lasts an hour unless a range or "for 30m" says.
 */
export function parseQuickEvent(
  input: string,
  dates: readonly DetectedDate[],
  now: number,
): QuickDraft | null {
  const found = dates[0];
  if (!found) return null;
  const matched = input.slice(found.start, found.start + found.length);
  let rest = cut(input, found.start, found.length);

  const guests = [...new Set(rest.match(EMAIL) ?? [])].slice(0, 20);
  rest = rest.replace(EMAIL, " ");

  let call: CallKind | null = null;
  const callMatch = [...rest.matchAll(CALL)].find((match) => !MEET_ALONE.test(match[0].trim()));
  if (callMatch) {
    const word = callMatch[1]!.toLowerCase();
    call = word.includes("zoom") ? "zoom" : word.includes("teams") ? "teams" : "meet";
    rest = cut(rest, callMatch.index ?? 0, callMatch[0].length);
  }

  let length: number | null = null;
  const lengthMatch = LENGTH.exec(rest);
  if (lengthMatch) {
    length = lengthMatch[1] ? lengthMs(lengthMatch[1], lengthMatch[2]!) : 30 * 60_000;
    rest = cut(rest, lengthMatch.index, lengthMatch[0].length);
  }

  // A place follows "at" or "@" and starts with a capital or a digit, so
  // "Look at designs" keeps its words.
  let location: string | null = null;
  const place = /(?:^|\s)(?:at|@)\s+([A-Z0-9][^]*)$/.exec(rest.trim());
  if (place) {
    location = tidy(place[1]!);
    rest = rest.trim().slice(0, place.index);
  }

  const title = tidy(rest) || "New Event";
  const timed = HAS_TIME.test(matched);
  let startAt = timed ? found.at : startOfDay(found.at);
  let endAt: number;
  if (timed) {
    if (startAt < now - 60_000 && !HAS_DAY.test(matched)) startAt = addDays(startAt, 1);
    const span = length ?? (found.duration > 0 ? found.duration * 1000 : HOUR_MS);
    endAt = startAt + Math.min(Math.max(span, 5 * 60_000), 14 * DAY_MS);
  } else {
    const days = Math.max(1, Math.round(found.duration * 1000 / DAY_MS) + 1);
    endAt = addDays(startAt, Math.min(days, 14));
  }
  return { title, startAt, endAt, allDay: !timed, location, guests, call };
}

/**
 * Guests, or a Meet with no room of your own, go to Google Calendar, which
 * sends invitations and makes Meet links. Otherwise the event is created
 * here, with your room attached when a call was asked for.
 */
export function quickAddAction(draft: QuickDraft, meetingLink: string): QuickAction {
  if (draft.guests.length) return { kind: "google" };
  if (draft.call && meetingLink) return { kind: "create", url: meetingLink };
  if (draft.call === "meet") return { kind: "google" };
  return { kind: "create", url: null };
}

function utcStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function localDateStamp(at: number): string {
  const day = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}`;
}

/** Google Calendar's "dates" value: UTC times, or local dates all day. */
export function googleDates(draft: Pick<QuickDraft, "startAt" | "endAt" | "allDay">): string {
  return draft.allDay
    ? `${localDateStamp(draft.startAt)}/${localDateStamp(draft.endAt)}`
    : `${utcStamp(draft.startAt)}/${utcStamp(draft.endAt)}`;
}

/** "Sun 8 Nov, 1:00 – 2:00 PM", "Thu 24 Dec, all day" or "10 – 12 Dec, all day". */
export function quickWhen(draft: Pick<QuickDraft, "startAt" | "endAt" | "allDay">, locale?: string): string {
  const day = dateFormat(locale, { weekday: "short", day: "numeric", month: "short" });
  if (draft.allDay) {
    const lastDay = addDays(draft.endAt, -1);
    if (startOfDay(lastDay) === startOfDay(draft.startAt)) return `${day.format(draft.startAt)}, all day`;
    const short = dateFormat(locale, { day: "numeric", month: "short" });
    return `${short.format(draft.startAt)} – ${short.format(lastDay)}, all day`;
  }
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = startOfDay(draft.startAt) === startOfDay(draft.endAt - 1);
  return sameDay
    ? `${day.format(draft.startAt)}, ${time.formatRange(draft.startAt, draft.endAt)}`
    : `${day.format(draft.startAt)}, ${time.format(draft.startAt)} – ${day.format(draft.endAt)}, ${time.format(draft.endAt)}`;
}
