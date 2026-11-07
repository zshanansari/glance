import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  endOfDay,
  eventInIconLead,
  eventInUpcomingHorizon,
  eventPassesFilters,
  eventQualifiesForIcon,
  eventStatus,
  eventTimeRange,
  trayEventText,
  trayTitle,
  trayIconEvent,
  upcomingFetchEnd,
  upcomingHorizonEnd,
  meetingToJoin,
  needsCalendarAccess,
  CALENDAR_ACCESS_MISSING,
  reminderEvent,
  reminderStillDue,
  type EventFilters,
  type UpcomingEvent,
  eventsOnDay,
  countdownEvents,
  coveringRanges,
  eventOverlaps,
  dayCountdownEvents,
  leadEvent,
  pastToFold,
  spokenStatus,
  trayDescription,
} from "../src/shared/events";
import { ICON_LEAD_ALWAYS, ICON_LEAD_AT_START } from "../src/shared/settings";

const event: UpcomingEvent = {
  id: "event-1",
  title: "Design sync",
  startAt: Date.UTC(2026, 8, 9, 10, 30),
  endAt: Date.UTC(2026, 8, 9, 11, 0),
  calendar: "Work",
  color: null,
  location: null,
  joinUrl: null,
  response: "accepted",
  kind: "event",
  allDay: false,
  hasParticipants: true,
};

/** Every include switch on, so a test says which one it is exercising. */
const included: EventFilters = {
  includeEventsWithoutParticipants: true,
  includeEventsWithoutLocation: true,
};

describe("event status", () => {
  it("counts down to an upcoming event", () => {
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 0)).label).toBe("in 30m");
  });

  it("reads as now for the first ten minutes in progress", () => {
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 30)).label).toBe("now");
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 39, 59)).label).toBe("now");
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 30)).timing).toBe("ongoing");
  });

  it("counts down an event in progress", () => {
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 40)).label).toBe("20m left");
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 56)).label).toBe("4m left");
  });

  it("keeps short durations readable", () => {
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 10, 29, 59)).label).toBe("in 1m");
  });

  it("uses hours for longer countdowns", () => {
    expect(eventStatus(event, Date.UTC(2026, 8, 9, 8, 7)).label).toBe("in 2h 23m");
  });
});

describe("event time range", () => {
  it("formats a compact local time range", () => {
    expect(eventTimeRange(event, "en-US")).toMatch(/\d+:\d{2}.*\d+:\d{2}/);
  });
});

describe("the end of a two-day window", () => {
  it("ends at the local midnight that closes tomorrow", () => {
    const boundary = new Date(endOfDay(new Date(2026, 8, 9, 23, 30).getTime(), 2));
    expect(boundary.getFullYear()).toBe(2026);
    expect(boundary.getMonth()).toBe(8);
    expect(boundary.getDate()).toBe(11);
    expect(boundary.getHours()).toBe(0);
    expect(boundary.getMinutes()).toBe(0);
  });

  it("covers the rest of today from early morning", () => {
    const now = new Date(2026, 8, 9, 0, 5);
    expect(endOfDay(now.getTime(), 2) - now.getTime()).toBeGreaterThan(47 * 3_600_000);
  });

  it("crosses a month boundary", () => {
    const boundary = new Date(endOfDay(new Date(2026, 8, 30, 18, 0).getTime(), 2));
    expect(boundary.getMonth()).toBe(9);
    expect(boundary.getDate()).toBe(2);
  });
});

describe("upcoming look-ahead", () => {
  const now = new Date(2026, 8, 9, 10, 0).getTime();
  const today = {
    ...event,
    startAt: new Date(2026, 8, 9, 16, 0).getTime(),
    endAt: new Date(2026, 8, 9, 17, 0).getTime(),
  };
  const inFourDays = {
    ...event,
    id: "event-4d",
    startAt: new Date(2026, 8, 13, 9, 0).getTime(),
    endAt: new Date(2026, 8, 13, 10, 0).getTime(),
  };

  it("keeps an event later the same day", () => {
    expect(eventInUpcomingHorizon(today, now, 1)).toBe(true);
  });

  it("keeps a meeting that has already started", () => {
    expect(
      eventInUpcomingHorizon(today, new Date(2026, 8, 9, 16, 40).getTime(), 1),
    ).toBe(true);
  });

  it("drops an event beyond the window and keeps it once the window grows", () => {
    expect(eventInUpcomingHorizon(inFourDays, now, 2)).toBe(false);
    expect(eventInUpcomingHorizon(inFourDays, now, 5)).toBe(true);
  });

  it("drops an event that has already ended", () => {
    expect(
      eventInUpcomingHorizon(today, new Date(2026, 8, 9, 18, 0).getTime(), 7),
    ).toBe(false);
  });

  it("treats one day as through midnight tonight", () => {
    const late = new Date(2026, 8, 9, 22, 0).getTime();
    const boundary = new Date(upcomingHorizonEnd(late, 1));
    expect(boundary.getFullYear()).toBe(2026);
    expect(boundary.getMonth()).toBe(8);
    expect(boundary.getDate()).toBe(10);
    expect(boundary.getHours()).toBe(0);
  });

  it("treats two days as through the end of tomorrow, not 48 clock hours", () => {
    const late = new Date(2026, 8, 9, 22, 0).getTime();
    const end = upcomingHorizonEnd(late, 2);
    const boundary = new Date(end);
    expect(boundary.getDate()).toBe(11);
    expect(boundary.getHours()).toBe(0);
    expect(end - late).toBeLessThan(48 * 3_600_000);
  });

  it("runs a month of look-ahead through the thirtieth local midnight", () => {
    const boundary = new Date(upcomingHorizonEnd(now, 30));
    expect(boundary.getMonth()).toBe(9);
    expect(boundary.getDate()).toBe(9);
    expect(boundary.getHours()).toBe(0);
  });

  it("keeps an all-day reminder on its due day", () => {
    const reminder = {
      ...event,
      kind: "reminder" as const,
      allDay: true,
      startAt: new Date(2026, 8, 9, 0, 0).getTime(),
      endAt: new Date(2026, 8, 10, 0, 0).getTime(),
    };
    expect(
      eventInUpcomingHorizon(reminder, new Date(2026, 8, 9, 15, 0).getTime(), 2),
    ).toBe(true);
    expect(eventTimeRange(reminder, "en-US")).toBe("All day");
  });

  it("fetches far enough ahead for the window or the lead, whichever is longer", () => {
    expect(upcomingFetchEnd(now, 1, ICON_LEAD_ALWAYS)).toBe(upcomingHorizonEnd(now, 1));
    expect(upcomingFetchEnd(now, 1, 1440)).toBe(now + 1440 * 60_000);
    expect(upcomingFetchEnd(now, 30, 1440)).toBe(upcomingHorizonEnd(now, 30));
    // The at-start sentinel is a marker, not a minute count.
    expect(upcomingFetchEnd(now, 1, ICON_LEAD_AT_START)).toBe(
      upcomingHorizonEnd(now, 1),
    );
  });
});

describe("include filters", () => {
  const now = new Date(2026, 8, 9, 10, 0).getTime();
  const solo = { ...event, id: "solo", hasParticipants: false };
  const birthday = { ...event, id: "birthday", allDay: true };
  const placeless = { ...event, id: "placeless", location: null, joinUrl: null };
  const zoom = { ...event, id: "zoom", joinUrl: "https://zoom.us/j/1" };

  it("never lets a declined invitation through", () => {
    const declined = { ...event, response: "declined" as const };
    expect(eventPassesFilters(declined, included)).toBe(false);
  });

  it("hides a solo block when participants are required", () => {
    const filters = { ...included, includeEventsWithoutParticipants: false };
    expect(eventPassesFilters(solo, filters)).toBe(false);
    expect(eventPassesFilters(event, filters)).toBe(true);
  });

  it("hides an item with neither a link nor a place", () => {
    const filters = { ...included, includeEventsWithoutLocation: false };
    expect(eventPassesFilters(placeless, filters)).toBe(false);
    expect(eventPassesFilters(zoom, filters)).toBe(true);
    expect(
      eventPassesFilters({ ...placeless, location: "Room 2" }, filters),
    ).toBe(true);
  });

  it("never counts down an all-day item, even one under way", () => {
    const filters = included;
    const birthdayNow = {
      ...birthday,
      startAt: new Date(2026, 8, 9, 0, 0).getTime(),
      endAt: new Date(2026, 8, 10, 0, 0).getTime(),
    };
    expect(
      trayIconEvent([birthdayNow, zoom], now, {
        upcomingHorizonDays: 1,
        upcomingIconLeadMinutes: ICON_LEAD_ALWAYS,
        filters,
      }),
    ).toBe(zoom);
  });
});

describe("events icon lead", () => {
  const now = Date.UTC(2026, 8, 9, 10, 0);
  const later = {
    ...event,
    id: "event-2",
    title: "Wrap-up",
    startAt: Date.UTC(2026, 8, 9, 10, 20),
    endAt: Date.UTC(2026, 8, 9, 10, 50),
  };

  it("hides a meeting two hours out when the icon waits 15 minutes", () => {
    expect(eventInIconLead(event, Date.UTC(2026, 8, 9, 8, 30), 15)).toBe(false);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 8, 30), 1, 15)).toBe(false);
  });

  it("shows the icon 15 minutes before, through the meeting, then hides it", () => {
    expect(eventInIconLead(event, Date.UTC(2026, 8, 9, 10, 15), 15)).toBe(true);
    expect(eventInIconLead(event, Date.UTC(2026, 8, 9, 10, 40), 15)).toBe(true);
    expect(eventInIconLead(event, Date.UTC(2026, 8, 9, 11, 0), 15)).toBe(false);
  });

  it("waits four hours out and shows the item once the lead is reached", () => {
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 4, 30), 1, 240)).toBe(false);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 6, 30), 1, 240)).toBe(true);
    // Once it is running the item stays until the event ends.
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 10, 45), 1, 240)).toBe(true);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 11, 0), 1, 240)).toBe(false);
  });

  it("holds the item back until the event starts on the at-start sentinel", () => {
    const lead = ICON_LEAD_AT_START;
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 10, 29), 1, lead)).toBe(false);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 10, 30), 1, lead)).toBe(true);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 10, 59), 1, lead)).toBe(true);
    expect(eventQualifiesForIcon(event, Date.UTC(2026, 8, 9, 11, 0), 1, lead)).toBe(false);
  });

  it("still shows anything in the list window when the icon is always on", () => {
    const today = {
      ...event,
      startAt: new Date(2026, 8, 9, 16, 0).getTime(),
      endAt: new Date(2026, 8, 9, 17, 0).getTime(),
    };
    const local = new Date(2026, 8, 9, 8, 30).getTime();
    expect(eventQualifiesForIcon(today, local, 1, ICON_LEAD_ALWAYS)).toBe(true);
    const tomorrow = {
      ...today,
      startAt: new Date(2026, 8, 10, 16, 0).getTime(),
      endAt: new Date(2026, 8, 10, 17, 0).getTime(),
    };
    expect(eventQualifiesForIcon(tomorrow, local, 1, ICON_LEAD_ALWAYS)).toBe(false);
    expect(eventQualifiesForIcon(tomorrow, local, 2, ICON_LEAD_ALWAYS)).toBe(true);
  });

  it("never counts an all-day item down, even when all-day items are included", () => {
    const reminder = {
      ...event,
      kind: "reminder" as const,
      allDay: true,
      startAt: Date.UTC(2026, 8, 9, 0, 0),
      endAt: Date.UTC(2026, 8, 9, 23, 0),
    };
    const options = {
      upcomingHorizonDays: 1,
      upcomingIconLeadMinutes: ICON_LEAD_ALWAYS,
      filters: included,
    };
    expect(trayIconEvent([reminder, event], now, options)).toBe(event);
    expect(trayIconEvent([reminder], now, options)).toBeNull();
  });

  it("counts down the next qualifying event after one is dismissed", () => {
    // "later" comes second in the list but starts first, so it leads.
    expect(
      trayIconEvent([event, later], now, {
        upcomingHorizonDays: 1,
        upcomingIconLeadMinutes: 30,
        filters: included,
      }),
    ).toBe(later);
    expect(
      trayIconEvent([event, later], now, {
        upcomingHorizonDays: 1,
        upcomingIconLeadMinutes: 30,
        filters: included,
        dismissed: [{ id: later.id, endAt: later.endAt }],
      }),
    ).toBe(event);
  });

  it("leaves the list window alone when the icon uses a shorter lead", () => {
    const far = {
      ...event,
      startAt: Date.UTC(2026, 8, 9, 12, 0),
      endAt: Date.UTC(2026, 8, 9, 12, 30),
    };
    expect(eventInUpcomingHorizon(far, now, 2)).toBe(true);
    expect(eventQualifiesForIcon(far, now, 2, 15)).toBe(false);
  });
});

describe("menu bar preview text", () => {
  // Local times, so the expected label does not move with the test machine.
  const standup = {
    ...event,
    title: "Design sync",
    startAt: new Date(2026, 8, 9, 15, 0).getTime(),
    endAt: new Date(2026, 8, 9, 16, 0).getTime(),
  };
  const before = standup.startAt - 600_000;

  it("keeps the item glyph-only when both switches are off", () => {
    expect(
      trayEventText(standup, before, { showTitle: false, showTime: false }),
    ).toBeNull();
  });

  it("shows the start time, then the title", () => {
    const text = trayEventText(
      standup,
      before,
      { showTitle: true, showTime: true },
      "en-US",
    );
    expect(text).toBe("3:00 PM  Design sync");
  });

  it("leaves the time to the countdown once the event is running", () => {
    expect(
      trayEventText(standup, standup.startAt, { showTitle: false, showTime: true }, "en-US"),
    ).toBeNull();
    expect(
      trayEventText(
        standup,
        standup.startAt + 15 * 60_000,
        { showTitle: true, showTime: true },
        "en-US",
      ),
    ).toBe("Design sync");
  });

  it("shortens a title that would eat the menu bar", () => {
    const long = { ...standup, title: "Quarterly planning and roadmap review" };
    const text = trayEventText(long, before, { showTitle: true, showTime: false });
    expect(text).toBe("Quarterly planning and…");
    expect(text?.length).toBeLessThanOrEqual(24);
  });
});

describe("eventsOnDay", () => {
  const at = (day: number, hour: number) => new Date(2026, 8, day, hour).getTime();
  const item = (id: string, startAt: number, endAt: number, allDay = false): UpcomingEvent => ({
    ...event,
    id,
    startAt,
    endAt,
    allDay,
  });

  it("keeps what touches the day, all-day first, then by start", () => {
    const events = [
      item("late", at(9, 15), at(9, 16)),
      item("early", at(9, 9), at(9, 10)),
      item("allday", at(9, 0), at(10, 0), true),
      item("overnight", at(8, 23), at(9, 1)),
      item("yesterday", at(8, 9), at(8, 10)),
      item("tomorrow", at(10, 0), at(10, 1)),
    ];
    expect(eventsOnDay(events, new Date(2026, 8, 9)).map(({ id }) => id)).toEqual([
      "allday",
      "overnight",
      "early",
      "late",
    ]);
  });
});

describe("meeting reminder", () => {
  const start = Date.UTC(2026, 8, 9, 10, 0);
  const call = {
    ...event,
    id: "call",
    startAt: start,
    endAt: start + 30 * 60_000,
    joinUrl: "https://zoom.us/j/1",
  };
  // The clock ticks just past each minute.
  const tickBefore = start - 60_000 + 40;

  it("offers a meeting with a link on the tick a minute before it starts", () => {
    expect(reminderEvent([call], tickBefore)).toBe(call);
    expect(reminderEvent([call], start - 2 * 60_000 + 40)).toBeNull();
  });

  it("still offers a call it never offered, for its first few minutes", () => {
    const offered = (candidate: UpcomingEvent) => candidate.id === call.id;
    expect(reminderEvent([call], start + 60_000 + 40)).toBe(call);
    expect(reminderEvent([call], start + 60_000 + 40, [], offered)).toBeNull();
    expect(reminderEvent([call], start + 5 * 60_000 + 40)).toBeNull();
  });

  it("puts a call about to start ahead of one already running", () => {
    const running = { ...call, id: "running", startAt: start - 3 * 60_000 };
    expect(reminderEvent([running, call], tickBefore)).toBe(call);
  });

  it("skips calls with no link, all-day items, declines and dismissals", () => {
    expect(reminderEvent([{ ...call, joinUrl: null }], tickBefore)).toBeNull();
    expect(reminderEvent([{ ...call, allDay: true }], tickBefore)).toBeNull();
    expect(reminderEvent([{ ...call, response: "declined" as const }], tickBefore)).toBeNull();
    expect(
      reminderEvent([call], tickBefore, [{ id: call.id, endAt: call.endAt }]),
    ).toBeNull();
  });

  it("picks the earliest of two calls starting together", () => {
    const sooner = { ...call, id: "sooner", startAt: start - 30_000 };
    expect(reminderEvent([call, sooner], tickBefore)).toBe(sooner);
  });

  it("stays for the first minutes of the meeting, never past its end", () => {
    expect(reminderStillDue(call, start + 4 * 60_000)).toBe(true);
    expect(reminderStillDue(call, start + 5 * 60_000)).toBe(false);
    expect(reminderStillDue({ ...call, endAt: start + 2 * 60_000 }, start + 3 * 60_000)).toBe(false);
  });
});

describe("join shortcut", () => {
  const now = new Date(2026, 8, 9, 10, 0).getTime();
  const at = (hour: number, minute = 0) => new Date(2026, 8, 9, hour, minute).getTime();
  const call = (id: string, start: number, end: number) => ({
    ...event,
    id,
    startAt: start,
    endAt: end,
    joinUrl: "https://meet.google.com/abc-defg-hij",
  });

  it("joins the meeting under way before a later one", () => {
    const now_ = call("now", at(9, 45), at(10, 15));
    const later = call("later", at(11), at(11, 30));
    expect(meetingToJoin([later, now_], now)).toBe(now_);
  });

  it("joins the next meeting today when none is under way", () => {
    const later = call("later", at(11), at(11, 30));
    expect(meetingToJoin([later], now)).toBe(later);
  });

  it("skips links that are over, declined, all-day, or tomorrow", () => {
    const over = call("over", at(8), at(9));
    const declined = { ...call("declined", at(11), at(12)), response: "declined" as const };
    const allDay = { ...call("all-day", at(0), at(23, 59)), allDay: true };
    const tomorrow = call("tomorrow", at(10) + 86_400_000, at(11) + 86_400_000);
    const noLink = { ...call("no-link", at(11), at(12)), joinUrl: null };
    expect(meetingToJoin([over, declined, allDay, tomorrow, noLink], now)).toBeNull();
  });
});

describe("a failed read", () => {
  it("asks for Calendar access only when access is what is missing", () => {
    expect(needsCalendarAccess("Calendar access is not enabled")).toBe(true);
    expect(needsCalendarAccess("Could not read events")).toBe(false);
  });

  it("matches the words the host sends", () => {
    const host = readFileSync("src-tauri/src/events.rs", "utf8");
    expect(host).toContain(`"${CALENDAR_ACCESS_MISSING}"`);
  });
});

describe("meetings at the same moment", () => {
  const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 6, hour, minute);
  const think = { ...event, id: "think", title: "Think Tank Meet", startAt: at(16), endAt: at(17) };
  const share = { ...event, id: "share", title: "Share, Learn, Apply", startAt: at(16, 30), endAt: at(17) };
  const pat = { ...event, id: "pat", title: "Axioned x Pat Hicks", startAt: at(19), endAt: at(19, 30) };
  const scrum = { ...event, id: "scrum", title: "Mini-Scrum", startAt: at(19), endAt: at(19, 30) };
  const day = [scrum, pat, share, think];

  it("counts down every meeting ending together", () => {
    const shown = countdownEvents(day, at(16, 55)).map((item) => item.id);
    expect(shown).toEqual(["think", "share"]);
  });

  it("counts down every meeting starting together", () => {
    const shown = countdownEvents(day, at(18, 35)).map((item) => item.id);
    expect(shown).toEqual(["pat", "scrum"]);
  });

  it("leaves a meeting with a different end out of the countdown", () => {
    const longer = { ...share, endAt: at(17, 30) };
    const shown = countdownEvents([think, longer], at(16, 50)).map((item) => item.id);
    expect(shown).toEqual(["think"]);
  });

  it("has nothing to count once the day is over", () => {
    expect(countdownEvents(day, at(20))).toEqual([]);
  });

  it("menu bar picks the same tied meeting whatever order Calendar returns", () => {
    const options = {
      upcomingHorizonDays: 1,
      upcomingIconLeadMinutes: ICON_LEAD_ALWAYS,
      filters: included,
    };
    expect(trayIconEvent([scrum, pat], at(18, 35), options)?.id).toBe("pat");
    expect(trayIconEvent([pat, scrum], at(18, 35), options)?.id).toBe("pat");
  });

  it("orders tied meetings by name in the day list", () => {
    const titles = eventsOnDay([scrum, pat], new Date(pat.startAt)).map((item) => item.title);
    expect(titles).toEqual(["Axioned x Pat Hicks", "Mini-Scrum"]);
  });
});

describe("unanswered invitations", () => {
  const start = Date.UTC(2026, 10, 6, 15, 0);
  const meeting = (id: string, title: string, response: UpcomingEvent["response"]) => ({
    ...event,
    id,
    title,
    response,
    joinUrl: `https://zoom.us/j/${id}`,
    startAt: start,
    endAt: start + 30 * 60_000,
  });
  const stranger = meeting("1", "A free prize", "pending");
  const real = meeting("2", "Weekly sync", "accepted");

  it("the reminder offers the answered meeting over an invitation at the same time", () => {
    expect(reminderEvent([stranger, real], start - 30_000)?.id).toBe("2");
  });

  it("the Join shortcut opens the answered meeting over an invitation at the same time", () => {
    expect(meetingToJoin([stranger, real], start - 10 * 60_000)?.id).toBe("2");
  });

  it("still offers an invitation when nothing answered is on", () => {
    expect(reminderEvent([stranger], start - 30_000)?.id).toBe("1");
    expect(meetingToJoin([stranger], start - 10 * 60_000)?.id).toBe("1");
  });

  it("an earlier invitation is not skipped for a later answered meeting", () => {
    const later = { ...real, startAt: start + 60 * 60_000, endAt: start + 90 * 60_000 };
    expect(meetingToJoin([stranger, later], start - 10 * 60_000)?.id).toBe("1");
  });
});

describe("the menu bar item for VoiceOver", () => {
  const start = new Date(2026, 10, 6, 19, 0).getTime();
  const call = { ...event, title: "Mini-Scrum", startAt: start, endAt: start + 30 * 60_000 };

  it("spells the countdown out", () => {
    expect(spokenStatus(call, start - 70 * 60_000)).toBe("starts in 1 hour 10 minutes");
    expect(spokenStatus(call, start - 60 * 60_000)).toBe("starts in 1 hour");
    expect(spokenStatus(call, start - 60_000)).toBe("starts in 1 minute");
    expect(spokenStatus(call, start + 60_000)).toBe("has just started");
    expect(spokenStatus(call, start + 25 * 60_000)).toBe("ends in 5 minutes");
  });

  it("gives the full date, then the meeting", () => {
    const now = start - 25 * 60_000;
    expect(trayDescription(now, call, "en-GB")).toBe(
      "Friday, 6 November 2026. Mini-Scrum starts in 25 minutes",
    );
    expect(trayDescription(now, null, "en-US")).toBe("Friday, November 6, 2026");
  });

  it("drops a meeting that is over", () => {
    expect(trayDescription(start + 31 * 60_000, call, "en-US")).toBe("Friday, November 6, 2026");
  });
});

describe("a meeting about to start beats a long block", () => {
  const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 9, hour, minute);
  const focus = { ...event, id: "focus", title: "Focus time", startAt: at(13), endAt: at(17) };
  const sync = {
    ...event,
    id: "sync",
    title: "Design sync",
    startAt: at(15),
    endAt: at(15, 30),
    joinUrl: "https://zoom.us/j/1",
  };
  const lead = (now: number) => leadEvent([focus, sync], now)?.id;

  it("keeps the running block until the meeting is near", () => {
    expect(lead(at(14, 30))).toBe("focus");
  });

  it("hands over ten minutes before the meeting", () => {
    expect(lead(at(14, 50))).toBe("sync");
  });

  it("keeps a running meeting that ends before the next begins", () => {
    const short = { ...focus, endAt: at(14, 55) };
    expect(leadEvent([short, sync], at(14, 50))?.id).toBe("focus");
  });

  it("drives the menu bar and the Join shortcut alike", () => {
    const options = { upcomingHorizonDays: 1, upcomingIconLeadMinutes: ICON_LEAD_ALWAYS, filters: included };
    expect(trayIconEvent([focus, sync], at(14, 52), options)?.id).toBe("sync");
    const focusCall = { ...focus, joinUrl: "https://zoom.us/j/2" };
    expect(meetingToJoin([focusCall, sync], at(14, 52))?.id).toBe("sync");
  });
});

describe("the day list follows the menu bar", () => {
  const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 9, hour, minute);
  const solo = { ...event, id: "solo", title: "Lunch", startAt: at(12), endAt: at(13), hasParticipants: false };
  const team = { ...event, id: "team", title: "Team call", startAt: at(14), endAt: at(14, 30) };

  it("marks the meeting the menu bar counts down to", () => {
    // The countdown skips Lunch (no one invited), so the list does too.
    const shown = dayCountdownEvents([solo, team], at(11, 30), team).map((item) => item.id);
    expect(shown).toEqual(["team"]);
  });

  it("finds its own when the menu bar counts nothing here", () => {
    const shown = dayCountdownEvents([solo, team], at(11, 30), null).map((item) => item.id);
    expect(shown).toEqual(["solo"]);
  });

  it("leaves a dismissed meeting unmarked", () => {
    const dismissed = [{ id: "solo", endAt: solo.endAt }];
    const shown = dayCountdownEvents([solo, team], at(11, 30), null, dismissed).map((item) => item.id);
    expect(shown).toEqual(["team"]);
  });
});

describe("folding today's finished meetings", () => {
  const at = (hour: number) => Date.UTC(2026, 10, 9, hour);
  const meeting = (id: string, hour: number) => ({ ...event, id, startAt: at(hour), endAt: at(hour) + 30 * 60_000 });
  const holiday = { ...event, id: "holiday", allDay: true, startAt: at(0), endAt: at(24) };

  it("folds two or more", () => {
    const folded = pastToFold([holiday, meeting("a", 9), meeting("b", 10), meeting("c", 15)], at(12));
    expect(folded.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("leaves a single finished meeting in place", () => {
    expect(pastToFold([meeting("a", 9), meeting("c", 15)], at(12))).toEqual([]);
  });
});

describe("reading the calendar", () => {
  const day = 86_400_000;
  const at = (days: number) => Date.UTC(2026, 10, 1) + days * day;

  it("reads the month, the selected day and the countdown window at once when they overlap", () => {
    const month = { start: at(-6), end: at(44) };
    const selected = { start: at(6), end: at(7) };
    const upcoming = { start: at(6.5), end: at(36) };
    expect(coveringRanges([month, selected, upcoming])).toEqual([month]);
  });

  it("keeps a far-away month apart from the countdown window", () => {
    const month = { start: at(360), end: at(410) };
    const upcoming = { start: at(6), end: at(7) };
    expect(coveringRanges([month, upcoming])).toEqual([upcoming, month]);
  });

  it("joins ranges that touch, and drops empty ones", () => {
    expect(
      coveringRanges([
        { start: at(0), end: at(1) },
        { start: at(1), end: at(2) },
        { start: at(5), end: at(5) },
      ]),
    ).toEqual([{ start: at(0), end: at(2) }]);
  });

  it("knows which events touch a range", () => {
    const range = { start: at(1), end: at(2) };
    expect(eventOverlaps({ startAt: at(0.5), endAt: at(1.5) }, range)).toBe(true);
    expect(eventOverlaps({ startAt: at(2), endAt: at(3) }, range)).toBe(false);
    expect(eventOverlaps({ startAt: at(0), endAt: at(1) }, range)).toBe(false);
  });
});

describe("the menu bar title", () => {
  const start = new Date(2026, 10, 9, 15, 0).getTime();
  const call = { startAt: start, endAt: start + 30 * 60_000, allDay: false, title: "Design sync" };
  const plain = { showTitle: false, showTime: false };

  it("is just the date with nothing to count down", () => {
    expect(trayTitle("Mon 9", null, start, plain)).toBe("Mon 9");
    expect(trayTitle(null, null, start, plain)).toBe("");
  });

  it("follows a date with a middle dot", () => {
    expect(trayTitle("Mon 9", call, start - 2 * 3_600_000 - 21 * 60_000, plain)).toBe(
      "Mon 9 \u00b7 in 2h 21m",
    );
  });

  it("needs no dot beside the glyph alone", () => {
    expect(trayTitle(null, call, start - 25 * 60_000, plain)).toBe("in 25m");
  });

  it("adds the time and name when Settings asks, and drops the time once it starts", () => {
    const both = { showTitle: true, showTime: true };
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
      new Date(start),
    );
    expect(trayTitle(null, call, start - 25 * 60_000, both, "en-US")).toBe(
      `in 25m ${time}  Design sync`,
    );
    expect(trayTitle("Mon 9", call, start + 15 * 60_000, both, "en-US")).toBe(
      "Mon 9 \u00b7 15m left Design sync",
    );
  });

  it("drops the countdown once the event is over", () => {
    expect(trayTitle("Mon 9", call, start + 31 * 60_000, plain)).toBe("Mon 9");
  });
});
