import { ICON_LEAD_ALWAYS, ICON_LEAD_AT_START, type AppSettings } from "./settings";
import { dateFormat } from "./region";

/** How the user answered the invitation; "confirmed" means no invitation. */
export type EventResponse =
  | "confirmed"
  | "accepted"
  | "tentative"
  | "declined"
  | "pending";

export type EventKind = "event" | "reminder";

export type UpcomingEvent = {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  calendar: string | null;
  /** The calendar's color as `#rrggbb`. */
  color: string | null;
  location: string | null;
  joinUrl: string | null;
  response: EventResponse;
  kind: EventKind;
  allDay: boolean;
  /** Whether anyone else was invited. Reminders and solo blocks are false. */
  hasParticipants: boolean;
};

/**
 * One order for events everywhere: by start, then end, then name. Meetings at
 * the same time then sit in the same order in the day list as the menu bar
 * picks from, rather than in whatever order Calendar returned them.
 */
export function compareEvents(
  a: Pick<UpcomingEvent, "startAt" | "endAt" | "title" | "id">,
  b: Pick<UpcomingEvent, "startAt" | "endAt" | "title" | "id">,
): number {
  return (
    a.startAt - b.startAt ||
    a.endAt - b.endAt ||
    a.title.localeCompare(b.title) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** How soon a meeting must start to take over from one already running. */
export const SOON_MS = 10 * 60_000;

/**
 * The event to count down to among `events`, all still to finish: the first
 * by `compareEvents`, unless that one is already running and will still be
 * running when another starts within `SOON_MS`. A long block such as
 * "Focus time" then gives way to the meeting about to start inside it.
 */
export function leadEvent<T extends Pick<UpcomingEvent, "startAt" | "endAt" | "title" | "id">>(
  events: readonly T[],
  now: number,
): T | null {
  const sorted = [...events].sort(compareEvents);
  const first = sorted[0];
  if (!first || first.startAt > now) return first ?? null;
  const soon = sorted.find(
    (event) =>
      event.startAt > now && event.startAt - now <= SOON_MS && first.endAt > event.startAt,
  );
  return soon ?? first;
}

/**
 * Everything that touches a local day, for the dots under it and the list
 * below the month. All-day items lead, then the rest in `compareEvents` order.
 */
export function eventsOnDay(events: UpcomingEvent[], day: Date): UpcomingEvent[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return events
    .filter((event) => event.startAt < end && event.endAt > start)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || compareEvents(a, b));
}

/**
 * The day list's countdown: the first timed event still to finish, and every
 * other one that reads the same, so two meetings ending at 5:00 both say
 * "5m left" and two starting at 7:00 both say "in 25m".
 */
export function countdownEvents(
  events: readonly UpcomingEvent[],
  now: number,
): UpcomingEvent[] {
  const live = events
    .filter((event) => !event.allDay && event.endAt > now && event.response !== "declined")
    .sort(compareEvents);
  const lead = leadEvent(live, now);
  if (!lead) return [];
  const label = eventStatus(lead, now).label;
  return live.filter((event) => eventStatus(event, now).label === label);
}

/**
 * Today's finished timed meetings, to fold into one "2 earlier" line. A
 * single one is left in place: folding it would save no room and cost a
 * click. All-day items never fold.
 */
export function pastToFold(events: readonly UpcomingEvent[], now: number): UpcomingEvent[] {
  const past = events.filter((event) => !event.allDay && event.endAt <= now);
  return past.length >= 2 ? past : [];
}

/**
 * The rows of a day's list that say how soon, matching the menu bar: the
 * meeting it counts down to and any that read the same. A dismissed meeting
 * says nothing, and neither does a declined one: the menu bar never counts
 * to a meeting the user is not going to. When the menu bar counts to nothing
 * on this list (it is off, or its meeting is on another day), the list
 * finds its own.
 */
export function dayCountdownEvents(
  events: readonly UpcomingEvent[],
  now: number,
  tracked: UpcomingEvent | null,
  dismissed: readonly DismissedOccurrence[] = [],
): UpcomingEvent[] {
  const live = events.filter(
    (event) =>
      !event.allDay &&
      event.endAt > now &&
      event.response !== "declined" &&
      !occurrenceIsDismissed(event, dismissed, now),
  );
  if (tracked && tracked.endAt > now) {
    const label = eventStatus(tracked, now).label;
    const group = live
      .filter((event) => eventStatus(event, now).label === label)
      .sort(compareEvents);
    if (group.some((event) => event.id === tracked.id && event.endAt === tracked.endAt)) {
      return group;
    }
  }
  return countdownEvents(live, now);
}

export type TimeRange = { start: number; end: number };

/**
 * The fewest reads that cover every range: overlapping or touching ranges
 * merge into one, and ones far apart stay apart, so looking at a month a
 * year away does not read the whole year in between.
 */
export function coveringRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/** Whether an event touches a range. */
export function eventOverlaps(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  range: TimeRange,
): boolean {
  return event.startAt < range.end && event.endAt > range.start;
}

/** Local midnight that closes the day `days - 1` days after today. */
export function endOfDay(now: number, days: number): number {
  const boundary = new Date(now);
  boundary.setHours(0, 0, 0, 0);
  boundary.setDate(boundary.getDate() + Math.max(1, Math.trunc(days)));
  return boundary.getTime();
}

/** Local midnight that closes today. */
export function endOfToday(now = new Date()): number {
  return endOfDay(now.getTime(), 1);
}

/** When the countdown's look-ahead ends. */
export function upcomingHorizonEnd(now: number, days: number): number {
  return endOfDay(now, days);
}

/**
 * Ongoing events stay visible. Future ones only appear when they start
 * within the look-ahead, so a meeting tomorrow night does not occupy the
 * menu bar all day.
 */
export function eventInUpcomingHorizon(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now: number,
  days: number,
): boolean {
  if (event.endAt <= now) return false;
  return event.startAt <= upcomingHorizonEnd(now, days);
}

/** The include-events switches the countdown reads. */
export type EventFilters = Pick<
  AppSettings,
  | "includeEventsWithoutParticipants"
  | "includeEventsWithoutLocation"
>;

export type FilterableEvent = Pick<
  UpcomingEvent,
  "hasParticipants" | "location" | "joinUrl" | "response"
>;

/**
 * Whether an event survives the include filters. Declined invitations are a
 * hard rule rather than a switch: they never reach the menu bar.
 */
export function eventPassesFilters(
  event: FilterableEvent,
  filters: EventFilters,
): boolean {
  if (event.response === "declined") return false;
  if (!event.hasParticipants && !filters.includeEventsWithoutParticipants) {
    return false;
  }
  const placed = Boolean(event.joinUrl) || Boolean(event.location);
  if (!placed && !filters.includeEventsWithoutLocation) return false;
  return true;
}

const MINUTE_MS = 60_000;

/**
 * Timed options show from that lead until the event ends. The at-start
 * sentinel holds the item back until the event is running.
 */
export function eventInIconLead(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now: number,
  minutes: number,
): boolean {
  if (event.endAt <= now) return false;
  if (minutes === ICON_LEAD_AT_START) return event.startAt <= now;
  return event.startAt <= now + minutes * MINUTE_MS;
}

/** How far ahead of now the host must fetch to satisfy the window and lead. */
export function upcomingFetchEnd(
  now: number,
  days: number,
  leadMinutes: number,
): number {
  const lead = leadMinutes > ICON_LEAD_AT_START ? now + leadMinutes * MINUTE_MS : now;
  return Math.max(upcomingHorizonEnd(now, days), lead);
}

export type DismissedOccurrence = {
  id: string;
  endAt: number;
};

/**
 * One occurrence of an event: a repeating meeting shares its id across
 * days, so the start tells this one apart.
 */
export function occurrenceKey(event: Pick<UpcomingEvent, "id" | "startAt">): string {
  return `${event.id}@${event.startAt}`;
}

export function occurrenceIsDismissed(
  event: Pick<UpcomingEvent, "id" | "endAt">,
  dismissed: readonly DismissedOccurrence[],
  now: number,
): boolean {
  return dismissed.some(
    (item) => item.id === event.id && item.endAt === event.endAt && item.endAt > now,
  );
}

/**
 * Whether the events menu bar icon should count this item down.
 */
export function eventQualifiesForIcon(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now: number,
  days: number,
  leadMinutes: number,
): boolean {
  if (leadMinutes === ICON_LEAD_ALWAYS) return eventInUpcomingHorizon(event, now, days);
  return eventInIconLead(event, now, leadMinutes);
}

/**
 * The include filters decide the candidates; the lead decides when to show.
 * All-day items never count down, whatever the filters say: a birthday would
 * hold the countdown at "now" all day.
 */
export function trayIconEvent(
  events: readonly UpcomingEvent[],
  now: number,
  options: {
    upcomingHorizonDays: number;
    upcomingIconLeadMinutes: number;
    filters: EventFilters;
    dismissed?: readonly DismissedOccurrence[];
  },
): UpcomingEvent | null {
  const dismissed = options.dismissed ?? [];
  const candidates = events.filter(
    (event) =>
      !event.allDay &&
      eventPassesFilters(event, options.filters) &&
      !occurrenceIsDismissed(event, dismissed, now) &&
      eventQualifiesForIcon(
        event,
        now,
        options.upcomingHorizonDays,
        options.upcomingIconLeadMinutes,
      ),
  );
  return leadEvent(candidates, now);
}

export type EventTiming = "upcoming" | "ongoing";

function roundedMinutes(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 60_000));
}

/** An event that just started reads "now" rather than counting itself down. */
const NOW_WINDOW_MS = 10 * 60_000;

/**
 * A countdown as short as it can be and still be right: "25m" under an hour,
 * "2h 21m" under a day, then days and hours ("2d 5h"), which only change
 * once an hour when a meeting is that far off.
 */
function relativeTime(milliseconds: number): string {
  const minutes = roundedMinutes(milliseconds);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

export function eventStatus(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now = Date.now(),
): { label: string; timing: EventTiming } {
  if (now >= event.endAt) {
    return { label: "ended", timing: "upcoming" };
  }
  if (now >= event.startAt && now < event.endAt) {
    if (now - event.startAt < NOW_WINDOW_MS) {
      return { label: "now", timing: "ongoing" };
    }
    return {
      label: `${relativeTime(event.endAt - now)} left`,
      timing: "ongoing",
    };
  }
  return {
    label: `in ${relativeTime(event.startAt - now)}`,
    timing: "upcoming",
  };
}

export function spokenDuration(milliseconds: number): string {
  const minutes = roundedMinutes(milliseconds);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (!hours) return unit(rest, "minute");
  return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour");
}

/**
 * The countdown in words, for VoiceOver and the tooltip: "starts in 1 hour
 * 10 minutes" where the menu bar shows "in 1h 10m".
 */
export function spokenStatus(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now: number,
): string {
  if (now >= event.endAt) return "has ended";
  if (now >= event.startAt) {
    if (now - event.startAt < NOW_WINDOW_MS) return "has just started";
    return `ends in ${spokenDuration(event.endAt - now)}`;
  }
  return `starts in ${spokenDuration(event.startAt - now)}`;
}

/**
 * What the menu bar item says to VoiceOver and in its tooltip: the full
 * date, then the meeting being counted down, which the item itself only
 * shows as a short countdown.
 */
export function trayDescription(
  now: number,
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "title"> | null,
  locale?: string,
): string {
  const date = dateFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(now));
  if (!event || now >= event.endAt) return date;
  return `${date}. ${event.title.trim() || "Untitled event"} ${spokenStatus(event, now)}`;
}

/**
 * Longest event name the menu bar item carries before it is cut short. At
 * the battery-size title, 28 characters take the room 24 used to.
 */
export const TRAY_TITLE_LIMIT = 28;

export function trayEventTitle(title: string, limit = TRAY_TITLE_LIMIT): string {
  const trimmed = title.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

/** The start time, or how the event reads once it is running. */
export function trayEventTime(
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "allDay">,
  now: number,
  locale?: string,
): string {
  // Once it starts, the countdown beside the date already says how long is
  // left, so the time would only repeat it.
  if (now >= event.startAt) return "";
  if (event.allDay) return "All day";
  return dateFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(event.startAt));
}

/**
 * Native text beside the countdown glyph. Time leads, then the name. Null
 * when both switches are off, which keeps today's glyph-only item.
 */
export function trayEventText(
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "allDay" | "title">,
  now: number,
  options: { showTitle: boolean; showTime: boolean },
  locale?: string,
): string | null {
  const parts: string[] = [];
  if (options.showTime) parts.push(trayEventTime(event, now, locale));
  if (options.showTitle) parts.push(trayEventTitle(event.title));
  const text = parts.filter((part) => part.length > 0).join("  ");
  return text.length ? text : null;
}

/** Most rows the coming days add under today, so the popover stays short. */
export const COMING_ROWS = 8;

/**
 * The days after today and their events, for the list under today's: up to
 * `days` days, skipping empty ones, and no more than COMING_ROWS events in
 * all. All-day items lead each day, as they do in the day list.
 */
export function comingDayGroups(
  events: readonly UpcomingEvent[],
  now: number,
  days: number,
): { day: Date; events: UpcomingEvent[] }[] {
  const groups: { day: Date; events: UpcomingEvent[] }[] = [];
  let rows = 0;
  const today = new Date(now);
  for (let offset = 1; offset <= days && rows < COMING_ROWS; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const onDay = eventsOnDay([...events], day).slice(0, COMING_ROWS - rows);
    if (!onDay.length) continue;
    groups.push({ day, events: onDay });
    rows += onDay.length;
  }
  return groups;
}

/** "Tomorrow", or the weekday and date further out: "Mon 9 Nov". */
export function comingDayTitle(day: Date, now: number, locale?: string): string {
  if (day.getTime() < endOfDay(now, 2)) return "Tomorrow";
  return dateFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(day);
}

/**
 * The first timed event after today, for a day list with nothing left on
 * it. Declined invitations are skipped, as the countdown skips them.
 */
export function nextAfterToday(
  events: readonly UpcomingEvent[],
  now: number,
): UpcomingEvent | null {
  const tomorrow = endOfDay(now, 1);
  return (
    events
      .filter((event) => !event.allDay && event.response !== "declined" && event.startAt >= tomorrow)
      .sort(compareEvents)[0] ?? null
  );
}

/**
 * When that next event is, for the line under an empty day: "Tomorrow,
 * 11:45 AM", the weekday and time ("Mon, 11:45 AM") within the week, and
 * the date as well past it ("Tue 17 Nov, 11:45 AM"): a bare "Tue" nine days
 * out reads as this coming Tuesday.
 */
export function nextEventWhen(
  event: Pick<UpcomingEvent, "startAt">,
  now: number,
  locale?: string,
): string {
  const start = new Date(event.startAt);
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" }).format(start);
  const day =
    start.getTime() < endOfDay(now, 2)
      ? "Tomorrow"
      : start.getTime() < endOfDay(now, 7)
        ? dateFormat(locale, { weekday: "short" }).format(start)
        : comingDayTitle(start, now, locale);
  return `${day}, ${time}`;
}

/**
 * The menu bar item's title: the date (unless the cutout glyph carries it),
 * then "• in 25m" for the event being counted down, then its time and name
 * when Settings asks for them. Empty for a glyph-only item.
 */
export function trayTitle(
  dateText: string | null,
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "allDay" | "title"> | null,
  now: number,
  options: { showTitle: boolean; showTime: boolean },
  locale?: string,
  afterGlyph = false,
): string {
  // Beside a glyph, a date gets the same bullet the countdown does, so the
  // glyph, the date and the countdown read as three separate parts.
  const date = dateText ? (afterGlyph ? `\u2022 ${dateText}` : dateText) : "";
  const countdown = event && now < event.endAt ? eventStatus(event, now).label : null;
  if (!countdown || !event) return date;
  const eventText = trayEventText(event, now, options, locale);
  // The bullet always leads the countdown, with or without a date before it,
  // so "• in 25m" reads as Glance's own mark beside the glyph.
  const tail = [`\u2022 ${countdown}`, eventText].filter(Boolean).join(" ");
  return date ? `${date} ${tail}` : tail;
}

export function eventTimeRange(
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "allDay">,
  locale?: string,
): string {
  if (event.allDay) return "All day";
  const format = dateFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${format.format(new Date(event.startAt))} – ${format.format(
    new Date(event.endAt),
  )}`;
}

/**
 * How long before a meeting the reminder card appears. The clock ticks just
 * past each minute, so one minute out lands on the tick before the start; the
 * slack keeps a tick that runs a little late from missing it.
 */
export const REMINDER_LEAD_MS = 61_000;
/**
 * How far ahead the card comes for a meeting in a room: time to get there.
 * The same slack as above.
 */
export const IN_PERSON_LEAD_MS = 10 * MINUTE_MS + 1_000;
/** How long the card stays once the meeting has started, if left alone. */
export const REMINDER_LINGER_MS = 5 * MINUTE_MS;

/**
 * Anyone can put an invitation on a calendar, so one nobody has answered
 * gives way to an answered meeting at the same time: the card and the Join
 * shortcut open the meeting the user said yes to. With nothing answered
 * alongside it, the invitation is still offered.
 */
function preferAnswered(
  best: UpcomingEvent | null,
  candidates: readonly UpcomingEvent[],
): UpcomingEvent | null {
  if (!best || best.response !== "pending") return best;
  const answered = candidates
    .filter(
      (event) =>
        event.response !== "pending" &&
        event.startAt < best.endAt &&
        event.endAt > best.startAt,
    )
    .sort(compareEvents);
  return answered[0] ?? best;
}

/**
 * A meeting with a place and no join link: somewhere to go, not a call. A
 * location that is itself a web address is not a place.
 */
export function isInPerson(event: Pick<UpcomingEvent, "joinUrl" | "location">): boolean {
  const place = event.location?.trim() ?? "";
  return !event.joinUrl && place !== "" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(place);
}

/**
 * The meeting to remind about now: timed, with a join link, not declined or
 * dismissed, and starting within the lead. One that started a few minutes
 * ago still qualifies when it was never offered, as when the month was open
 * at its minute. A meeting about to start comes before one already running;
 * otherwise the earliest start wins, and an answered meeting beats an
 * unanswered invitation at the same time. With `inPerson`, a meeting in a
 * room counts too, from ten minutes out.
 */
export function reminderEvent(
  events: readonly UpcomingEvent[],
  now: number,
  dismissed: readonly DismissedOccurrence[] = [],
  offered: (event: UpcomingEvent) => boolean = () => false,
  inPerson = false,
): UpcomingEvent | null {
  let best: UpcomingEvent | null = null;
  const candidates: UpcomingEvent[] = [];
  const rank = (event: UpcomingEvent): number => (event.startAt > now ? 0 : 1);
  for (const event of events) {
    const room = inPerson && isInPerson(event);
    if (event.allDay || (!event.joinUrl && !room) || event.response === "declined") continue;
    if (occurrenceIsDismissed(event, dismissed, now) || offered(event)) continue;
    const until = event.startAt - now;
    const lead = room ? IN_PERSON_LEAD_MS : REMINDER_LEAD_MS;
    if (until > lead || !reminderStillDue(event, now)) continue;
    candidates.push(event);
    if (
      !best ||
      rank(event) < rank(best) ||
      (rank(event) === rank(best) && compareEvents(event, best) < 0)
    ) {
      best = event;
    }
  }
  return preferAnswered(best, candidates);
}

/** Whether a reminder shown for this meeting should still be on screen. */
export function reminderStillDue(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now: number,
): boolean {
  return now < Math.min(event.startAt + REMINDER_LINGER_MS, event.endAt);
}

/**
 * The meeting the Join shortcut opens: one under way with a link, or else
 * the next one today. Declined invitations are skipped, and an unanswered
 * one gives way to an answered meeting at the same time. The countdown's
 * switches and dismissals are not consulted, so the shortcut works with the
 * countdown off.
 */
export function meetingToJoin(
  events: readonly UpcomingEvent[],
  now: number,
): UpcomingEvent | null {
  const candidates = events.filter(
    (event) =>
      !event.allDay &&
      Boolean(event.joinUrl) &&
      event.response !== "declined" &&
      event.endAt > now &&
      event.startAt <= endOfToday(new Date(now)),
  );
  return preferAnswered(leadEvent(candidates, now), candidates);
}

/**
 * What the right-click menu's Join item names: the meeting alone once it is
 * under way, or with its start ("Design review at 3:00 PM") while it is
 * still to come, so the item never reads as if the call were on now.
 */
export function joinMenuLabel(
  event: Pick<UpcomingEvent, "title" | "startAt">,
  now: number,
  locale?: string,
): string {
  if (event.startAt <= now) return event.title;
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(event.startAt),
  );
  return `${event.title} at ${time}`;
}

/** The host's words when Calendar access has not been granted (events.rs). */
export const CALENDAR_ACCESS_MISSING = "Calendar access is not enabled";

/**
 * Whether a failed read is fixed by asking for Calendar access. Any other
 * failure is better offered again than met with a prompt that cannot help.
 */
export function needsCalendarAccess(error: string): boolean {
  return error === CALENDAR_ACCESS_MISSING;
}

/** How far back and ahead search looks, in days from today. */
export const SEARCH_DAYS_BACK = 30;
export const SEARCH_DAYS_AHEAD = 90;
/** The most results search lists. */
export const SEARCH_LIMIT = 20;

/** Lower case, accents dropped: "Café" finds "cafe". */
function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Events whose title or location holds every word of the query, the ones
 * nearest now kept up to the limit, grouped by day: today and later first,
 * in calendar order, then earlier days, most recent first.
 */
export function searchEvents(
  events: readonly UpcomingEvent[],
  query: string,
  now: number,
  limit = SEARCH_LIMIT,
): { day: Date; events: UpcomingEvent[] }[] {
  const words = folded(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  const found = events.filter((event) => {
    const key = occurrenceKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    const text = folded(`${event.title} ${event.location ?? ""}`);
    return words.every((word) => text.includes(word));
  });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const nearest = found
    .sort((a, b) => Math.abs(a.startAt - now) - Math.abs(b.startAt - now))
    .slice(0, limit);
  const upcoming = nearest.filter((event) => event.endAt > today.getTime()).sort(compareEvents);
  const earlier = nearest
    .filter((event) => event.endAt <= today.getTime())
    .sort((a, b) => b.startAt - a.startAt || compareEvents(a, b));
  const groups: { day: Date; events: UpcomingEvent[] }[] = [];
  for (const event of [...upcoming, ...earlier]) {
    const start = new Date(event.startAt);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = groups[groups.length - 1];
    if (last && last.day.getTime() === day.getTime()) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}

/** "Today", "Tomorrow", "Yesterday", or the date, with the year when it differs. */
export function searchDayTitle(day: Date, now: number, locale?: string): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return dateFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(day);
}
