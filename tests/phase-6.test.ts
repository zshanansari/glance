import { afterEach, describe, expect, it } from "vitest";
import { atNoon, buildMonth, rowWeekNumber, usWeekNumber } from "../src/shared/calendar";
import {
  comingDayGroups,
  comingDayTitle,
  COMING_ROWS,
  IN_PERSON_LEAD_MS,
  isInPerson,
  reminderEvent,
  searchDayTitle,
  searchEvents,
  SEARCH_LIMIT,
  type UpcomingEvent,
} from "../src/shared/events";
import { dateFormat, setRegion } from "../src/shared/region";
import { isTimeZone, knownTimeZones, zoneCity, zoneShort, zoneTime } from "../src/shared/zones";
import { reminderStep, SNOOZE_MS, takeDueSnooze } from "../src/renderer/reminder";

const MINUTE = 60_000;

/** An event at a local time, so day grouping holds in any time zone. */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  extra: Partial<UpcomingEvent> = {},
): UpcomingEvent {
  const startAt = new Date(year, month, day, hour).getTime();
  return {
    id: `${year}-${month}-${day}-${hour}-${extra.title ?? "event"}`,
    title: "Event",
    startAt,
    endAt: startAt + 30 * MINUTE,
    calendar: "Work",
    color: null,
    location: null,
    joinUrl: null,
    response: "accepted",
    kind: "event",
    allDay: false,
    hasParticipants: true,
    ...extra,
  };
}

describe("language and region", () => {
  afterEach(() => setRegion(null));

  it("writes times in the Mac's clock style, whatever the language's habit", () => {
    const noonPast = new Date(2026, 10, 9, 15, 5);
    setRegion({ locale: "en-US", hour12: false, firstWeekday: 1, region: "US" });
    expect(dateFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(noonPast)).toBe(
      "15:05",
    );
    setRegion({ locale: "en-GB", hour12: true, firstWeekday: 2, region: "GB" });
    expect(
      dateFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(noonPast).toLowerCase(),
    ).toMatch(/^3:05\s?pm$/);
  });

  it("writes dates in the region's language", () => {
    setRegion({ locale: "fr-FR", hour12: false, firstWeekday: 2, region: "FR" });
    expect(dateFormat(undefined, { month: "long" }).format(new Date(2026, 10, 9))).toBe(
      "novembre",
    );
  });

  it("lets a locale passed in win, as tests do", () => {
    setRegion({ locale: "fr-FR", hour12: false, firstWeekday: 2, region: "FR" });
    expect(dateFormat("en-US", { month: "long" }).format(new Date(2026, 10, 9))).toBe("November");
  });
});

describe("US week numbers", () => {
  it("count week 1 from the week holding 1 January", () => {
    expect(usWeekNumber(new Date(2026, 0, 1))).toBe(1);
    expect(usWeekNumber(new Date(2026, 0, 3))).toBe(1);
    expect(usWeekNumber(new Date(2026, 0, 4))).toBe(2);
    expect(usWeekNumber(new Date(2026, 11, 20))).toBe(52);
  });

  it("number a row by its Sunday, or 1 when it holds New Year's Day", () => {
    const january = buildMonth(2026, 0, 0, atNoon(2026, 0, 15));
    const second = january.weeks.find((week) => week.some((day) => day.iso === "2026-01-05"))!;
    expect(rowWeekNumber(second, "us")).toBe(2);
    expect(rowWeekNumber(second, "iso")).toBe(2);
    const december = buildMonth(2026, 11, 0, atNoon(2026, 11, 15));
    const last = december.weeks.find((week) => week.some((day) => day.iso === "2026-12-31"))!;
    expect(rowWeekNumber(last, "us")).toBe(1);
    expect(rowWeekNumber(last, "iso")).toBe(53);
  });

  it("follow the Sunday on a Monday-first month too", () => {
    const month = buildMonth(2026, 0, 1, atNoon(2026, 0, 15));
    const row = month.weeks.find((week) => week.some((day) => day.iso === "2026-01-05"))!;
    // Mon 5 – Sun 11: the US counts it by Sunday 11, week 3.
    expect(rowWeekNumber(row, "us")).toBe(3);
  });
});

describe("snoozing the reminder", () => {
  const start = new Date(2026, 10, 9, 15).getTime();
  const call = at(2026, 10, 9, 15, { joinUrl: "https://zoom.us/j/1" });

  it("brings the meeting back once its five minutes are up", () => {
    const snoozes = [{ event: call, until: start - MINUTE + SNOOZE_MS }];
    expect(takeDueSnooze(snoozes, start).due).toBeNull();
    expect(takeDueSnooze(snoozes, start + 4 * MINUTE).due?.event).toBe(call);
  });

  it("drops a snooze whose meeting has ended", () => {
    const snoozes = [{ event: call, until: start + 5 * MINUTE }];
    expect(takeDueSnooze(snoozes, call.endAt)).toEqual({ due: null, keep: [] });
  });

  it("keeps a card back from a snooze for its full few minutes", () => {
    const shownAt = start + 4 * MINUTE;
    // Past the usual five minutes after the start, but shown only a minute ago.
    expect(reminderStep(call, true, start + 6 * MINUTE, shownAt)).toBe("refresh");
    expect(reminderStep(call, true, shownAt + 5 * MINUTE, shownAt)).toBe("hide");
    expect(reminderStep(call, false, start + 6 * MINUTE, shownAt)).toBe("hide");
  });
});

describe("coming days", () => {
  const now = new Date(2026, 10, 9, 18).getTime();

  it("groups the next days, skipping empty ones", () => {
    const events = [
      at(2026, 10, 9, 20, { title: "Tonight" }),
      at(2026, 10, 10, 9, { title: "Tomorrow" }),
      at(2026, 10, 12, 9, { title: "Thursday" }),
      at(2026, 10, 13, 9, { title: "Too far" }),
    ];
    const groups = comingDayGroups(events, now, 3);
    expect(groups.map((group) => group.events.map((event) => event.title))).toEqual([
      ["Tomorrow"],
      ["Thursday"],
    ]);
    expect(groups[0]!.day).toEqual(new Date(2026, 10, 10));
  });

  it("stops at a handful of rows", () => {
    const busy = Array.from({ length: 12 }, (_, hour) => at(2026, 10, 10, 8 + hour, { title: `${hour}` }));
    const groups = comingDayGroups(busy, now, 7);
    expect(groups.flatMap((group) => group.events)).toHaveLength(COMING_ROWS);
  });

  it("names tomorrow, then the date", () => {
    expect(comingDayTitle(new Date(2026, 10, 10), now, "en-GB")).toBe("Tomorrow");
    expect(comingDayTitle(new Date(2026, 10, 12), now, "en-GB")).toBe("Thu 12 Nov");
  });
});

describe("a second time zone", () => {
  it("knows real zones and refuses made-up ones", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(knownTimeZones()).toContain("America/New_York");
  });

  it("lists zones by today's names, not the old spellings", () => {
    const zones = knownTimeZones();
    expect(zones).toContain("Asia/Kolkata");
    expect(zones).toContain("Europe/Kyiv");
    expect(zones).not.toContain("Asia/Calcutta");
    expect(zones).not.toContain("Europe/Kiev");
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("names the city, and shortens it for the menu bar", () => {
    expect(zoneCity("America/New_York")).toBe("New York");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneShort("America/New_York")).toBe("NY");
    expect(zoneShort("Asia/Tokyo")).toBe("Tokyo");
    expect(zoneShort("Asia/Singapore")).toBe("Sin");
  });

  it("gives the time there, daylight saving included", () => {
    const winter = Date.UTC(2026, 0, 15, 15, 0);
    const summer = Date.UTC(2026, 6, 15, 15, 0);
    expect(zoneTime(winter, "America/New_York", "en-US")).toBe("10:00 AM");
    expect(zoneTime(summer, "America/New_York", "en-US")).toBe("11:00 AM");
    expect(zoneTime(winter, "Asia/Kolkata", "en-GB")).toBe("20:30");
  });
});

describe("in-person reminders", () => {
  const start = new Date(2026, 10, 9, 15).getTime();
  const room = at(2026, 10, 9, 15, { title: "Lunch", location: "Cafe Rio, 5th Ave" });
  const call = at(2026, 10, 9, 15, { title: "Call", joinUrl: "https://zoom.us/j/1" });

  it("counts a meeting with a place and no link", () => {
    expect(isInPerson(room)).toBe(true);
    expect(isInPerson(call)).toBe(false);
    expect(isInPerson({ ...room, location: "  " })).toBe(false);
    expect(isInPerson({ ...room, location: "https://example.com/room" })).toBe(false);
  });

  it("reminds ten minutes ahead only when switched on", () => {
    const tenOut = start - IN_PERSON_LEAD_MS + 1_000;
    expect(reminderEvent([room], tenOut)).toBeNull();
    expect(reminderEvent([room], tenOut, [], () => false, true)).toBe(room);
    expect(reminderEvent([room], start - 12 * MINUTE, [], () => false, true)).toBeNull();
  });

  it("keeps calls at a minute ahead", () => {
    expect(reminderEvent([call], start - 5 * MINUTE, [], () => false, true)).toBeNull();
    expect(reminderEvent([call], start - MINUTE, [], () => false, true)).toBe(call);
  });

  it("skips a declined meeting in a room", () => {
    const declined = { ...room, response: "declined" as const };
    expect(reminderEvent([declined], start - 5 * MINUTE, [], () => false, true)).toBeNull();
  });
});

describe("search", () => {
  const now = new Date(2026, 10, 9, 12).getTime();
  const events = [
    at(2026, 10, 2, 10, { title: "Design review" }),
    at(2026, 10, 9, 15, { title: "Lunch", location: "Café Rio" }),
    at(2026, 10, 11, 9, { title: "design SYNC" }),
    at(2026, 10, 11, 14, { title: "Planning" }),
  ];

  it("matches every word in title or location, ignoring case and accents", () => {
    const titles = (query: string) =>
      searchEvents(events, query, now).flatMap((group) => group.events.map((e) => e.title));
    expect(titles("design")).toEqual(["design SYNC", "Design review"]);
    expect(titles("cafe")).toEqual(["Lunch"]);
    expect(titles("design sync")).toEqual(["design SYNC"]);
    expect(titles("nothing")).toEqual([]);
    expect(titles("   ")).toEqual([]);
  });

  it("lists today and later first, then earlier days, most recent first", () => {
    const more = [
      ...events,
      at(2026, 10, 5, 10, { title: "Design crit" }),
      at(2026, 10, 9, 9, { title: "Design huddle" }),
    ];
    const groups = searchEvents(more, "design", now);
    expect(groups.map((group) => group.day)).toEqual([
      new Date(2026, 10, 9),
      new Date(2026, 10, 11),
      new Date(2026, 10, 5),
      new Date(2026, 10, 2),
    ]);
  });

  it("keeps the results nearest now when there are too many", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      at(2026, 10, 9 + (index - 20), 9, { title: `Standup ${index}` }),
    );
    const found = searchEvents(many, "standup", now).flatMap((group) => group.events);
    expect(found).toHaveLength(SEARCH_LIMIT);
    expect(found.map((event) => event.title)).toContain("Standup 20");
    expect(found.map((event) => event.title)).not.toContain("Standup 0");
  });

  it("lists a repeated read of the same occurrence once", () => {
    expect(searchEvents([events[1]!, events[1]!], "lunch", now)[0]!.events).toHaveLength(1);
  });

  it("names the days around today in words", () => {
    expect(searchDayTitle(new Date(2026, 10, 9), now)).toBe("Today");
    expect(searchDayTitle(new Date(2026, 10, 10), now)).toBe("Tomorrow");
    expect(searchDayTitle(new Date(2026, 10, 8), now)).toBe("Yesterday");
    expect(searchDayTitle(new Date(2026, 10, 2), now, "en-GB")).toBe("Mon 2 Nov");
    expect(searchDayTitle(new Date(2027, 0, 4), now, "en-GB")).toMatch(/^Mon,? 4 Jan 2027$/);
  });
});
