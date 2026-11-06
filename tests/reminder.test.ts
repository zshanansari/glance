import { describe, expect, it } from "vitest";
import { reminderHeading } from "../src/renderer/reminder";
import type { UpcomingEvent } from "../src/shared/events";

const start = Date.UTC(2026, 10, 9, 15, 0);
const call: UpcomingEvent = {
  id: "call",
  title: "Design sync",
  startAt: start,
  endAt: start + 30 * 60_000,
  calendar: null,
  color: null,
  location: null,
  joinUrl: "https://zoom.us/j/1",
  response: "accepted",
  kind: "event",
  allDay: false,
  hasParticipants: true,
};

describe("the reminder card's heading", () => {
  it("says how soon in full words", () => {
    expect(reminderHeading(call, start - 60_000)).toBe("Starts in 1 minute");
    expect(reminderHeading(call, start - 125 * 60_000)).toBe("Starts in 2 hours 5 minutes");
  });

  it("says when the meeting is under way", () => {
    expect(reminderHeading(call, start + 2 * 60_000)).toBe("Happening now");
  });
});
