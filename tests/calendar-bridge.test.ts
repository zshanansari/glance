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
