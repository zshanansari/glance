import { describe, expect, it } from "vitest";
import { checkedWhen, updateFailureReason, updateStatusLine } from "../src/shared/updates";

const now = new Date(2026, 10, 7, 15, 0).getTime();
const status = { checkedAt: null, error: null, version: null, notes: null };

describe("the update status line", () => {
  it("says nothing before any check", () => {
    expect(updateStatusLine(status, now)).toBe("");
  });

  it("says when it last found nothing new", () => {
    const checkedAt = new Date(2026, 10, 7, 14, 30).getTime();
    expect(updateStatusLine({ ...status, checkedAt }, now, "en-US")).toBe(
      "Up to date. Checked today at 2:30 PM.",
    );
  });

  it("names a waiting version", () => {
    expect(updateStatusLine({ ...status, checkedAt: now, version: "0.8.1" }, now)).toBe(
      "Version 0.8.1 is ready to install.",
    );
  });

  it("says why a check failed", () => {
    expect(
      updateStatusLine({ ...status, checkedAt: now, error: "error sending request for url" }, now),
    ).toBe("Couldn’t reach GitHub. Check your connection and try again.");
  });
});

describe("when a check ran", () => {
  it("reads yesterday and older dates naturally", () => {
    expect(checkedWhen(new Date(2026, 10, 6, 21, 5).getTime(), now, "en-US")).toBe(
      "yesterday at 9:05 PM",
    );
    expect(checkedWhen(new Date(2026, 10, 4, 10, 0).getTime(), now, "en-GB")).toBe(
      "4 Nov at 10:00",
    );
  });
});

describe("a failure reason", () => {
  it("keeps other messages, shortened", () => {
    expect(updateFailureReason("This update couldn't be verified")).toBe(
      "This update couldn't be verified",
    );
    expect(updateFailureReason("x".repeat(300))).toHaveLength(140);
  });
});
