import { describe, expect, it } from "vitest";
import {
  googleDates,
  parseQuickEvent,
  quickAddAction,
  quickWhen,
  type DetectedDate,
  type QuickDraft,
} from "../src/shared/quick-add";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Sunday 8 November 2026, 9:00 local. */
const NOW = new Date(2026, 10, 8, 9).getTime();

function local(day: number, hour = 0, minute = 0, month = 10): number {
  return new Date(2026, month, day, hour, minute).getTime();
}

/** What macOS would report for `phrase` inside `input`. */
function found(input: string, phrase: string, at: number, durationSeconds = 0): DetectedDate[] {
  const start = input.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" is not in "${input}"`);
  return [{ start, length: phrase.length, at, duration: durationSeconds }];
}

function parse(input: string, phrase: string, at: number, durationSeconds = 0): QuickDraft {
  const draft = parseQuickEvent(input, found(input, phrase, at, durationSeconds), NOW);
  if (!draft) throw new Error(`no draft for "${input}"`);
  return draft;
}

function draft(extra: Partial<QuickDraft> = {}): QuickDraft {
  return {
    title: "Sync",
    startAt: local(9, 15),
    endAt: local(9, 16),
    allDay: false,
    location: null,
    guests: [],
    call: null,
    ...extra,
  };
}

describe("parseQuickEvent", () => {
  it("needs a date", () => {
    expect(parseQuickEvent("Buy milk", [], NOW)).toBeNull();
  });

  it("reads a title, time and place", () => {
    const event = parse("Lunch with Sam tomorrow 1pm at Blue Tokai", "tomorrow 1pm", local(9, 13));
    expect(event).toMatchObject({
      title: "Lunch with Sam",
      startAt: local(9, 13),
      endAt: local(9, 14),
      allDay: false,
      location: "Blue Tokai",
      guests: [],
      call: null,
    });
  });

  it("keeps a lowercase word after “at” in the title", () => {
    const event = parse("Look at designs tomorrow 10am", "tomorrow 10am", local(9, 10));
    expect(event.title).toBe("Look at designs");
    expect(event.location).toBeNull();
  });

  it("moves a time already past today to tomorrow", () => {
    const event = parse("Gym 7am", "7am", local(8, 7));
    expect(event.startAt).toBe(local(9, 7));
    expect(event.title).toBe("Gym");
  });

  it("leaves a past time alone when a day is named", () => {
    expect(parse("Gym today 7am", "today 7am", local(8, 7)).startAt).toBe(local(8, 7));
  });

  it("takes its length from “for …”", () => {
    const event = parse("Review for 30m tomorrow 3pm", "tomorrow 3pm", local(9, 15));
    expect(event.title).toBe("Review");
    expect(event.endAt - event.startAt).toBe(30 * MINUTE);
    expect(parse("Deep work for 2h tomorrow 9am", "tomorrow 9am", local(9, 9)).endAt).toBe(local(9, 11));
    const half = parse("Call mum for half an hour tomorrow 6pm", "tomorrow 6pm", local(9, 18));
    expect(half.endAt - half.startAt).toBe(30 * MINUTE);
    expect(half.title).toBe("Call mum");
  });

  it("takes its length from a range macOS found", () => {
    const event = parse("Workshop Fri 2-4pm", "Fri 2-4pm", local(13, 14), 2 * 3600);
    expect(event.endAt - event.startAt).toBe(2 * HOUR);
  });

  it("is all day without a time", () => {
    const event = parse("Holiday 24 Dec", "24 Dec", local(24, 12, 0, 11));
    expect(event).toMatchObject({
      title: "Holiday",
      allDay: true,
      startAt: local(24, 0, 0, 11),
      endAt: local(25, 0, 0, 11),
    });
  });

  it("spans the days of a date range", () => {
    const event = parse("Trip 10-12 Dec", "10-12 Dec", local(10, 12, 0, 11), 2 * 86_400);
    expect(event.allDay).toBe(true);
    expect(event.startAt).toBe(local(10, 0, 0, 11));
    expect(event.endAt).toBe(local(13, 0, 0, 11));
  });

  it("pulls out guests", () => {
    const event = parse(
      "Design sync with sam@example.com and ana@team.co tomorrow 3pm",
      "tomorrow 3pm",
      local(9, 15),
    );
    expect(event.guests).toEqual(["sam@example.com", "ana@team.co"]);
    expect(event.title).toBe("Design sync");
  });

  it("finds the call asked for", () => {
    expect(parse("Standup on zoom tomorrow 10am", "tomorrow 10am", local(9, 10))).toMatchObject({
      title: "Standup",
      call: "zoom",
    });
    expect(parse("1:1 google meet tomorrow 10am", "tomorrow 10am", local(9, 10)).call).toBe("meet");
    expect(parse("Review over teams tomorrow 10am", "tomorrow 10am", local(9, 10)).call).toBe("teams");
    expect(parse("Catch up on meet tomorrow 10am", "tomorrow 10am", local(9, 10)).call).toBe("meet");
  });

  it("reads “meet” alone as a verb", () => {
    const event = parse("Meet Sam tomorrow 10am", "tomorrow 10am", local(9, 10));
    expect(event.call).toBeNull();
    expect(event.title).toBe("Meet Sam");
  });

  it("names an event with nothing else in it", () => {
    expect(parse("tomorrow 3pm", "tomorrow 3pm", local(9, 15)).title).toBe("New Event");
  });
});

describe("quickAddAction", () => {
  const link = "https://zoom.us/j/123";

  it("hands guests to Google Calendar", () => {
    expect(quickAddAction(draft({ guests: ["sam@example.com"] }), link)).toEqual({ kind: "google" });
  });

  it("attaches your meeting link to a call", () => {
    expect(quickAddAction(draft({ call: "zoom" }), link)).toEqual({ kind: "create", url: link });
    expect(quickAddAction(draft({ call: "meet" }), link)).toEqual({ kind: "create", url: link });
  });

  it("sends a Meet with no link of your own to Google Calendar", () => {
    expect(quickAddAction(draft({ call: "meet" }), "")).toEqual({ kind: "google" });
  });

  it("creates everything else here", () => {
    expect(quickAddAction(draft(), link)).toEqual({ kind: "create", url: null });
    expect(quickAddAction(draft({ call: "zoom" }), "")).toEqual({ kind: "create", url: null });
  });
});

describe("googleDates", () => {
  it("writes times in UTC", () => {
    const value = googleDates({
      startAt: Date.UTC(2026, 10, 9, 7, 30),
      endAt: Date.UTC(2026, 10, 9, 8, 30),
      allDay: false,
    });
    expect(value).toBe("20261109T073000Z/20261109T083000Z");
  });

  it("writes all-day events as local dates, the end exclusive", () => {
    expect(googleDates({ startAt: local(24, 0, 0, 11), endAt: local(25, 0, 0, 11), allDay: true })).toBe(
      "20261224/20261225",
    );
  });
});

describe("quickWhen", () => {
  it("says all day for one day", () => {
    expect(
      quickWhen({ startAt: local(24, 0, 0, 11), endAt: local(25, 0, 0, 11), allDay: true }, "en-GB"),
    ).toBe("Thu 24 Dec, all day");
  });

  it("gives a range of days", () => {
    expect(
      quickWhen({ startAt: local(10, 0, 0, 11), endAt: local(13, 0, 0, 11), allDay: true }, "en-GB"),
    ).toBe("10 Dec – 12 Dec, all day");
  });

  it("gives the day and times", () => {
    const text = quickWhen({ startAt: local(9, 13), endAt: local(9, 14), allDay: false }, "en-US");
    expect(text).toMatch(/^Mon, Nov 9, 1:00\s?–\s?2:00\sPM$/);
  });
});
