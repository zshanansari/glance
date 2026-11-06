//! The minute tick the windows redraw on, kept on time across sleep.

use super::*;

/// Lands a tick just past each wall-clock minute, so a countdown turns over
/// with the clock instead of up to half a minute late.
///
/// The wait is measured on a clock that stops while the Mac sleeps, so a wait
/// begun before sleep ends at some arbitrary time after wake. Waking therefore
/// nudges the loop: it ticks at once and re-aligns to the next minute.
pub(crate) fn spawn_clock(app: AppHandle) {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::time::{SystemTime, UNIX_EPOCH};

    let (nudge, nudges) = channel::<()>();
    watch_for_wake(nudge.clone());
    std::thread::spawn(move || {
        // Held so the channel never disconnects, even without a wake watcher.
        let _nudge = nudge;
        loop {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            if let Err(RecvTimeoutError::Disconnected) = nudges.recv_timeout(until_next_minute(now))
            {
                return;
            }
            let _ = app.emit("clock-tick", ());
        }
    });
}

/// How long to wait from `now` (time since the epoch) until just past the next
/// minute. The slack keeps a timer that fires a hair early from ticking at
/// :59.99 and painting the minute that is ending.
pub(crate) fn until_next_minute(now: Duration) -> Duration {
    const MINUTE_MS: u128 = 60_000;
    const SLACK: Duration = Duration::from_millis(50);
    let into_minute = now.as_millis() % MINUTE_MS;
    Duration::from_millis((MINUTE_MS - into_minute) as u64) + SLACK
}

/// Sends on `nudge` each time the Mac wakes from sleep.
#[cfg(target_os = "macos")]
pub(crate) fn watch_for_wake(nudge: std::sync::mpsc::Sender<()>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        let _ = nudge.send(());
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            None,
            &block,
        )
    };
    // The watch lasts as long as the app; nothing ever removes it.
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn watch_for_wake(_nudge: std::sync::mpsc::Sender<()>) {}
