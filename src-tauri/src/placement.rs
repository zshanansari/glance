//! Where the popover and the reminder card go: the status item's frame, the
//! screen it is on, and the window's size and origin under it.

use super::*;

/// How long after a blur-driven close a tray click still counts as the click
/// that closed it.
pub(crate) const REOPEN_GUARD: Duration = Duration::from_millis(300);

pub(crate) fn calendar_width(show_week_numbers: bool) -> f64 {
    if show_week_numbers {
        CALENDAR_WIDTH_WEEKS
    } else {
        CALENDAR_WIDTH
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScreenBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

pub(crate) fn point_in_screen(x: f64, y: f64, screen: ScreenBounds) -> bool {
    x >= screen.x && y >= screen.y && x < screen.x + screen.width && y < screen.y + screen.height
}

/// The status item as it sits on the display that was clicked.
///
/// macOS draws the status item in every display's menu bar, but reports the
/// frame of the one on the display that last had focus. Click the icon on the
/// laptop after working on the external display and the rect points at the
/// external one, so the popover opens where nobody is looking and the next
/// click closes it. The pointer is on the icon that was clicked, so when the
/// two disagree, keep the item's size and move it under the pointer.
pub(crate) fn anchor_on_clicked_screen(
    item: ScreenBounds,
    pointer: (f64, f64),
    screens: &[ScreenBounds],
) -> ScreenBounds {
    let (px, py) = pointer;
    let Some(clicked) = screens
        .iter()
        .copied()
        .find(|screen| point_in_screen(px, py, *screen))
    else {
        return item;
    };
    let center = (item.x + item.width / 2.0, item.y + item.height / 2.0);
    if point_in_screen(center.0, center.1, clicked) {
        return item;
    }
    ScreenBounds {
        x: px - item.width / 2.0,
        y: clicked.y,
        width: item.width,
        height: item.height,
    }
}

pub(crate) fn clicked_rect(app: &AppHandle, rect: tauri::Rect) -> tauri::Rect {
    let Ok(pointer) = app.cursor_position() else {
        return rect;
    };
    let Some(window) = app.get_webview_window(CALENDAR_LABEL) else {
        return rect;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let position: PhysicalPosition<f64> = rect.position.to_physical(scale);
    let size: PhysicalSize<f64> = rect.size.to_physical(scale);
    let screens: Vec<ScreenBounds> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| ScreenBounds {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            width: monitor.size().width as f64,
            height: monitor.size().height as f64,
        })
        .collect();
    let anchored = anchor_on_clicked_screen(
        ScreenBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        (pointer.x, pointer.y),
        &screens,
    );
    tauri::Rect {
        position: tauri::Position::Physical(PhysicalPosition::new(
            anchored.x.round() as i32,
            anchored.y.round() as i32,
        )),
        size: tauri::Size::Physical(PhysicalSize::new(
            anchored.width.round() as u32,
            anchored.height.round() as u32,
        )),
    }
}

#[cfg(test)]
pub(crate) fn screen_containing(screens: &[ScreenBounds], x: f64, y: f64) -> Option<ScreenBounds> {
    screens
        .iter()
        .copied()
        .find(|screen| point_in_screen(x, y, *screen))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PopoverPlacement {
    Below,
    Above,
}

pub(crate) fn calendar_window_size(app: &AppHandle, show_week_numbers: bool) -> (f64, f64) {
    let height = app
        .state::<AppState>()
        .calendar_height
        .lock()
        .map(|height| *height)
        .unwrap_or(CALENDAR_HEIGHT);
    (calendar_width(show_week_numbers), height)
}

/// The tallest the popover may grow; past this the day's list scrolls.
pub(crate) const CALENDAR_MAX_HEIGHT: f64 = 620.0;

pub(crate) fn calendar_height(measured: f64) -> f64 {
    if measured.is_finite() {
        measured.clamp(CALENDAR_HEIGHT, CALENDAR_MAX_HEIGHT)
    } else {
        CALENDAR_HEIGHT
    }
}

/// Top-left of the popover, in the same coordinate space as the tray and screen.
pub(crate) fn popover_origin(
    tray_x: f64,
    tray_y: f64,
    _tray_w: f64,
    tray_h: f64,
    win_w: f64,
    win_h: f64,
    screen: ScreenBounds,
) -> (f64, f64, PopoverPlacement) {
    // Measured off a native status item menu on the same item: its frame
    // starts 3pt left of the item and 1pt under the menu bar, so the popover
    // lines up with every other app's menu instead of centring on its icon.
    const LEAD: f64 = 3.0;
    const GAP: f64 = 1.0;
    const PAD: f64 = 8.0;
    let mut x = tray_x - LEAD;
    let mut y = tray_y + tray_h + GAP;
    let mut placement = PopoverPlacement::Below;
    let min_x = screen.x + PAD;
    let max_x = screen.x + screen.width - win_w - PAD;
    if max_x >= min_x {
        x = x.clamp(min_x, max_x);
    }
    let max_y = screen.y + screen.height - win_h - PAD;
    if y > max_y {
        y = tray_y - win_h - GAP;
        placement = PopoverPlacement::Above;
    }
    (x, y, placement)
}

/// Where a popover of this size belongs under the tray icon, in logical
/// points, along with the bounds of the display it landed on.
pub(crate) fn place_under_tray(
    window: &WebviewWindow,
    tray_rect: tauri::Rect,
    width: f64,
    height: f64,
) -> (f64, f64, ScreenBounds) {
    let fallback_scale = window.scale_factor().unwrap_or(1.0);
    // Tray events already carry physical pixels, converted with the status
    // item's own scale. The hidden window often still sits on the primary
    // display, whose scale and bounds are the wrong ones to use here —
    // especially with a Retina laptop and a 1× external.
    let tray_pos: PhysicalPosition<f64> = tray_rect.position.to_physical(fallback_scale);
    let tray_size: PhysicalSize<f64> = tray_rect.size.to_physical(fallback_scale);
    let tray_cx = tray_pos.x + tray_size.width / 2.0;
    let tray_cy = tray_pos.y + tray_size.height / 2.0;

    let monitors = window.available_monitors().ok().unwrap_or_default();
    let monitor = monitors
        .iter()
        .find(|monitor| {
            point_in_screen(
                tray_cx,
                tray_cy,
                ScreenBounds {
                    x: monitor.position().x as f64,
                    y: monitor.position().y as f64,
                    width: monitor.size().width as f64,
                    height: monitor.size().height as f64,
                },
            )
        })
        .cloned()
        .or_else(|| window.primary_monitor().ok().flatten());
    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(fallback_scale);

    let tray_x = tray_pos.x / scale;
    let tray_y = tray_pos.y / scale;
    let tray_w = tray_size.width / scale;
    let tray_h = tray_size.height / scale;
    let screen = monitor
        .as_ref()
        .map(|monitor| ScreenBounds {
            x: monitor.position().x as f64 / scale,
            y: monitor.position().y as f64 / scale,
            width: monitor.size().width as f64 / scale,
            height: monitor.size().height as f64 / scale,
        })
        .unwrap_or(ScreenBounds {
            x: tray_x,
            y: tray_y,
            width: width.max(tray_w),
            height: height.max(tray_h),
        });
    let (x, y, _placement) = popover_origin(tray_x, tray_y, tray_w, tray_h, width, height, screen);
    (x, y, screen)
}

pub(crate) fn position_calendar(app: &AppHandle, tray_rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(CALENDAR_LABEL) else {
        return;
    };
    let (width, height) = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|store| store.value().show_week_numbers)
        .map(|weeks| calendar_window_size(app, weeks))
        .unwrap_or_else(|_| calendar_window_size(app, false));
    let (x, y, _screen) = place_under_tray(&window, tray_rect, width, height);
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
    // Logical points, not physical: set_position converts physical coords with
    // the *window's* current scale, which is still the other display's.
    let _ = window.set_position(Position::Logical(LogicalPosition::new(x, y)));
}

pub(crate) fn position_reminder(app: &AppHandle, tray_rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(REMINDER_LABEL) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let height = window
        .inner_size()
        .map(|size| size.to_logical::<f64>(scale).height)
        .unwrap_or(REMINDER_FLOOR);
    let (x, y, _screen) = place_under_tray(&window, tray_rect, REMINDER_WIDTH, height);
    let _ = window.set_position(Position::Logical(LogicalPosition::new(x, y)));
}

/// The status item's frame, which a shortcut has no click to carry.
pub(crate) fn tray_anchor(app: &AppHandle) -> Option<tauri::Rect> {
    let tray = app.tray_by_id(TRAY_ID)?;
    let rect = tray.rect().ok().flatten()?;
    Some(button_rect(&tray, rect))
}

/// Narrows the status item's window rect to its button.
///
/// The window is a few points wider than the button, and not evenly: the
/// button sits ~5pt in from its left edge. AppKit lines a status menu up with
/// the button, so the popover has to start from the same place to match.
#[cfg(target_os = "macos")]
pub(crate) fn button_rect(tray: &tauri::tray::TrayIcon, rect: tauri::Rect) -> tauri::Rect {
    use objc2_foundation::MainThreadMarker;

    let inset = std::sync::Arc::new(std::sync::Mutex::new(None));
    let found = inset.clone();
    let _ = tray.with_inner_tray_icon(move |inner| {
        let Some(item) = inner.ns_status_item() else {
            return;
        };
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if let Some(button) = item.button(mtm) {
            let frame = button.frame();
            if let Ok(mut slot) = found.lock() {
                *slot = Some((frame.origin.x, frame.size.width));
            }
        }
    });
    let Some((left, width)) = inset.lock().ok().and_then(|slot| *slot) else {
        return rect;
    };
    let scale = tray
        .app_handle()
        .get_webview_window(CALENDAR_LABEL)
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    let position: PhysicalPosition<f64> = rect.position.to_physical(scale);
    let size: PhysicalSize<f64> = rect.size.to_physical(scale);
    let monitor_scale = tray
        .app_handle()
        .get_webview_window(CALENDAR_LABEL)
        .and_then(|window| {
            window
                .monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(scale);
    tauri::Rect {
        position: tauri::Position::Physical(PhysicalPosition::new(
            (position.x + left * monitor_scale).round() as i32,
            position.y.round() as i32,
        )),
        size: tauri::Size::Physical(PhysicalSize::new(
            (width * monitor_scale).round() as u32,
            size.height.round() as u32,
        )),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn button_rect(_tray: &tauri::tray::TrayIcon, rect: tauri::Rect) -> tauri::Rect {
    rect
}

/// The card takes its content's height, between a floor and a ceiling.
pub(crate) fn reminder_height(content: f64) -> f64 {
    if !content.is_finite() || content <= 0.0 {
        return REMINDER_FLOOR;
    }
    content.clamp(REMINDER_FLOOR, REMINDER_CEILING)
}
