import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAY_HIGHLIGHTS,
  DEFAULT_SETTINGS,
  MENU_BAR_ICONS,
  calendarsOfKind,
  groupCalendarsBySource,
  highlightedColumnRuns,
  menuBarLabel,
  trayLabelKey,
  upcomingHorizonLabel,
  upcomingIconLeadLabel,
  highlightDaysFrom,
} from "../src/shared/settings";

// The host (settings.rs) reads, migrates and checks the settings file; this
// side only needs the same defaults and the same choices, so both are held
// to one fixture.
const defaults = JSON.parse(readFileSync("tests/fixtures/default-settings.json", "utf8"));

describe("settings shared with the host", () => {
  it("starts from the same defaults as settings.rs", () => {
    expect(DEFAULT_SETTINGS).toEqual(defaults);
  });

  it("offers the same colors for today as settings.rs accepts", () => {
    const rust = readFileSync("src-tauri/src/settings.rs", "utf8");
    const block = rust.slice(rust.indexOf("DAY_HIGHLIGHTS"), rust.indexOf("];", rust.indexOf("DAY_HIGHLIGHTS")));
    const hostIds = [...block.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    expect(DAY_HIGHLIGHTS.map((option) => option.id).sort()).toEqual(hostIds.sort());
  });

  it("offers the same menu bar styles as settings.rs accepts", () => {
    const rust = readFileSync("src-tauri/src/settings.rs", "utf8");
    const start = rust.indexOf("MENU_BAR_ICONS");
    const block = rust.slice(start, rust.indexOf("];", start));
    const hostIds = [...block.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    expect(MENU_BAR_ICONS.map(({ id }) => id).sort()).toEqual(hostIds.sort());
  });
});

describe("calendar lists", () => {
  it("groups calendars by account and sorts titles", () => {
    expect(
      groupCalendarsBySource([
        { id: "2", title: "Work", source: "iCloud", color: "#338ce6" },
        { id: "1", title: "Home", source: "iCloud", color: null },
        { id: "3", title: "Holidays", source: "Google", color: null },
        { id: "4", title: "Local", source: null, color: null },
      ]),
    ).toEqual([
      {
        source: "Google",
        calendars: [{ id: "3", title: "Holidays", source: "Google", color: null }],
      },
      {
        source: "iCloud",
        calendars: [
          { id: "1", title: "Home", source: "iCloud", color: null },
          { id: "2", title: "Work", source: "iCloud", color: "#338ce6" },
        ],
      },
      {
        source: "Other",
        calendars: [{ id: "4", title: "Local", source: null, color: null }],
      },
    ]);
  });

  it("keeps event calendars and reminder lists apart", () => {
    const items = [
      { id: "1", title: "Home", source: "iCloud", color: null },
      { id: "5", title: "Groceries", source: "iCloud", color: null, kind: "reminder" as const },
    ];
    expect(calendarsOfKind(items, "event")).toEqual([items[0]]);
    expect(calendarsOfKind(items, "reminder")).toEqual([items[1]]);
  });

  it("names the icon lead and list window the way Settings shows them", () => {
    expect(upcomingHorizonLabel(1)).toBe("Today");
    expect(upcomingHorizonLabel(2)).toBe("Today and tomorrow");
    expect(upcomingHorizonLabel(5)).toBe("5 days");
    expect(upcomingHorizonLabel(7)).toBe("1 week");
    expect(upcomingHorizonLabel(14)).toBe("2 weeks");
    expect(upcomingHorizonLabel(30)).toBe("1 month");
    expect(upcomingIconLeadLabel(0)).toBe("Always");
    expect(upcomingIconLeadLabel(1)).toBe("At start of event");
    expect(upcomingIconLeadLabel(15)).toBe("15 minutes before");
    expect(upcomingIconLeadLabel(60)).toBe("1 hour before");
    expect(upcomingIconLeadLabel(240)).toBe("4 hours before");
    expect(upcomingIconLeadLabel(1440)).toBe("24 hours before");
  });
});

describe("menu bar label", () => {
  const date = new Date(2026, 8, 8, 12);
  const filled = { menuBarIcon: "filled" as const, showWeekday: false, showMonth: false };

  it("keeps the date in the glyph when the style is dated", () => {
    expect(menuBarLabel(filled, date, "en-US")).toEqual({
      text: null,
      day: 8,
      style: "filled",
    });
    expect(menuBarLabel({ ...filled, menuBarIcon: "framed" }, date, "en-US").day).toBe(
      null,
    );
  });

  it("puts the weekday and month beside the filled glyph, which shows the day", () => {
    expect(
      menuBarLabel({ menuBarIcon: "filled", showWeekday: true, showMonth: true }, date, "en-US"),
    ).toEqual({ text: "Tue Sep", day: 8, style: "filled" });
    expect(
      menuBarLabel({ menuBarIcon: "filled", showWeekday: false, showMonth: true }, date, "en-US"),
    ).toEqual({ text: "Sep", day: 8, style: "filled" });
  });

  it("gives the dotted calendar the full date once a part is switched on", () => {
    expect(MENU_BAR_ICONS.map(({ id }) => id)).toEqual(["filled", "calendar", "framed", "none"]);
    expect(
      menuBarLabel({ menuBarIcon: "calendar", showWeekday: false, showMonth: false }, date).text,
    ).toBeNull();
    expect(
      menuBarLabel({ menuBarIcon: "calendar", showWeekday: true, showMonth: false }, date, "en-US")
        .text,
    ).toBe("Tue 8");
    expect(
      menuBarLabel({ menuBarIcon: "calendar", showWeekday: true, showMonth: true }, date, "en-US")
        .text,
    ).toBe("Tue 8 Sep");
  });

  it("spells the date out for the framed glyph", () => {
    expect(
      menuBarLabel({ menuBarIcon: "framed", showWeekday: false, showMonth: false }, date, "en-US")
        .text,
    ).toBe("8");
    expect(
      menuBarLabel({ menuBarIcon: "framed", showWeekday: true, showMonth: true }, date, "en-US")
        .text,
    ).toBe("Tue 8 Sep");
  });

  it("redraws the framed glyph when weekday or month parts change", () => {
    const day = trayLabelKey(
      menuBarLabel({ menuBarIcon: "framed", showWeekday: false, showMonth: false }, date, "en-US"),
    );
    const withMonth = trayLabelKey(
      menuBarLabel({ menuBarIcon: "framed", showWeekday: false, showMonth: true }, date, "en-US"),
    );
    const withWeekday = trayLabelKey(
      menuBarLabel({ menuBarIcon: "framed", showWeekday: true, showMonth: false }, date, "en-US"),
    );
    expect(day).not.toBe(withMonth);
    expect(day).not.toBe(withWeekday);
    expect(withMonth).not.toBe(withWeekday);
  });

  it("drops the glyph for no-icon, and keeps a date in the title", () => {
    expect(
      menuBarLabel({ menuBarIcon: "none", showWeekday: true, showMonth: false }, date, "en-US"),
    ).toEqual({
      text: "Tue 8",
      day: null,
      style: "none",
    });
  });
});

describe("highlighted columns", () => {
  it("joins Saturday and Sunday when they sit together", () => {
    expect(highlightedColumnRuns(1, [0, 6])).toEqual([{ start: 5, count: 2 }]);
  });

  it("splits them when the week starts on Sunday", () => {
    expect(highlightedColumnRuns(0, [0, 6])).toEqual([
      { start: 0, count: 1 },
      { start: 6, count: 1 },
    ]);
  });

  it("covers the whole grid when every day is on", () => {
    expect(highlightedColumnRuns(0, [0, 1, 2, 3, 4, 5, 6])).toEqual([
      { start: 0, count: 7 },
    ]);
  });
});

describe("dayHighlight and onboarded", () => {
  it("default to red and an unseen welcome", () => {
    expect(DEFAULT_SETTINGS.dayHighlight).toBe("red");
    expect(DEFAULT_SETTINGS.onboarded).toBe(false);
  });
});

describe("highlight days", () => {
  it("run in the month's column order", () => {
    expect(highlightDaysFrom(0).map((day) => day.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(highlightDaysFrom(1).map((day) => day.id)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(highlightDaysFrom(6).map((day) => day.id)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
});
