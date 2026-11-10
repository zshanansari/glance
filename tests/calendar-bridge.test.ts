import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));

import { api } from "../src/renderer/host";

beforeEach(() => invoke.mockReset());

it("passes calendar range arguments using Tauri's camelCase command convention", async () => {
  invoke.mockResolvedValue([]);
  await expect(api.getCalendarEvents(1000, 2000)).resolves.toEqual([]);
  expect(invoke).toHaveBeenCalledWith("get_calendar_events", {
    startAt: 1000,
    endAt: 2000,
  });
});

it("dismisses an upcoming occurrence with its end time", async () => {
  invoke.mockResolvedValue(undefined);
  await expect(api.dismissUpcomingEvent("event-1", 2000)).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("dismiss_upcoming_event", {
    id: "event-1",
    endAt: 2000,
  });
});

it("lists calendars through the same command bridge", async () => {
  invoke.mockResolvedValue([]);
  await expect(api.listCalendars()).resolves.toEqual([]);
  expect(invoke).toHaveBeenCalledWith("list_calendars");
});

it("waits for the native calendar permission result", async () => {
  invoke.mockResolvedValue(true);
  await expect(api.requestCalendarAccess()).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledWith("request_calendar_access");
});

it("opens About links through their own command, not the meeting one", async () => {
  invoke.mockResolvedValue(undefined);
  await expect(api.openUrl("https://github.com/zshanansari")).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("open_link", { url: "https://github.com/zshanansari" });
});

it("names the menu's Join item, or takes it off with null", async () => {
  invoke.mockResolvedValue(undefined);
  await api.setJoinMenu("Design review at 3:00 PM");
  expect(invoke).toHaveBeenCalledWith("set_join_menu", { label: "Design review at 3:00 PM" });
  await api.setJoinMenu(null);
  expect(invoke).toHaveBeenCalledWith("set_join_menu", { label: null });
});

it("ticks a reminder off and back on by its id", async () => {
  invoke.mockResolvedValue(undefined);
  await api.completeReminder("reminder:ABC");
  expect(invoke).toHaveBeenCalledWith("complete_reminder", { id: "reminder:ABC" });
  await api.undoCompletedReminder("reminder:ABC");
  expect(invoke).toHaveBeenCalledWith("undo_completed_reminder", { id: "reminder:ABC" });
});

it("lets the calendar window call the commands it was given", async () => {
  // A command missing from the window's capability is refused at run time
  // with nothing on screen, so the grant is checked here.
  const { readFileSync } = await import("node:fs");
  const capability = JSON.parse(readFileSync("src-tauri/capabilities/calendar.json", "utf8"));
  const commands = readFileSync("src-tauri/build.rs", "utf8");
  for (const command of ["set_join_menu", "complete_reminder", "undo_completed_reminder"]) {
    expect(commands).toContain(`"${command}"`);
    expect(capability.permissions).toContain(`allow-${command.replace(/_/g, "-")}`);
  }
});
