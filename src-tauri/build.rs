/// Every command the webviews may call. Listing them makes Tauri generate an
/// `allow-<command>` permission for each, so the capability files can grant a
/// window only the commands it uses instead of all of them.
const COMMANDS: &[&str] = &[
    "get_settings",
    "update_settings",
    "set_tray_label",
    "set_event_tray_label",
    "beep",
    "hide_calendar",
    "hide_events",
    "hide_settings",
    "set_events_height",
    "set_calendar_height",
    "popover_material",
    "set_calendar_pinned",
    "open_settings",
    "app_version",
    "check_for_updates",
    "update_available",
    "install_update",
    "open_repository",
    "open_link",
    "get_upcoming_event",
    "get_calendar_events",
    "get_dismissed_events",
    "dismiss_upcoming_event",
    "list_calendars",
    "request_calendar_access",
    "get_calendar_access",
    "request_reminders_access",
    "get_reminders_access",
    "open_calendar_privacy",
    "open_reminders_privacy",
    "join_meeting",
    "open_event",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
