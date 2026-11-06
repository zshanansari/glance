import { ICON_LEAD_ALWAYS, ICON_LEAD_AT_START, type AppSettings } from "./settings";

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
    .filter((event) => !event.allDay && event.endAt > now)
    .sort(compareEvents);
  const lead = live[0];
  if (!lead) return [];
  const label = eventStatus(lead, now).label;
  return live.filter((event) => eventStatus(event, now).label === label);
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

/** Local midnight that ends the "today and tomorrow" window. */
export function endOfTomorrow(now = new Date()): number {
  return endOfDay(now.getTime(), 2);
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
  let best: UpcomingEvent | null = null;
  for (const event of events) {
    if (event.allDay) continue;
    if (!eventPassesFilters(event, options.filters)) continue;
    if (occurrenceIsDismissed(event, dismissed, now)) continue;
    if (
      eventQualifiesForIcon(
        event,
        now,
        options.upcomingHorizonDays,
        options.upcomingIconLeadMinutes,
      ) &&
      (!best || compareEvents(event, best) < 0)
    ) {
      best = event;
    }
  }
  return best;
}

export type EventTiming = "upcoming" | "ongoing";

function roundedMinutes(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 60_000));
}

/** An event that just started reads "now" rather than counting itself down. */
const NOW_WINDOW_MS = 10 * 60_000;

function relativeTime(milliseconds: number): string {
  const minutes = roundedMinutes(milliseconds);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function eventStatus(
  event: Pick<UpcomingEvent, "startAt" | "endAt">,
  now = Date.now(),
): { label: string; timing: EventTiming } {
  if (now >= event.endAt) {
    return {
      label: "No upcoming events",
      timing: "upcoming",
    };
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

/** Longest event name the menu bar item carries before it is cut short. */
export const TRAY_TITLE_LIMIT = 24;

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
  return new Intl.DateTimeFormat(locale, {
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

export function eventTimeRange(
  event: Pick<UpcomingEvent, "startAt" | "endAt" | "allDay">,
  locale?: string,
): string {
  if (event.allDay) return "All day";
  const format = new Intl.DateTimeFormat(locale, {
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
 * The meeting to remind about now: timed, with a join link, not declined or
 * dismissed, and starting within the lead. One that started a few minutes
 * ago still qualifies when it was never offered, as when the month was open
 * at its minute. A meeting about to start comes before one already running;
 * otherwise the earliest start wins, and an answered meeting beats an
 * unanswered invitation at the same time.
 */
export function reminderEvent(
  events: readonly UpcomingEvent[],
  now: number,
  dismissed: readonly DismissedOccurrence[] = [],
  offered: (event: UpcomingEvent) => boolean = () => false,
): UpcomingEvent | null {
  let best: UpcomingEvent | null = null;
  const candidates: UpcomingEvent[] = [];
  const rank = (event: UpcomingEvent): number => (event.startAt > now ? 0 : 1);
  for (const event of events) {
    if (event.allDay || !event.joinUrl || event.response === "declined") continue;
    if (occurrenceIsDismissed(event, dismissed, now) || offered(event)) continue;
    const until = event.startAt - now;
    if (until > REMINDER_LEAD_MS || !reminderStillDue(event, now)) continue;
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
  let best: UpcomingEvent | null = null;
  const candidates: UpcomingEvent[] = [];
  for (const event of events) {
    if (event.allDay || !event.joinUrl || event.response === "declined") continue;
    if (event.endAt <= now || event.startAt > endOfToday(new Date(now))) continue;
    candidates.push(event);
    if (!best || compareEvents(event, best) < 0) best = event;
  }
  return preferAnswered(best, candidates);
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
