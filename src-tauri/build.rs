/// Every command the webviews may call. Listing them makes Tauri generate an
/// `allow-<command>` permission for each, so the capability files can grant a
/// window only the commands it uses instead of all of them.
const COMMANDS: &[&str] = &[
    "get_settings",
    "update_settings",
    "set_tray_label",
    "beep",
    "hide_calendar",
    "hide_reminder",
    "show_reminder",
    "hide_settings",
    "sidebar_size",
    "set_reminder_height",
    "set_calendar_height",
    "popover_material",
    "open_settings",
    "suspend_shortcuts",
    "app_version",
    "check_for_updates",
    "update_available",
    "update_status",
    "system_region",
    "install_update",
    "open_repository",
    "open_link",
    "get_calendar_events",
    "get_dismissed_events",
    "dismiss_upcoming_event",
    "list_calendars",
    "request_calendar_access",
    "get_calendar_access",
    "request_reminders_access",
    "get_reminders_access",
    "join_meeting",
    "set_join_menu",
    "complete_reminder",
    "undo_completed_reminder",
    "open_in_maps",
    "detect_dates",
    "create_event",
    "undo_created_event",
    "open_google_event",
    "open_event",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
