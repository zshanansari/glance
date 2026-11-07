//! The two system-wide chords: binding them, setting them aside while Settings
//! records one, and saying when macOS refuses one.

use super::*;

/// What each system-wide chord does when it fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShortcutAction {
    ToggleCalendar,
    JoinUpcoming,
}

#[derive(Default)]
pub(crate) struct RegisteredShortcuts {
    pub(crate) toggle_calendar: Option<Shortcut>,
    pub(crate) join_meeting: Option<Shortcut>,
}

impl RegisteredShortcuts {
    pub(crate) fn slot(&mut self, action: ShortcutAction) -> &mut Option<Shortcut> {
        match action {
            ShortcutAction::ToggleCalendar => &mut self.toggle_calendar,
            ShortcutAction::JoinUpcoming => &mut self.join_meeting,
        }
    }

    pub(crate) fn action_for(&self, shortcut: &Shortcut) -> Option<ShortcutAction> {
        if self.toggle_calendar.as_ref() == Some(shortcut) {
            return Some(ShortcutAction::ToggleCalendar);
        }
        if self.join_meeting.as_ref() == Some(shortcut) {
            return Some(ShortcutAction::JoinUpcoming);
        }
        None
    }
}

/// Opens the month popover from anywhere, closing the events popover first.
pub(crate) fn toggle_calendar_from_shortcut(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(rect) = tray_anchor(&handle) else {
            return;
        };
        toggle_calendar(&handle, rect);
    });
}

/// The calendar window already knows which event the menu bar is previewing,
/// so the shortcut asks it to open that link rather than picking one here.
pub(crate) fn join_upcoming_from_shortcut(app: &AppHandle) {
    let _ = app.emit_to(CALENDAR_LABEL, "join-upcoming", ());
}

pub(crate) fn run_shortcut(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::ToggleCalendar => toggle_calendar_from_shortcut(app),
        ShortcutAction::JoinUpcoming => join_upcoming_from_shortcut(app),
    }
}

/// Binds one chord, keeping the working one when the system refuses the new.
/// False when the chord could not be bound.
///
/// macOS may hand a chord to another app first, or ask for Accessibility
/// before it will deliver one at all. The new chord is bound before the old
/// one is let go, so a refusal leaves the working one exactly as it was and
/// never both unbound; the caller tells Settings so the field does not claim
/// a chord that does nothing.
///
/// While Settings is recording, every chord is set aside. A chord saved then
/// is tried and let go again at once, so it is known to bind but does not
/// fire into the recorder; unsuspending binds what is recorded here.
///
/// Registering blocks on the main thread, so this must run off it and must
/// not hold `shortcuts` while it waits: the main thread may be inside the
/// hotkey handler, which reads that same state.
pub(crate) fn rebind_shortcut(app: &AppHandle, action: ShortcutAction, chord: &str) -> bool {
    let desired: Option<Shortcut> = match chord.trim() {
        "" => None,
        text => match text.parse::<Shortcut>() {
            Ok(shortcut) => Some(shortcut),
            Err(error) => {
                eprintln!("Ignoring unreadable shortcut {text:?}: {error}");
                return false;
            }
        },
    };
    let state = app.state::<AppState>();
    let previous = match state.shortcuts.lock() {
        Ok(mut registered) => *registered.slot(action),
        Err(_) => return false,
    };
    if previous == desired {
        return true;
    }
    let suspended = state.shortcuts_suspended.load(Ordering::SeqCst);
    let bound = match desired {
        None => {
            if let Some(old) = previous {
                let _ = app.global_shortcut().unregister(old);
            }
            None
        }
        Some(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                // The old chord, if any, is still bound; the suspended set
                // has already been let go, so only an unsuspended one needs
                // releasing. Set aside again when recording: it is only known
                // to bind, not meant to fire yet.
                if suspended {
                    let _ = app.global_shortcut().unregister(shortcut);
                } else if let Some(old) = previous {
                    let _ = app.global_shortcut().unregister(old);
                }
                Some(shortcut)
            }
            Err(error) => {
                eprintln!("Could not register {chord:?}: {error}");
                // The working chord was never let go.
                previous
            }
        },
    };
    let ok = bound == desired;
    let locked = state.shortcuts.lock();
    if let Ok(mut registered) = locked {
        *registered.slot(action) = bound;
    }
    ok
}

pub(crate) fn set_shortcuts_suspended(app: &AppHandle, suspended: bool) {
    let state = app.state::<AppState>();
    if state.shortcuts_suspended.swap(suspended, Ordering::SeqCst) == suspended {
        return;
    }
    // Registering blocks on the main thread, so it happens off it, in turn
    // with any rebinding.
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<AppState>();
        let Ok(_rebinding) = state.shortcut_rebind.lock() else {
            return;
        };
        // A quick pair of calls leaves only the last one to act.
        if state.shortcuts_suspended.load(Ordering::SeqCst) != suspended {
            return;
        }
        let bound: Vec<Shortcut> = match state.shortcuts.lock() {
            Ok(registered) => [registered.toggle_calendar, registered.join_meeting]
                .into_iter()
                .flatten()
                .collect(),
            Err(_) => return,
        };
        for shortcut in bound {
            let _ = if suspended {
                handle.global_shortcut().unregister(shortcut)
            } else {
                handle.global_shortcut().register(shortcut)
            };
        }
    });
}

/// What Settings hears when macOS would not bind a chord.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutFailure {
    /// The setting's key, as `toggleCalendarShortcut`.
    pub(crate) setting: &'static str,
    pub(crate) chord: String,
}

/// Puts each chord macOS refused back to the one still bound, and says
/// which. A chord changed again since it was tried is left alone: the newer
/// one is being bound on its own.
pub(crate) fn put_back_refused_shortcuts(
    mut next: AppSettings,
    previous: &AppSettings,
    (toggle, toggle_ok): (&str, bool),
    (join, join_ok): (&str, bool),
) -> (AppSettings, Vec<ShortcutFailure>) {
    let mut failures = Vec::new();
    if !toggle_ok && next.toggle_calendar_shortcut == toggle {
        next.toggle_calendar_shortcut = previous.toggle_calendar_shortcut.clone();
        failures.push(ShortcutFailure {
            setting: "toggleCalendarShortcut",
            chord: toggle.to_string(),
        });
    }
    if !join_ok && next.join_meeting_shortcut == join {
        next.join_meeting_shortcut = previous.join_meeting_shortcut.clone();
        failures.push(ShortcutFailure {
            setting: "joinMeetingShortcut",
            chord: join.to_string(),
        });
    }
    (next, failures)
}

/// Binds both chords on a worker thread. During setup the event loop has not
/// started yet, so a registration made here would wait on a main thread that
/// is not reading tasks.
///
/// With `previous`, a chord macOS refuses is put back in Settings to the one
/// still bound, and Settings is told why.
pub(crate) fn apply_shortcuts(
    app: &AppHandle,
    settings: &AppSettings,
    previous: Option<&AppSettings>,
) {
    let handle = app.clone();
    let toggle = settings.toggle_calendar_shortcut.clone();
    let join = settings.join_meeting_shortcut.clone();
    let previous = previous.cloned();
    std::thread::spawn(move || {
        let state = handle.state::<AppState>();
        let Ok(_rebinding) = state.shortcut_rebind.lock() else {
            return;
        };
        let toggle_ok = rebind_shortcut(&handle, ShortcutAction::ToggleCalendar, &toggle);
        let join_ok = rebind_shortcut(&handle, ShortcutAction::JoinUpcoming, &join);
        let Some(previous) = previous else {
            return;
        };
        let (saved, failures) = {
            let Ok(mut store) = state.settings.lock() else {
                return;
            };
            let (next, failures) = put_back_refused_shortcuts(
                store.value(),
                &previous,
                (&toggle, toggle_ok),
                (&join, join_ok),
            );
            if failures.is_empty() {
                return;
            }
            // The chord put back is in force either way; the file matters
            // only for the next launch.
            let saved = store.update(next).unwrap_or_else(|error| {
                eprintln!("Could not save the shortcut put back: {error}");
                store.value()
            });
            (saved, failures)
        };
        let _ = handle.emit("settings-changed", &saved);
        for failure in failures {
            let _ = handle.emit_to(SETTINGS_LABEL, "shortcut-failed", failure);
        }
    });
}
