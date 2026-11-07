//! The month popover as a menu extra: on screen and taking the keyboard
//! without taking the front app's focus.
//!
//! An accessory app that activates itself to show a window pulls the caret
//! out of whatever the user was typing in. Dropping the activation is only
//! half the fix: an ordinary `NSWindow` cannot be *used* by an app that is
//! not active, so a popover that no longer steals focus also stops reacting
//! to the pointer and the keyboard.
//!
//! `NSPanel` with `NSWindowStyleMaskNonactivatingPanel` is the shape AppKit
//! offers for this, and the one system menu extras use. Such a panel can hold
//! key — taking hover, clicks, arrow keys and the typing quick add and search
//! need — while its application stays inactive and the front app keeps its
//! caret and its place in the menu bar. It also resigns key the moment the
//! user turns to something else, which is the blur the popover already
//! closes on.
//!
//! Ported from upstream Calendo's fix for its issue 24 (PR 25).

use objc2::msg_send;
use objc2::runtime::AnyObject;

/// Turns a popover window into a nonactivating `NSPanel`.
///
/// Tao builds `TaoWindow : NSWindow` and Tauri gives no say in the class, so
/// the class is changed after the window is built. The object keeps its
/// allocation, so the new class must describe exactly as many bytes as the old
/// one: `NSPanel` adds no storage over `NSWindow`, and [`panel_class`] pads the
/// difference back out. `TaoWindow`'s own overrides are cheap to lose —
/// `canBecomeKeyWindow` and `canBecomeMainWindow` read an ivar the new class
/// does not have, so the subclass answers them itself, and its `sendEvent:`
/// only drags a window by its background, which a popover on a fixed anchor
/// never does.
///
/// Must run *after* the glass material is applied: swapping the class first
/// leaves `setContentView:` to crash on the way through KVO.
///
/// Must run on the main thread. Setup already does.
#[cfg(target_os = "macos")]
pub fn as_nonactivating_panel(window: &tauri::WebviewWindow) {
    use objc2::runtime::Bool;

    /// `NSWindowStyleMaskNonactivatingPanel`, the one bit a popover needs and
    /// the only one AppKit reads off a borderless panel.
    const NONACTIVATING: usize = 1 << 7;

    let Some(ns_window) = crate::glass::window_object(window) else {
        return;
    };
    let Some(class) = panel_class(ns_window.class().instance_size()) else {
        return;
    };
    unsafe {
        let _ = AnyObject::set_class(ns_window, class);
        let _: () = msg_send![ns_window, setStyleMask: NONACTIVATING];
        // An `NSPanel` hides itself when its app deactivates. Glance is an
        // accessory that is never active to begin with, and the popover
        // closes on its own blur; leave it to that.
        let _: () = msg_send![ns_window, setHidesOnDeactivate: Bool::NO];
        // Hover is mouse-moved events, which AppKit withholds unless asked.
        let _: () = msg_send![ns_window, setAcceptsMouseMovedEvents: Bool::YES];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn as_nonactivating_panel(_window: &tauri::WebviewWindow) {}

/// Puts the popover on screen already key, in one step, the way a status
/// menu appears: no fade in, no first frame drawn in the inactive look.
///
/// `makeKeyAndOrderFront:` on a nonactivating panel makes the popover key —
/// so hover, clicks, arrow keys and typing all reach it — while Glance stays
/// inactive and the app the user was in keeps the caret and the menu bar.
/// `set_focus()` would add `activateIgnoringOtherApps:` on top, and that is
/// the focus theft itself.
pub fn present(window: &tauri::WebviewWindow) {
    let Some(ns_window) = crate::glass::window_object(window) else {
        let _ = window.show();
        return;
    };
    unsafe {
        let _: () = msg_send![ns_window, setAlphaValue: 1.0f64];
        let nil: *const AnyObject = std::ptr::null();
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
    }
}

/// `NSPanel`, plus the two answers `TaoWindow` used to give from an ivar,
/// padded to `size` so adopting it does not change how large the object claims
/// to be.
///
/// Key but never main: key is what carries hover, clicks and typing, main is
/// what would drag Glance to the front.
///
/// `None` when the padding cannot work out — an `NSPanel` grown past the
/// window it would replace. Better a popover that keeps its old class than
/// one that writes past its allocation.
#[cfg(target_os = "macos")]
fn panel_class(size: usize) -> Option<&'static objc2::runtime::AnyClass> {
    use objc2::runtime::{AnyClass, Bool, ClassBuilder, Sel};
    use objc2::{class, sel};
    use std::sync::OnceLock;

    extern "C" fn yes(_this: &AnyObject, _sel: Sel) -> Bool {
        Bool::YES
    }
    extern "C" fn no(_this: &AnyObject, _sel: Sel) -> Bool {
        Bool::NO
    }

    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        const NAME: &std::ffi::CStr = c"GlancePopoverPanel";
        if let Some(existing) = AnyClass::get(NAME) {
            return Some(existing);
        }
        let panel = class!(NSPanel);
        let padding = size.checked_sub(panel.instance_size())?;
        let mut builder = ClassBuilder::new(NAME, panel)?;
        unsafe {
            builder.add_method(sel!(canBecomeKeyWindow), yes as extern "C" fn(_, _) -> _);
            builder.add_method(sel!(canBecomeMainWindow), no as extern "C" fn(_, _) -> _);
        }
        // A byte at a time: `u8` aligns to one, so the ivars pack tight and the
        // class lands on exactly the size asked for.
        for index in 0..padding {
            let name = std::ffi::CString::new(format!("glance_pad{index}")).ok()?;
            builder.add_ivar::<u8>(&name);
        }
        let class = builder.register();
        (class.instance_size() == size).then_some(class)
    })
}
