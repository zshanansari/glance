import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESERVED_CHORDS, chordFromKeyboard, chordLabel, chordProblem } from "../src/shared/shortcuts";

const chord = (overrides: Partial<Parameters<typeof chordFromKeyboard>[0]>) =>
  chordFromKeyboard({
    code: "KeyK",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  });

describe("recording a chord", () => {
  it("writes the modifiers the host parses, in a fixed order", () => {
    expect(chord({ ctrlKey: true, metaKey: true })).toBe("Control+Command+KeyK");
    expect(chord({ altKey: true, shiftKey: true, metaKey: true })).toBe(
      "Alt+Shift+Command+KeyK",
    );
  });

  it("refuses a bare key or one held with Shift alone", () => {
    expect(chord({})).toBeNull();
    expect(chord({ shiftKey: true })).toBeNull();
  });

  it("refuses a modifier with no key of its own", () => {
    expect(chord({ code: "MetaLeft", metaKey: true })).toBeNull();
    expect(chord({ code: "CapsLock", ctrlKey: true })).toBeNull();
  });

  it("takes function keys, digits, and punctuation", () => {
    expect(chord({ code: "F5", ctrlKey: true })).toBe("Control+F5");
    expect(chord({ code: "Digit1", metaKey: true })).toBe("Command+Digit1");
    expect(chord({ code: "ArrowUp", altKey: true })).toBe("Alt+ArrowUp");
  });
});

describe("showing a chord", () => {
  it("reads as macOS writes it", () => {
    expect(chordLabel("Control+Command+KeyK")).toBe("⌃⌘K");
    expect(chordLabel("Alt+Shift+Command+Digit1")).toBe("⌥⇧⌘1");
    expect(chordLabel("Control+ArrowUp")).toBe("⌃↑");
  });

  it("understands the spellings the host also accepts", () => {
    expect(chordLabel("CmdOrCtrl+KeyK")).toBe("\u2318K");
    expect(chordLabel("Ctrl+Cmd+KeyK")).toBe("⌃⌘K");
  });

  it("has nothing to show for an unset shortcut", () => {
    expect(chordLabel("")).toBe("");
    expect(chordLabel("   ")).toBe("");
  });
});

describe("refused chords", () => {
  it("keeps macOS's own chords for macOS", () => {
    expect(chordProblem("Command+KeyQ", "", "")).toMatch(/^⌘Q belongs to macOS/);
    expect(chordProblem("Control+Space", "", "")).not.toBeNull();
  });

  it("will not give one chord two jobs", () => {
    expect(chordProblem("Control+Command+KeyK", "Control+Command+KeyK", "shows the calendar")).toBe(
      "⌃⌘K already shows the calendar. Try another.",
    );
  });

  it("knows a stored chord and a recorded one are the same", () => {
    expect(chordProblem("Control+Command+KeyK", "Control+Command+K", "shows the calendar")).toBe(
      "⌃⌘K already shows the calendar. Try another.",
    );
  });

  it("accepts a free chord", () => {
    expect(chordProblem("Control+Command+KeyJ", "Control+Command+KeyK", "shows the calendar")).toBeNull();
  });

  it("lists the same reserved chords as the host", () => {
    const rust = readFileSync("src-tauri/src/settings.rs", "utf8");
    const block = rust.slice(rust.indexOf("pub const RESERVED_CHORDS"), rust.indexOf("];", rust.indexOf("pub const RESERVED_CHORDS")));
    const hostList = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(hostList).toEqual([...RESERVED_CHORDS]);
  });
});
