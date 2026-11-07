import { dateFormat } from "./region";

export type WeekStartsOn = Weekday;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Theme = "system" | "light" | "dark";
export type WeekNumbering = "iso" | "us";
export const COMING_DAYS = [0, 1, 2, 3, 5, 7] as const;
export type ComingDays = (typeof COMING_DAYS)[number];
export type MenuBarIconStyle = "filled" | "framed" | "calendar" | "none";
/** Look-ahead lengths, counted in whole local days through midnight. */
export const UPCOMING_HORIZON_DAYS = [1, 2, 3, 4, 5, 6, 7, 14, 30] as const;
export type UpcomingHorizonDays = (typeof UPCOMING_HORIZON_DAYS)[number];

/** 0 means the events item follows the upcoming list window. */
export const ICON_LEAD_ALWAYS = 0;
/** 1 is a sentinel: hold the events item back until the event starts. */
export const ICON_LEAD_AT_START = 1;
export const UPCOMING_ICON_LEAD_MINUTES = [
  ICON_LEAD_AT_START, 15, 30, 60, 240, 480, 720, 1440, ICON_LEAD_ALWAYS,
] as const;
export type UpcomingIconLeadMinutes = (typeof UPCOMING_ICON_LEAD_MINUTES)[number];

export function upcomingHorizonLabel(days: UpcomingHorizonDays): string {
  if (days === 1) return "Today";
  if (days === 2) return "Today and tomorrow";
  if (days === 7) return "1 week";
  if (days === 14) return "2 weeks";
  if (days === 30) return "1 month";
  return `${days} days`;
}

export function upcomingIconLeadLabel(minutes: UpcomingIconLeadMinutes): string {
  if (minutes === ICON_LEAD_ALWAYS) return "Always";
  if (minutes === ICON_LEAD_AT_START) return "At start of event";
  if (minutes < 60) return `${minutes} minutes before`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour before" : `${hours} hours before`;
}

export type AppSettings = {
  menuBarIcon: MenuBarIconStyle;
  showWeekday: boolean;
  showMonth: boolean;
  weekStartsOn: WeekStartsOn;
  showWeekNumbers: boolean;
  /** "iso" (ISO 8601) or "us" (week 1 holds 1 January, weeks from Sunday). */
  weekNumbering: WeekNumbering;
  /** Days after today whose events follow today's list; 0 shows none. */
  comingDays: ComingDays;
  /** A second time zone (IANA name), or "" for none. */
  secondTimeZone: string;
  /** Whether that zone's time shows in the menu bar too. */
  secondTimeZoneInMenuBar: boolean;
  highlightWeekdays: Weekday[];
  launchAtLogin: boolean;
  beepOnTheHour: boolean;
  showUpcomingEvent: boolean;
  /** Days the countdown looks ahead, counted through local midnight. */
  upcomingHorizonDays: UpcomingHorizonDays;
  /**
   * Minutes before start to show the countdown. 0 follows the look-ahead,
   * 1 holds it back until the event starts.
   */
  upcomingIconLeadMinutes: UpcomingIconLeadMinutes;
  /** Solo blocks: events nobody else was invited to. */
  includeEventsWithoutParticipants: boolean;
  /** Events with neither a meeting link nor a place. */
  includeEventsWithoutLocation: boolean;
  /** Event name after the countdown. */
  showEventTitleInMenuBar: boolean;
  /** Start time, or the time left, after the countdown. */
  showEventTimeInMenuBar: boolean;
  /** A card with Join under the menu bar a minute before a meeting starts. */
  remindBeforeMeetings: boolean;
  /** The card also comes ten minutes before a meeting with a place and no link. */
  remindInPerson: boolean;
  /** System-wide chord that toggles the month popover. Empty is unset. */
  toggleCalendarShortcut: string;
  /** System-wide chord that joins the meeting under way or next today. Empty is unset. */
  joinMeetingShortcut: string;
  /** EventKit identifiers the upcoming-event list should ignore. Empty shows every calendar. */
  hiddenCalendarIds: string[];
  autoUpdate: boolean;
  theme: Theme;
  /** What marks today and the chosen day: Calendar's red or the system accent. */
  dayHighlight: DayHighlight;
  /** Set once the first-run welcome has been seen. */
  onboarded: boolean;
};

/**
 * Today and the chosen day: the accent or a system color, in the order
 * System Settings lists the accent colors. Red is the default, as Calendar
 * marks today.
 */
export const DAY_HIGHLIGHTS = [
  { id: "accent", name: "Accent Color" },
  { id: "blue", name: "Blue" },
  { id: "purple", name: "Purple" },
  { id: "pink", name: "Pink" },
  { id: "red", name: "Red" },
  { id: "orange", name: "Orange" },
  { id: "yellow", name: "Yellow" },
  { id: "green", name: "Green" },
  { id: "graphite", name: "Graphite" },
] as const;

export type DayHighlight = (typeof DAY_HIGHLIGHTS)[number]["id"];

export type CalendarKind = "event" | "reminder";

export type CalendarInfo = {
  id: string;
  title: string;
  source: string | null;
  color: string | null;
  kind?: CalendarKind;
};

export type MenuBarPart = "weekday" | "day" | "month";

export const MENU_BAR_ICONS: { id: MenuBarIconStyle; label: string }[] = [
  { id: "filled", label: "Calendar with date" },
  { id: "calendar", label: "Dotted calendar" },
  { id: "framed", label: "Cutout date" },
  { id: "none", label: "Date only" },
];

const PART_OPTIONS: Record<MenuBarPart, Intl.DateTimeFormatOptions> = {
  weekday: { weekday: "short" },
  day: { day: "numeric" },
  month: { month: "short" },
};

export const WEEK_STARTS: { id: WeekStartsOn; label: string }[] = [
  { id: 0, label: "Sunday" },
  { id: 1, label: "Monday" },
  { id: 2, label: "Tuesday" },
  { id: 3, label: "Wednesday" },
  { id: 4, label: "Thursday" },
  { id: 5, label: "Friday" },
  { id: 6, label: "Saturday" },
];

/** Monday → Sunday, matching the Highlight picker. */
export const HIGHLIGHT_DAYS: { id: Weekday; name: string }[] = [
  { id: 1, name: "Monday" },
  { id: 2, name: "Tuesday" },
  { id: 3, name: "Wednesday" },
  { id: 4, name: "Thursday" },
  { id: 5, name: "Friday" },
  { id: 6, name: "Saturday" },
  { id: 0, name: "Sunday" },
];

/** The highlight days in the order the month shows its columns. */
export function highlightDaysFrom(weekStartsOn: number): { id: Weekday; name: string }[] {
  return [...HIGHLIGHT_DAYS].sort(
    (left, right) => ((left.id - weekStartsOn + 7) % 7) - ((right.id - weekStartsOn + 7) % 7),
  );
}

export const DEFAULT_HIGHLIGHT_WEEKDAYS: Weekday[] = [0, 6];

export const DEFAULT_SETTINGS: AppSettings = {
  menuBarIcon: "filled",
  // The system clock already shows the date, so a new menu bar item starts
  // as the glyph alone; the weekday and month are there to switch on.
  showWeekday: false,
  showMonth: false,
  weekStartsOn: 0,
  showWeekNumbers: false,
  weekNumbering: "iso",
  comingDays: 3,
  secondTimeZone: "",
  secondTimeZoneInMenuBar: false,
  highlightWeekdays: [...DEFAULT_HIGHLIGHT_WEEKDAYS],
  launchAtLogin: false,
  beepOnTheHour: false,
  showUpcomingEvent: false,
  upcomingHorizonDays: 1,
  upcomingIconLeadMinutes: ICON_LEAD_ALWAYS,
  includeEventsWithoutParticipants: true,
  includeEventsWithoutLocation: true,
  showEventTitleInMenuBar: false,
  showEventTimeInMenuBar: false,
  remindBeforeMeetings: true,
  remindInPerson: false,
  toggleCalendarShortcut: "Control+Command+K",
  joinMeetingShortcut: "",
  hiddenCalendarIds: [],
  autoUpdate: true,
  theme: "system",
  dayHighlight: "red",
  onboarded: false,
};

export function weekdayLetter(id: Weekday, locale?: string): string {
  // 5 January 2020 is a Sunday, so adding `id` lands on that weekday.
  return dateFormat(locale, { weekday: "narrow" }).format(
    new Date(2020, 0, 5 + id, 12),
  );
}

export function calendarsOfKind(
  calendars: readonly CalendarInfo[],
  kind: CalendarKind,
): CalendarInfo[] {
  return calendars.filter((calendar) => (calendar.kind ?? "event") === kind);
}

/** Adjacent calendars from the same account, titles A–Z inside each group. */
export function groupCalendarsBySource(
  calendars: readonly CalendarInfo[],
): { source: string; calendars: CalendarInfo[] }[] {
  const groups = new Map<string, CalendarInfo[]>();
  for (const calendar of [...calendars].sort((a, b) =>
    a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
  )) {
    const source = calendar.source?.trim() || "Other";
    const list = groups.get(source) ?? [];
    list.push(calendar);
    groups.set(source, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en", { sensitivity: "base" }))
    .map(([source, items]) => ({ source, calendars: items }));
}

/**
 * Adjacent highlighted columns, in the displayed week order. Saturday and
 * Sunday become one band when they sit next to each other.
 */
export function highlightedColumnRuns(
  weekStartsOn: WeekStartsOn,
  highlighted: readonly number[],
): { start: number; count: number }[] {
  const selected = new Set(highlighted);
  const active = Array.from({ length: 7 }, (_, index) =>
    selected.has((weekStartsOn + index) % 7),
  );
  const runs: { start: number; count: number }[] = [];
  for (let index = 0; index < 7; ) {
    if (!active[index]) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < 7 && active[end]) end += 1;
    runs.push({ start: index, count: end - index });
    index = end;
  }
  return runs;
}

export function datedMenuBarIcon(style: MenuBarIconStyle): boolean {
  return style === "filled";
}

export type MenuBarLabel = {
  /**
   * The date beside the clock, or null when there is nothing to add. The
   * filled glyph carries the day itself, so its text is only the weekday and
   * month. The dotted calendar adds the full date once either is switched on.
   * The framed style cuts this text out of a filled background; the
   * date-only style shows it as plain text.
   */
  text: string | null;
  /** Day of the month when the glyph itself shows the date. */
  day: number | null;
  style: MenuBarIconStyle;
};

function formatPart(part: MenuBarPart, date: Date, locale?: string): string {
  return dateFormat(locale, PART_OPTIONS[part]).format(date);
}

/**
 * Every style takes the weekday and month toggles. The framed glyph cuts the
 * text out of itself; the other styles show it beside the icon.
 */
export function menuBarLabel(
  settings: Pick<AppSettings, "menuBarIcon" | "showWeekday" | "showMonth">,
  date: Date,
  locale?: string,
): MenuBarLabel {
  const extras = settings.showWeekday || settings.showMonth;
  if (datedMenuBarIcon(settings.menuBarIcon)) {
    // The glyph already shows the day; only the parts around it are text.
    const parts: string[] = [];
    if (settings.showWeekday) parts.push(formatPart("weekday", date, locale));
    if (settings.showMonth) parts.push(formatPart("month", date, locale));
    return {
      text: parts.length ? parts.join(" ") : null,
      day: date.getDate(),
      style: settings.menuBarIcon,
    };
  }
  if (settings.menuBarIcon === "calendar" && !extras) {
    return { text: null, day: null, style: settings.menuBarIcon };
  }
  const parts: string[] = [];
  if (settings.showWeekday) parts.push(formatPart("weekday", date, locale));
  parts.push(formatPart("day", date, locale));
  if (settings.showMonth) parts.push(formatPart("month", date, locale));
  return {
    text: parts.join(" "),
    day: null,
    style: settings.menuBarIcon,
  };
}

/** Enough of the label to know the menu bar must be redrawn. */
export function trayLabelKey(label: MenuBarLabel): string {
  return `${label.text ?? ""}|${label.day ?? ""}|${label.style}`;
}
