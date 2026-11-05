import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, CalendarInfo } from "../shared/settings";
import type { DismissedOccurrence, UpcomingEvent } from "../shared/events";

/** An empty version means the running build is current. */
export type UpdateOffer = { version: string; notes: string };

export type DesktopApi = {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  setTrayLabel: (
    title: string | null,
    iconDay: number | null,
    style: AppSettings["menuBarIcon"],
    image: number[] | null,
  ) => Promise<void>;
  beep: () => Promise<void>;
  getCalendarEvents: (startAt: number, endAt: number) => Promise<UpcomingEvent[]>;
  getDismissedEvents: () => Promise<DismissedOccurrence[]>;
  dismissUpcomingEvent: (id: string, endAt: number) => Promise<void>;
  listCalendars: () => Promise<CalendarInfo[]>;
  requestCalendarAccess: () => Promise<boolean>;
  getCalendarAccess: () => Promise<boolean>;
  requestRemindersAccess: () => Promise<boolean>;
  getRemindersAccess: () => Promise<boolean>;
  openCalendarPrivacy: () => Promise<void>;
  openRemindersPrivacy: () => Promise<void>;
  joinMeeting: (url: string) => Promise<void>;
  openEvent: (id: string) => Promise<void>;
  checkForUpdates: () => Promise<UpdateOffer>;
  installUpdate: () => Promise<void>;
  /** The version a background check found and nobody has installed yet. */
  getUpdateAvailable: () => Promise<string | null>;
  onUpdateAvailable: (listener: (version: string | null) => void) => () => void;
  /** An install started from the menu bar failed; carries the reason. */
  onUpdateFailed: (listener: (message: string) => void) => () => void;
  openRepository: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  onUpdateProgress: (
    listener: (progress: { downloaded: number; total: number | null }) => void,
  ) => () => void;
  hideCalendar: () => Promise<void>;
  showReminder: () => Promise<boolean>;
  hideReminder: () => Promise<void>;
  hideSettings: () => Promise<void>;
  getSidebarSize: () => Promise<"small" | "medium" | "large">;
  setReminderHeight: (height: number) => Promise<void>;
  setCalendarHeight: (height: number) => Promise<void>;
  getPopoverMaterial: () => Promise<string>;
  setCalendarPinned: (pinned: boolean) => Promise<void>;
  openSettings: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  onSettingsChanged: (listener: (settings: AppSettings) => void) => () => void;
  onCalendarShown: (listener: () => void) => () => void;
  onCalendarHidden: (listener: () => void) => () => void;
  onClockTick: (listener: () => void) => () => void;
  onEventDismissed: (listener: () => void) => () => void;
  onJoinUpcomingRequested: (listener: () => void) => () => void;
};

function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void listen<T>(event, (message) => handler(message.payload))
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export const api: DesktopApi = {
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (patch) => invoke<AppSettings>("update_settings", { patch }),
  setTrayLabel: (title, iconDay, style, image) =>
    invoke<void>("set_tray_label", { title, iconDay, style, image }),
  beep: () => invoke<void>("beep"),
  getCalendarEvents: (startAt, endAt) =>
    invoke<UpcomingEvent[]>("get_calendar_events", { startAt, endAt }),
  getDismissedEvents: () => invoke<DismissedOccurrence[]>("get_dismissed_events"),
  dismissUpcomingEvent: (id, endAt) =>
    invoke<void>("dismiss_upcoming_event", { id, endAt }),
  listCalendars: () => invoke<CalendarInfo[]>("list_calendars"),
  requestCalendarAccess: () => invoke<boolean>("request_calendar_access"),
  getCalendarAccess: () => invoke<boolean>("get_calendar_access"),
  requestRemindersAccess: () => invoke<boolean>("request_reminders_access"),
  getRemindersAccess: () => invoke<boolean>("get_reminders_access"),
  openCalendarPrivacy: () => invoke<void>("open_calendar_privacy"),
  openRemindersPrivacy: () => invoke<void>("open_reminders_privacy"),
  joinMeeting: (url) => invoke<void>("join_meeting", { url }),
  openEvent: (id) => invoke<void>("open_event", { id }),
  checkForUpdates: () => invoke<UpdateOffer>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),
  getUpdateAvailable: () => invoke<string | null>("update_available"),
  onUpdateAvailable: (listener) => subscribe<string | null>("update-available", listener),
  onUpdateFailed: (listener) => subscribe<string>("update-failed", listener),
  openRepository: () => invoke<void>("open_repository"),
  openUrl: (url) => invoke<void>("open_link", { url }),
  onUpdateProgress: (listener) =>
    subscribe<{ downloaded: number; total: number | null }>(
      "update-progress",
      listener,
    ),
  hideCalendar: () => invoke<void>("hide_calendar"),
  showReminder: () => invoke<boolean>("show_reminder"),
  hideReminder: () => invoke<void>("hide_reminder"),
  hideSettings: () => invoke<void>("hide_settings"),
  getSidebarSize: () => invoke<"small" | "medium" | "large">("sidebar_size"),
  setReminderHeight: (height) => invoke<void>("set_reminder_height", { height }),
  setCalendarHeight: (height) => invoke<void>("set_calendar_height", { height }),
  getPopoverMaterial: () => invoke<string>("popover_material"),
  setCalendarPinned: (pinned) => invoke<void>("set_calendar_pinned", { pinned }),
  openSettings: () => invoke<void>("open_settings"),
  getAppVersion: () => invoke<string>("app_version"),
  onSettingsChanged: (listener) => subscribe<AppSettings>("settings-changed", listener),
  onCalendarShown: (listener) => subscribe<void>("calendar-shown", listener),
  onCalendarHidden: (listener) => subscribe<void>("calendar-hidden", listener),
  onClockTick: (listener) => subscribe<void>("clock-tick", listener),
  onEventDismissed: (listener) => subscribe<void>("event-dismissed", listener),
  onJoinUpcomingRequested: (listener) => subscribe<void>("join-upcoming", listener),
};

export function installTauriBridge(): DesktopApi {
  if (!isTauri()) {
    throw new Error("Tauri is unavailable; the window cannot reach its host.");
  }
  return api;
}
