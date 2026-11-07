//! Menu bar host for Glance.
//!
//! There is no main window. The process is an accessory: a status item whose
//! left click opens a month popover, and a settings window opened on demand.

mod beep;
mod clock;
mod events;
mod glass;
mod placement;
mod popover;
mod quick_add;
mod region;
mod settings;
mod shortcuts;
mod tray;
mod updates;
mod windows;

use clock::*;
use placement::*;
use serde::Serialize;
use settings::{AppSettings, SettingsStore};
use shortcuts::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ActivationPolicy, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
    PhysicalSize, Position, Size, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tray::*;
use windows::*;

const CALENDAR_LABEL: &str = "calendar";
/// The meeting reminder: a small card under the status item, shown about a
/// minute before a meeting with a join link starts.
const REMINDER_LABEL: &str = "reminder";
const REMINDER_WIDTH: f64 = 280.0;
/// Only a floor against a degenerate window: the card takes the height its
/// content asks for.
const REMINDER_FLOOR: f64 = 40.0;
/// The card holds one meeting, so it never needs more than this.
const REMINDER_CEILING: f64 = 240.0;
const SETTINGS_LABEL: &str = "settings";
const TRAY_ID: &str = "glance";
const AUTOSTART_ARG: &str = "--autostart";
const CALENDAR_WIDTH: f64 = 264.0;
const CALENDAR_WIDTH_WEEKS: f64 = 288.0;
/// The first size, before the page has measured itself, and the floor after.
const CALENDAR_HEIGHT: f64 = 240.0;
/// Wide enough that a row's explanation sits on one line beside its control,
/// which is what keeps the grouped lists readable.
const SETTINGS_WIDTH: f64 = 780.0;
const SETTINGS_HEIGHT: f64 = 640.0;

struct AppState {
    settings: Mutex<SettingsStore>,
    ignore_calendar_blur: AtomicBool,
    /// When blur last closed the calendar. A click on the tray icon arrives
    /// just after the blur it caused, and without this the toggle would read
    /// the popover as closed and open it straight back up.
    calendar_closed_at: Mutex<Option<Instant>>,
    /// Counts each fade, so the hide that follows one belongs to it. Reopening
    /// mid-fade bumps the count and the pending hide stands down.
    calendar_fade: AtomicU64,
    reminder_fade: AtomicU64,
    dismissed_events: Mutex<Vec<events::DismissedOccurrence>>,
    /// Events quick add made this run: only these can be undone.
    created_events: Mutex<Vec<String>>,
    /// Where dismissals are kept between runs.
    dismissed_path: PathBuf,
    /// The chords currently registered with the system, so a failed rebind
    /// can leave the working one in place. Held only to read or write the
    /// pair, never while the system is being asked to bind one.
    shortcuts: Mutex<RegisteredShortcuts>,
    /// One rebinding at a time, so two quick edits cannot interleave.
    shortcut_rebind: Mutex<()>,
    /// Whether Settings has the chords set aside while it records one.
    shortcuts_suspended: AtomicBool,
    /// The calendar status item's glyph before any update dot, so the dot can
    /// come and go without the renderer repainting. None is text only.
    tray_glyph: Mutex<Option<Vec<u8>>>,
    /// The calendar popover's height as its page last measured it, since the
    /// selected day's events make it taller or shorter.
    calendar_height: Mutex<f64>,
}

fn user_data_dir(app: &AppHandle) -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join("Library/Application Support/Glance");
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn merge_settings(current: &AppSettings, patch: &serde_json::Value) -> Result<AppSettings, String> {
    let mut merged =
        serde_json::to_value(current).map_err(|error| format!("Invalid settings: {error}"))?;
    if let (Some(base), Some(fields)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in fields {
            base.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(merged).map_err(|error| format!("Invalid settings patch: {error}"))
}

fn set_launch_at_login(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
}

// SAFETY: AppKit menus are main-thread only, and this value is only cloned
// or read from setup and tray click handlers, which both run there.

/// Settings records a chord by hearing its keys, but a chord Glance has bound
/// never reaches it: macOS hands it to the hotkey first, so pressing ⌃⌘K to
/// record would open the month instead. Recording sets the bindings aside,
/// and they come back when it ends.
#[tauri::command]
fn suspend_shortcuts(app: AppHandle, suspended: bool) {
    set_shortcuts_suspended(&app, suspended);
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<AppSettings, String> {
    state
        .settings
        .lock()
        .map(|store| store.value())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let mut store = state.settings.lock().map_err(|error| error.to_string())?;
    let previous = store.value();
    let next = merge_settings(&previous, &patch)?;
    // In force for this run whether or not the file took it; the error is
    // reported after the change is applied, so nothing shows stale.
    let (saved, write_error) = match store.update(next) {
        Ok(saved) => (saved, None),
        Err(error) => (store.value(), Some(error)),
    };
    drop(store);
    if saved.launch_at_login != previous.launch_at_login {
        set_launch_at_login(&app, saved.launch_at_login);
    }
    // Resized at once, hidden or not, so the month is redrawn at the width it
    // will open at rather than at the old one.
    if saved.show_week_numbers != previous.show_week_numbers {
        if let Some(window) = app.get_webview_window(CALENDAR_LABEL) {
            let (width, height) = calendar_window_size(&app, saved.show_week_numbers);
            let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
        }
    }
    if saved.theme != previous.theme {
        apply_app_theme(&app, &saved.theme);
    }
    if saved.toggle_calendar_shortcut != previous.toggle_calendar_shortcut
        || saved.join_meeting_shortcut != previous.join_meeting_shortcut
    {
        apply_shortcuts(&app, &saved, Some(&previous));
    }
    if saved.auto_update && !previous.auto_update && !cfg!(debug_assertions) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = updates::install(&handle).await;
        });
    }
    let _ = app.emit("settings-changed", &saved);
    match write_error {
        Some(error) => {
            eprintln!("Could not save settings: {error}");
            Err(format!("Settings could not be saved: {error}"))
        }
        None => Ok(saved),
    }
}

/// Paints exactly one menu bar style: plain text or a glyph.
///
/// `title` is None for icon-only. `icon_day` is None when the style has no
/// date. `image` carries the framed glyph, which the renderer draws because it
/// holds text that the baked PNGs cannot.
#[tauri::command]
fn set_tray_label(
    app: AppHandle,
    title: Option<String>,
    icon_day: Option<u8>,
    style: String,
    image: Option<Vec<u8>>,
    description: Option<String>,
) {
    let _ = app.clone().run_on_main_thread(move || {
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        // On macOS, set_title(None) leaves the previous native title intact.
        // Always write an explicit value so event status text clears reliably.
        let text = tray_title_text(title.as_deref());
        let _ = tray.set_title(Some(text.as_str()));
        let bytes: Option<&[u8]> = match style.as_str() {
            "none" => None,
            "framed" => image
                .as_deref()
                .filter(|png| png.len() <= TRAY_IMAGE_MAX_BYTES),
            "calendar" => Some(TRAY_CALENDAR),
            _ => icon_day
                .filter(|day| (1..=31).contains(day))
                .and_then(|day| TRAY_FILLED.get(usize::from(day) - 1).copied()),
        };
        if let Ok(mut glyph) = app.state::<AppState>().tray_glyph.lock() {
            *glyph = bytes.map(<[u8]>::to_vec);
        }
        paint_tray_glyph(&tray, bytes);
        // The item shows a short date and countdown; VoiceOver and the
        // tooltip get them in full.
        let spoken = capped_line(description.as_deref(), TRAY_DESCRIPTION_MAX_CHARS);
        let _ = tray.set_tooltip((!spoken.is_empty()).then_some(spoken.as_str()));
        #[cfg(target_os = "macos")]
        describe_status_item(&tray, &spoken);
        follow_status_item(&app);
    });
}

/// Plays the bundled hourly chime for both the clock and Settings preview.
#[tauri::command]
fn beep(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = app
            .path()
            .resolve("resources/beep.mp3", tauri::path::BaseDirectory::Resource)
            .map_err(|error| error.to_string())?;
        beep::play_native(&path, beep::beep_playback_volume())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_calendar(app: AppHandle) {
    close_calendar(&app);
}

#[tauri::command]
fn hide_reminder(app: AppHandle) {
    close_reminder(&app);
}

/// Puts the reminder card under the status item without activating the app.
/// It stays away while the month is open, which already shows the meeting;
/// false tells the page it was not shown.
#[tauri::command]
fn show_reminder(app: AppHandle) -> bool {
    let calendar_open = app
        .get_webview_window(CALENDAR_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if calendar_open {
        return false;
    }
    let Some(anchor) = tray_anchor(&app) else {
        return false;
    };
    cancel_fade(&app, REMINDER_LABEL);
    position_reminder(&app, anchor);
    let Some(window) = app.get_webview_window(REMINDER_LABEL) else {
        return false;
    };
    glass::present_inactive(&window);
    follow_status_item(&app);
    true
}

/// The user's sidebar icon size from System Settings › Appearance: "small",
/// "medium" or "large". Native sidebars size their rows, icons and text from
/// it, so the Settings sidebar does too.
#[tauri::command]
fn sidebar_size() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        let defaults = objc2_foundation::NSUserDefaults::standardUserDefaults();
        let key = objc2_foundation::NSString::from_str("NSTableViewDefaultSizeMode");
        match defaults.integerForKey(&key) {
            1 => "small",
            3 => "large",
            _ => "medium",
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "medium"
    }
}

/// The welcome's Get Started: closes Settings the way its close button does.
#[tauri::command]
fn hide_settings(app: AppHandle) {
    dismiss_settings(&app);
}

#[tauri::command]
fn set_reminder_height(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(REMINDER_LABEL) else {
        return;
    };
    let _ = window.set_size(Size::Logical(LogicalSize::new(
        REMINDER_WIDTH,
        reminder_height(height),
    )));
    // Growing keeps the top edge, so the card stays under the menu bar.
    if window.is_visible().unwrap_or(false) {
        if let Some(anchor) = tray_anchor(&app) {
            position_reminder(&app, anchor);
        }
    }
}

/// The page measures itself after drawing the selected day, and the window
/// follows. It grows downward from the menu bar, so the top edge stays put.
#[tauri::command]
fn set_calendar_height(app: AppHandle, height: f64) {
    let height = calendar_height(height);
    let state = app.state::<AppState>();
    if let Ok(mut recorded) = state.calendar_height.lock() {
        if (*recorded - height).abs() < 0.5 {
            return;
        }
        *recorded = height;
    }
    let weeks = state
        .settings
        .lock()
        .map(|store| store.value().show_week_numbers)
        .unwrap_or(false);
    if let Some(window) = app.get_webview_window(CALENDAR_LABEL) {
        let _ = window.set_size(Size::Logical(LogicalSize::new(
            calendar_width(weeks),
            height,
        )));
    }
}

/// "glass" once the popovers are drawn on Liquid Glass, "vibrancy" when the
/// system is too old for it and the Menu material stands in.
#[tauri::command]
fn popover_material() -> &'static str {
    if glass::is_liquid_glass() {
        "glass"
    } else {
        "vibrancy"
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    present_settings(&app);
}

fn on_main<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(work());
    })
    .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())
}

async fn on_main_async<T, F>(app: AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || on_main(&app, work))
        .await
        .map_err(|error| error.to_string())?
}

fn hidden_calendar_ids(app: &AppHandle) -> Vec<String> {
    app.state::<AppState>()
        .settings
        .lock()
        .map(|store| store.value().hidden_calendar_ids)
        .unwrap_or_default()
}

fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn get_dismissed_events(
    state: State<AppState>,
) -> Result<Vec<events::DismissedOccurrence>, String> {
    let now = unix_now_ms();
    let mut list = state
        .dismissed_events
        .lock()
        .map_err(|error| error.to_string())?;
    events::prune_dismissed(&mut list, now);
    Ok(list.clone())
}

#[tauri::command]
fn dismiss_upcoming_event(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    end_at: i64,
) -> Result<(), String> {
    let now = unix_now_ms();
    let mut list = state
        .dismissed_events
        .lock()
        .map_err(|error| error.to_string())?;
    events::dismiss_occurrence(&mut list, id, end_at, now);
    let saved = events::save_dismissed(&state.dismissed_path, &list);
    drop(list);
    // Skipped for this run either way; the file only carries it across a
    // restart.
    let _ = app.emit("event-dismissed", ());
    saved.map_err(|error| {
        eprintln!("Could not save the skipped meeting: {error}");
        format!("The skipped meeting could not be saved: {error}")
    })
}

#[tauri::command]
async fn get_calendar_events(
    app: AppHandle,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<events::UpcomingEvent>, String> {
    let hidden = hidden_calendar_ids(&app);
    let pending =
        on_main_async(app, move || events::start_range(start_at, end_at, &hidden)).await??;
    tauri::async_runtime::spawn_blocking(move || pending.finish())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_calendars(app: AppHandle) -> Result<Vec<events::CalendarInfo>, String> {
    on_main_async(app, events::list_calendars).await?
}

#[tauri::command]
async fn request_calendar_access(app: AppHandle) -> Result<bool, String> {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let waiting = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        waiting
            .run_on_main_thread(move || {
                events::begin_access_request(move |result| {
                    let _ = sender.send(result);
                });
            })
            .map_err(|error| error.to_string())?;
        let granted = receiver
            .recv_timeout(Duration::from_secs(180))
            .map_err(|_| "Calendar access request timed out. Try again.".to_string())??;
        on_main(&waiting, move || events::finish_access_request(granted))?;
        if events::should_open_privacy_after_prompt(&Ok(granted)) {
            let _ = on_main(&waiting, events::open_calendar_privacy);
        } else if granted {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            waiting
                .run_on_main_thread(move || {
                    events::begin_reminders_access_request(move |result| {
                        let _ = sender.send(result);
                    });
                })
                .ok();
            if let Ok(Ok(reminder_granted)) = receiver.recv_timeout(Duration::from_secs(180)) {
                let _ = on_main(&waiting, move || {
                    events::finish_reminders_access_request(reminder_granted)
                });
            }
        }
        Ok(granted)
    })
    .await
    .map_err(|error| error.to_string());
    settle_after_access_prompt(&app);
    result?
}

#[tauri::command]
async fn get_calendar_access(app: AppHandle) -> Result<bool, String> {
    on_main_async(app, events::has_access).await
}

#[tauri::command]
async fn request_reminders_access(app: AppHandle) -> Result<bool, String> {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let waiting = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        waiting
            .run_on_main_thread(move || {
                events::begin_reminders_access_request(move |result| {
                    let _ = sender.send(result);
                });
            })
            .map_err(|error| error.to_string())?;
        let granted = receiver
            .recv_timeout(Duration::from_secs(180))
            .map_err(|_| "Reminders access request timed out. Try again.".to_string())??;
        on_main(&waiting, move || {
            events::finish_reminders_access_request(granted)
        })?;
        if events::should_open_privacy_after_prompt(&Ok(granted)) {
            let _ = on_main(&waiting, events::open_reminders_privacy);
        }
        Ok(granted)
    })
    .await
    .map_err(|error| error.to_string());
    settle_after_access_prompt(&app);
    result?
}

#[tauri::command]
async fn get_reminders_access(app: AppHandle) -> Result<bool, String> {
    on_main_async(app, events::has_reminders_access).await
}

#[tauri::command]
fn join_meeting(url: String) -> Result<(), String> {
    events::open_meeting(&url)
}

/// The dates macOS reads in quick add's text.
#[tauri::command]
fn detect_dates(text: String) -> Vec<quick_add::DetectedDate> {
    quick_add::detect_dates(&text)
}

/// Adds a quick add event to the chosen calendar and remembers it for Undo.
#[tauri::command]
async fn create_event(app: AppHandle, event: events::NewEvent) -> Result<String, String> {
    let event = event.checked()?;
    let calendar_id = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|store| store.value().quick_add_calendar_id.clone())
        .unwrap_or_default();
    let worker = app.clone();
    let id = on_main_async(worker, move || events::create_event(&event, &calendar_id)).await??;
    if let Ok(mut created) = app.state::<AppState>().created_events.lock() {
        created.push(id.clone());
        let extra = created.len().saturating_sub(20);
        created.drain(..extra);
    }
    Ok(id)
}

/// Undo for quick add: removes an event it made this run, and nothing else.
#[tauri::command]
async fn undo_created_event(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut created = state
            .created_events
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(at) = created.iter().position(|item| *item == id) else {
            return Err("Only an event just added can be undone".into());
        };
        created.remove(at);
    }
    on_main_async(app, move || events::remove_event(&id)).await?
}

/// Hands a meeting with guests to Google Calendar's new-event page.
#[tauri::command]
fn open_google_event(draft: quick_add::GoogleDraft) -> Result<(), String> {
    events::open_https(&quick_add::google_event_url(&draft)?)
}

/// Shows a meeting's place in Maps.
#[tauri::command]
fn open_in_maps(place: String) -> Result<(), String> {
    events::open_https(&events::maps_url(&place)?)
}

#[tauri::command]
fn open_event(id: String) -> Result<(), String> {
    events::open_event(&id)
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// What a check found. `version` is empty when the running build is current.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateOffer {
    version: String,
    notes: String,
}

/// Asks now, whatever the setting says: pressing the button is the asking.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateOffer, String> {
    let found = updates::check(&app).await?;
    Ok(UpdateOffer {
        version: found
            .as_ref()
            .map(|update| update.version.clone())
            .unwrap_or_default(),
        notes: found.and_then(|update| update.body).unwrap_or_default(),
    })
}

/// The Mac's locale, clock and first weekday, for formatting dates and times
/// as Language & Region sets them.
#[tauri::command]
fn system_region() -> region::SystemRegion {
    region::current()
}

/// What the last check said, for a Settings window that opened after it.
#[tauri::command]
fn update_status() -> updates::UpdateStatus {
    updates::status()
}

/// The version a background check found and nobody has installed yet, for a
/// Settings window that opened after the event saying so.
#[tauri::command]
fn update_available() -> Option<String> {
    updates::available()
}

/// Shown on the About pane, and the way out when an update cannot be applied
/// and the only route left is a hand-installed disk image.
const REPOSITORY_URL: &str = "https://github.com/zshanansari/glance";

#[tauri::command]
fn open_repository() -> Result<(), String> {
    events::open_https(REPOSITORY_URL)
}

/// The only addresses About may open. Anything else is refused, so a script
/// in the webview cannot use this to open a page of its choosing.
const ABOUT_LINKS: &[&str] = &[
    REPOSITORY_URL,
    "https://github.com/zshanansari/glance/releases",
    "https://github.com/zshanansari/glance/issues",
    "https://github.com/vipinsight/calendo",
    "https://github.com/zshanansari",
];

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !ABOUT_LINKS.contains(&url.as_str()) {
        return Err("Link is not one Glance opens".into());
    }
    events::open_https(&url)
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    if updates::install(&app).await? {
        Ok(())
    } else {
        Err("Glance is already up to date".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let action = app
                        .state::<AppState>()
                        .shortcuts
                        .lock()
                        .ok()
                        .and_then(|registered| registered.action_for(shortcut));
                    if let Some(action) = action {
                        run_shortcut(app, action);
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let user_data = user_data_dir(app.handle());
            std::fs::create_dir_all(&user_data).ok();
            let dismissed_path = user_data.join("dismissed.json");
            let dismissed = events::load_dismissed(&dismissed_path, unix_now_ms());
            let mut store = SettingsStore::load(user_data);
            let system = region::current();
            store.adopt_region_if_new(
                system.first_weekday,
                region::numbers_weeks_like_the_us(system.region.as_deref()),
            );
            let initial = store.value();
            app.manage(AppState {
                settings: Mutex::new(store),
                ignore_calendar_blur: AtomicBool::new(false),
                calendar_closed_at: Mutex::new(None),
                calendar_fade: AtomicU64::new(0),
                reminder_fade: AtomicU64::new(0),
                dismissed_events: Mutex::new(dismissed),
                created_events: Mutex::new(Vec::new()),
                dismissed_path,
                shortcuts: Mutex::new(RegisteredShortcuts::default()),
                shortcut_rebind: Mutex::new(()),
                shortcuts_suspended: AtomicBool::new(false),
                tray_glyph: Mutex::new(Some(TRAY_ICON.to_vec())),
                calendar_height: Mutex::new(CALENDAR_HEIGHT),
            });
            set_launch_at_login(app.handle(), initial.launch_at_login);
            build_calendar_window(app.handle())?;
            build_reminder_window(app.handle())?;
            build_settings_window(app.handle())?;
            apply_app_theme(app.handle(), &initial.theme);
            build_tray(app.handle())?;
            apply_shortcuts(app.handle(), &initial, None);
            spawn_clock(app.handle().clone());
            // First launch: Settings opens on the welcome, once the app is
            // running, since a window shown during setup stays behind
            // whatever was in front.
            if !initial.onboarded {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(400));
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || present_settings(&app));
                });
            }
            watch_outside_clicks(app.handle().clone());
            keep_highlight_while_open(app.handle().clone());
            updates::spawn_checks(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            set_tray_label,
            beep,
            hide_calendar,
            hide_reminder,
            show_reminder,
            hide_settings,
            sidebar_size,
            set_reminder_height,
            set_calendar_height,
            popover_material,
            open_settings,
            app_version,
            check_for_updates,
            update_available,
            install_update,
            open_repository,
            open_link,
            get_calendar_events,
            get_dismissed_events,
            suspend_shortcuts,
            update_status,
            system_region,
            dismiss_upcoming_event,
            list_calendars,
            request_calendar_access,
            get_calendar_access,
            request_reminders_access,
            get_reminders_access,
            join_meeting,
            open_in_maps,
            detect_dates,
            create_event,
            undo_created_event,
            open_google_event,
            open_event,
        ])
        .run(tauri::generate_context!())
        .expect("Glance failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_waits_until_just_past_the_next_minute() {
        let slack = Duration::from_millis(50);
        // 12:00:00.000 exactly: a whole minute, not zero, so it never spins.
        assert_eq!(
            until_next_minute(Duration::from_secs(1_800_000_000)),
            Duration::from_secs(60) + slack
        );
        // 12:00:59.990: lands on 12:01, not a tick that repaints 12:00.
        assert_eq!(
            until_next_minute(Duration::from_millis(1_800_000_059_990)),
            Duration::from_millis(10) + slack
        );
        // 12:00:17.250
        assert_eq!(
            until_next_minute(Duration::from_millis(1_800_000_017_250)),
            Duration::from_millis(42_750) + slack
        );
    }

    /// A window missing from the capability cannot listen for events, and
    /// nothing fails loudly: its own commands keep working while every
    /// `listen` is refused, so the popover simply stops refreshing.
    #[test]
    fn a_click_on_the_other_display_moves_the_anchor_under_the_pointer() {
        let laptop = ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 3024.0,
            height: 1964.0,
        };
        let external = ScreenBounds {
            x: 1000.0,
            y: -2880.0,
            width: 5120.0,
            height: 2880.0,
        };
        let screens = [laptop, external];
        // Reported on the external display, clicked on the laptop.
        let reported = ScreenBounds {
            x: 3000.0,
            y: -2880.0,
            width: 72.0,
            height: 48.0,
        };
        let anchored = anchor_on_clicked_screen(reported, (2012.0, 30.0), &screens);
        assert_eq!(
            anchored,
            ScreenBounds {
                x: 1976.0,
                y: 0.0,
                width: 72.0,
                height: 48.0
            }
        );
        // Clicked where it was reported: left alone.
        assert_eq!(
            anchor_on_clicked_screen(reported, (3030.0, -2860.0), &screens),
            reported
        );
    }

    fn capability(json: &str) -> serde_json::Value {
        serde_json::from_str(json).expect("capability is valid JSON")
    }

    fn grants(capability: &serde_json::Value, permission: &str) -> bool {
        capability["permissions"]
            .as_array()
            .expect("capability lists permissions")
            .iter()
            .any(|granted| granted == permission)
    }

    #[test]
    fn a_settings_patch_changes_only_what_it_names() {
        let current = AppSettings::default();
        let merged =
            super::merge_settings(&current, &serde_json::json!({ "showWeekNumbers": true }))
                .expect("a valid patch merges");
        assert!(merged.show_week_numbers);
        assert_eq!(merged.theme, current.theme);
        assert_eq!(merged.highlight_weekdays, current.highlight_weekdays);
    }

    #[test]
    fn a_patch_of_the_wrong_type_is_refused_whole() {
        let current = AppSettings::default();
        assert!(
            super::merge_settings(&current, &serde_json::json!({ "showWeekNumbers": "yes" }))
                .is_err()
        );
        // An unknown key changes nothing, rather than failing the save.
        let merged = super::merge_settings(&current, &serde_json::json!({ "nonsense": 1 }))
            .expect("unknown keys are ignored");
        assert_eq!(
            serde_json::to_value(&merged).unwrap(),
            serde_json::to_value(&current).unwrap()
        );
    }

    #[test]
    fn a_refused_shortcut_goes_back_to_the_bound_one() {
        let previous = AppSettings::default();
        let mut next = previous.clone();
        next.toggle_calendar_shortcut = "Control+Alt+KeyK".into();
        next.join_meeting_shortcut = "Control+Alt+KeyJ".into();
        let (fixed, failures) = super::put_back_refused_shortcuts(
            next,
            &previous,
            ("Control+Alt+KeyK", false),
            ("Control+Alt+KeyJ", true),
        );
        assert_eq!(
            fixed.toggle_calendar_shortcut,
            previous.toggle_calendar_shortcut
        );
        assert_eq!(fixed.join_meeting_shortcut, "Control+Alt+KeyJ");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].setting, "toggleCalendarShortcut");
    }

    #[test]
    fn a_shortcut_changed_again_is_not_put_back() {
        let previous = AppSettings::default();
        let mut next = previous.clone();
        next.toggle_calendar_shortcut = "Control+Alt+KeyL".into();
        let (fixed, failures) = super::put_back_refused_shortcuts(
            next,
            &previous,
            ("Control+Alt+KeyK", false),
            ("", true),
        );
        assert_eq!(fixed.toggle_calendar_shortcut, "Control+Alt+KeyL");
        assert!(failures.is_empty());
    }

    #[test]
    fn the_menu_bar_title_is_capped_and_kept_on_one_line() {
        assert_eq!(super::tray_title_text(None), "");
        assert_eq!(
            super::tray_title_text(Some("Fri 6 \u{2022} in 5m")),
            "Fri 6 \u{2022} in 5m"
        );
        assert_eq!(super::tray_title_text(Some("a\nb")), "ab");
        let long = "x".repeat(500);
        assert_eq!(
            super::tray_title_text(Some(&long)).chars().count(),
            super::TRAY_TITLE_MAX_CHARS
        );
    }

    #[test]
    fn each_window_has_a_capability_of_its_own() {
        for (label, json) in [
            (
                CALENDAR_LABEL,
                include_str!("../capabilities/calendar.json"),
            ),
            (
                REMINDER_LABEL,
                include_str!("../capabilities/reminder.json"),
            ),
            (
                SETTINGS_LABEL,
                include_str!("../capabilities/settings.json"),
            ),
        ] {
            let capability = capability(json);
            assert_eq!(capability["windows"], serde_json::json!([label]));
            assert!(
                grants(&capability, "core:event:allow-listen"),
                "{label} cannot listen"
            );
            assert!(
                grants(&capability, "core:event:allow-unlisten"),
                "{label} cannot unlisten"
            );
            // Windows only hear from the host; none may send events of its own.
            assert!(
                !grants(&capability, "core:event:default"),
                "{label} may emit"
            );
        }
    }

    #[test]
    fn only_settings_can_change_settings_or_install_updates() {
        let settings = capability(include_str!("../capabilities/settings.json"));
        for popover in [
            include_str!("../capabilities/calendar.json"),
            include_str!("../capabilities/reminder.json"),
        ] {
            let popover = capability(popover);
            for command in [
                "allow-update-settings",
                "allow-install-update",
                "allow-open-link",
            ] {
                assert!(grants(&settings, command));
                assert!(!grants(&popover, command), "a popover is granted {command}");
            }
        }
    }

    fn alpha_at(rgba: &[u8], width: u32, x: u32, y: u32) -> u8 {
        rgba[((y * width + x) * 4 + 3) as usize]
    }

    #[test]
    fn update_dot_sits_in_the_top_right_cut_out_of_the_glyph() {
        // A fully inked 36px badge, like the filled day glyphs.
        let (width, height) = (40, 36);
        let badge = vec![255; (width * height * 4) as usize];
        let dotted = with_update_dot(&badge, width, height);
        // The dot's centre is inked, and in black.
        let (cx, cy) = (width - 5, 5);
        assert_eq!(alpha_at(&dotted, width, cx, cy), 255);
        assert_eq!(dotted[((cy * width + cx) * 4) as usize], 0);
        // The ring around it is cleared so the dot reads against the fill.
        assert_eq!(alpha_at(&dotted, width, cx - 6, cy), 0);
        // The rest of the glyph is untouched.
        assert_eq!(alpha_at(&dotted, width, 4, height - 4), 255);
        assert_eq!(dotted.len(), badge.len());
    }

    #[test]
    fn update_dot_inks_an_empty_glyph_only_where_the_dot_is() {
        let (width, height) = (12, 36);
        let blank = vec![0; (width * height * 4) as usize];
        let dotted = with_update_dot(&blank, width, height);
        assert_eq!(alpha_at(&dotted, width, width - 5, 5), 255);
        assert_eq!(alpha_at(&dotted, width, width - 5, height - 5), 0);
    }

    #[test]
    fn reminder_card_takes_its_content_height_between_floor_and_ceiling() {
        assert_eq!(reminder_height(120.0), 120.0);
        assert_eq!(reminder_height(3000.0), REMINDER_CEILING);
        assert_eq!(reminder_height(f64::NAN), REMINDER_FLOOR);
        assert_eq!(reminder_height(0.0), REMINDER_FLOOR);
        assert_eq!(reminder_height(10.0), REMINDER_FLOOR);
    }

    // Retina laptop below a 1× external, matching a typical arrangement:
    // laptop (0, 0) 1512×982 @2x, external (−197, −1080) 1920×1080 @1x.
    const LAPTOP: ScreenBounds = ScreenBounds {
        x: 0.0,
        y: 0.0,
        width: 3024.0,
        height: 1964.0,
    };
    const EXTERNAL: ScreenBounds = ScreenBounds {
        x: -197.0,
        y: -1080.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn picks_the_display_the_tray_is_on() {
        let screens = [LAPTOP, EXTERNAL];
        assert_eq!(screen_containing(&screens, 1512.0, 100.0), Some(LAPTOP));
        assert_eq!(screen_containing(&screens, 500.0, -1070.0), Some(EXTERNAL));
    }

    #[test]
    fn sits_under_the_tray_on_a_1x_display_above_the_laptop() {
        let (x, y, placement) = popover_origin(500.0, -1080.0, 40.0, 24.0, 340.0, 326.0, EXTERNAL);
        assert_eq!(x, 497.0);
        assert_eq!(y, -1055.0);
        assert_eq!(placement, PopoverPlacement::Below);
        assert!(point_in_screen(x, y, EXTERNAL));
        assert!(!point_in_screen(x, y, LAPTOP));
    }

    #[test]
    fn lines_up_with_a_native_menu_on_the_same_item() {
        let (x, y, _) = popover_origin(1010.0, 0.0, 31.0, 33.0, 264.0, 541.0, LAPTOP);
        assert_eq!((x, y), (1007.0, 34.0));
    }

    #[test]
    fn sits_under_the_tray_on_the_built_in_display() {
        let (x, y, placement) = popover_origin(
            1200.0,
            0.0,
            40.0,
            24.0,
            340.0,
            326.0,
            ScreenBounds {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
        );
        // Left-aligned would run past the edge, so it stops 8pt short of it.
        assert_eq!(x, 1164.0);
        assert_eq!(y, 25.0);
        assert_eq!(placement, PopoverPlacement::Below);
    }

    #[test]
    fn stays_on_the_tray_screen_when_the_icon_is_near_the_edge() {
        let (x, y, placement) = popover_origin(-195.0, -1080.0, 40.0, 24.0, 340.0, 326.0, EXTERNAL);
        assert_eq!(x, EXTERNAL.x + 8.0);
        assert_eq!(y, -1055.0);
        assert_eq!(placement, PopoverPlacement::Below);
        assert!(point_in_screen(x, y, EXTERNAL));
    }

    #[test]
    fn left_click_opens_the_popover_not_the_menu() {
        assert_eq!(
            tray_click_intent(MouseButton::Left, MouseButtonState::Down),
            TrayClickIntent::Toggle
        );
        assert_eq!(
            tray_click_intent(MouseButton::Left, MouseButtonState::Up),
            TrayClickIntent::Ignore
        );
    }

    #[test]
    fn right_click_opens_the_menu() {
        assert_eq!(
            tray_click_intent(MouseButton::Right, MouseButtonState::Down),
            TrayClickIntent::Menu
        );
        assert_eq!(
            tray_click_intent(MouseButton::Right, MouseButtonState::Up),
            TrayClickIntent::Ignore
        );
    }
}
