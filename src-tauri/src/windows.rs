//! The three windows: building them, showing and fading them, their theme, and
//! closing the popover on an outside click.

use super::*;

pub(crate) fn fade_counter<'a>(state: &'a AppState, label: &str) -> &'a AtomicU64 {
    if label == CALENDAR_LABEL {
        &state.calendar_fade
    } else {
        &state.reminder_fade
    }
}

/// Dissolves the popover the way a menu extra does, then hides it. A reopen
/// during the fade cancels the hide and restores full opacity.
pub(crate) fn fade_out_and_hide(app: &AppHandle, label: &'static str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let generation =
        fade_counter(&app.state::<AppState>(), label).fetch_add(1, Ordering::SeqCst) + 1;
    glass::fade_out(&window);

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(glass::FADE);
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if fade_counter(&app.state::<AppState>(), label).load(Ordering::SeqCst) != generation {
                return;
            }
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.hide();
                glass::clear_fade(&window);
            }
        });
    });
}

/// Cancels a fade in flight and brings the window back to full opacity, so an
/// immediate reopen shows a solid popover rather than a half-faded one.
pub(crate) fn cancel_fade(app: &AppHandle, label: &'static str) {
    fade_counter(&app.state::<AppState>(), label).fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(label) {
        glass::clear_fade(&window);
    }
}

pub(crate) fn close_calendar(app: &AppHandle) {
    hold_native_highlight(app, TRAY_ID, false);
    fade_out_and_hide(app, CALENDAR_LABEL);
    let _ = app.emit("calendar-hidden", ());
    if let Ok(mut closed) = app.state::<AppState>().calendar_closed_at.lock() {
        *closed = Some(Instant::now());
    }
}

/// Hides the card and tells its page, which otherwise keeps holding the
/// meeting it showed and would offer no other until that one's time ran out.
pub(crate) fn close_reminder(app: &AppHandle) {
    fade_out_and_hide(app, REMINDER_LABEL);
    let _ = app.emit_to(REMINDER_LABEL, "reminder-hidden", ());
}

pub(crate) fn window_theme(theme: &str) -> Option<Theme> {
    match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

pub(crate) fn apply_window_theme(window: &WebviewWindow, theme: &str) {
    glass::apply_appearance(window, theme);
    let _ = window.set_theme(window_theme(theme));
}

pub(crate) fn apply_app_theme(app: &AppHandle, theme: &str) {
    for label in [CALENDAR_LABEL, REMINDER_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            apply_window_theme(&window, theme);
        }
    }
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.set_theme(window_theme(theme));
    }
}

pub(crate) fn show_calendar(app: &AppHandle, tray_rect: tauri::Rect) {
    // The month lists the same meeting with its Join, so the card steps aside.
    close_reminder(app);
    cancel_fade(app, CALENDAR_LABEL);
    position_calendar(app, tray_rect);
    if let Some(window) = app.get_webview_window(CALENDAR_LABEL) {
        popover::present(&window);
        // Showing can let AppKit park the window on the previous screen.
        position_calendar(app, tray_rect);
    }
    let _ = app.emit("calendar-shown", ());
}

pub(crate) fn toggle_calendar(app: &AppHandle, tray_rect: tauri::Rect) {
    let visible = app
        .get_webview_window(CALENDAR_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let just_closed = app
        .state::<AppState>()
        .calendar_closed_at
        .lock()
        .map(|closed| closed.is_some_and(|at| at.elapsed() < REOPEN_GUARD))
        .unwrap_or(false);
    // This click is the one that closed it: the blur it caused got here
    // first, and the popover may still be fading out.
    if just_closed {
        return;
    }
    if visible {
        close_calendar(app);
        return;
    }
    show_calendar(app, tray_rect);
}

pub(crate) fn present_settings(app: &AppHandle) {
    close_calendar(app);
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        glass::present(&window);
        glass::place_window_buttons(&window);
    }
}

/// The permission prompts need a regular app to come forward. Once one is
/// answered, Glance goes back to living in the menu bar alone, unless
/// Settings is open, which keeps its Dock icon while it is up.
pub(crate) fn settle_after_access_prompt(app: &AppHandle) {
    let settings_open = app
        .get_webview_window(SETTINGS_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !settings_open {
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
}

pub(crate) fn dismiss_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.hide();
    }
    // A recording cut short by closing Settings must not leave them off.
    set_shortcuts_suspended(app, false);
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

pub(crate) fn build_calendar_window(app: &AppHandle) -> tauri::Result<()> {
    let initial = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|store| store.value())
        .unwrap_or_default();
    let (initial_width, initial_height) = calendar_window_size(app, initial.show_week_numbers);
    let window =
        WebviewWindowBuilder::new(app, CALENDAR_LABEL, WebviewUrl::App("calendar.html".into()))
            .title("Glance")
            .inner_size(initial_width, initial_height)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .visible(false)
            .focused(false)
            .build()?;

    glass::apply_calendar_glass(&window);
    popover::as_nonactivating_panel(&window);

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // The panel holds key while Glance stays inactive, so it resigns key
        // the moment the user turns to anything else — a click into another
        // app's window, or ⌘Tab — and that is this event. Clicks that move
        // no focus are `watch_outside_clicks`'s. Closing on the spot, rather
        // than after a delay, keeps the popover from being left visible but
        // inactive — long enough for the glass to paint its subdued state
        // before the window goes away.
        WindowEvent::Focused(false) => {
            let state = handle.state::<AppState>();
            if state.ignore_calendar_blur.swap(false, Ordering::SeqCst) {
                return;
            }
            close_calendar(&handle);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            close_calendar(&handle);
        }
        _ => {}
    });
    Ok(())
}

/// The reminder card never takes focus when it appears, so whatever the user
/// is typing keeps going; it leaves on Join, Dismiss, or once the meeting
/// is under way, not on the next click elsewhere.
pub(crate) fn build_reminder_window(app: &AppHandle) -> tauri::Result<()> {
    let window =
        WebviewWindowBuilder::new(app, REMINDER_LABEL, WebviewUrl::App("reminder.html".into()))
            .title("Meeting Reminder")
            .inner_size(REMINDER_WIDTH, REMINDER_FLOOR)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .visible(false)
            .focused(false)
            .build()?;
    glass::apply_calendar_glass(&window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            close_reminder(&handle);
        }
    });
    Ok(())
}

pub(crate) fn build_settings_window(app: &AppHandle) -> tauri::Result<()> {
    let window =
        WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App("settings.html".into()))
            .title("Glance Settings")
            .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
            .resizable(false)
            .skip_taskbar(false)
            .visible(false)
            .center()
            // System Settings' chrome: no title bar, the traffic lights inside
            // a floating sidebar, the page drawn edge to edge beneath them.
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .build()?;
    glass::use_unified_toolbar(&window);
    glass::place_window_buttons(&window);

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            dismiss_settings(&handle);
        }
    });
    Ok(())
}

/// Closes an open popover when the mouse goes down anywhere outside Glance,
/// the way a status item's menu does.
///
/// The popover is a nonactivating panel, so the app in front stays in front
/// and a click back into its window only resigns the panel's key status —
/// which closes it — but clicks that move no focus at all are missed: the
/// empty menu bar, another app's status item, the desktop. A global monitor
/// catches those. It sees only events bound for other apps, so clicks on our
/// own status items and popovers never reach it and the tray toggle keeps
/// working. Mouse monitors need no Accessibility grant.
#[cfg(target_os = "macos")]
pub(crate) fn watch_outside_clicks(app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;

    let block = RcBlock::new(move |_: NonNull<NSEvent>| {
        let visible = |label| {
            app.get_webview_window(label)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false)
        };
        if visible(CALENDAR_LABEL) {
            close_calendar(&app);
        }
    });
    let mask =
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;
    let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &block);
    // The watch lasts as long as the app; nothing ever removes it.
    std::mem::forget(monitor);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn watch_outside_clicks(_app: AppHandle) {}
