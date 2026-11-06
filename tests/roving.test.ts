import { describe, expect, it } from "vitest";
import { rovingTarget } from "../src/shared/roving";

describe("arrow keys in a one-stop group", () => {
  const items = ["general", "appearance", "calendar", "events", "about"];

  it("moves down and up, wrapping at the ends", () => {
    expect(rovingTarget(items, 0, "ArrowDown")).toBe("appearance");
    expect(rovingTarget(items, 0, "ArrowUp")).toBe("about");
    expect(rovingTarget(items, 4, "ArrowDown")).toBe("general");
  });

  it("treats left and right like up and down", () => {
    expect(rovingTarget(items, 2, "ArrowLeft")).toBe("appearance");
    expect(rovingTarget(items, 2, "ArrowRight")).toBe("events");
  });

  it("jumps to either end", () => {
    expect(rovingTarget(items, 2, "Home")).toBe("general");
    expect(rovingTarget(items, 2, "End")).toBe("about");
  });

  it("ignores other keys and empty groups", () => {
    expect(rovingTarget(items, 2, "Tab")).toBeNull();
    expect(rovingTarget([], 0, "ArrowDown")).toBeNull();
  });
});
