//! Keyboard-level copy detection (macOS).
//!
//! The clipboard change counter cannot see a ⌘C that the source app declines
//! to act on — holding ⌘ and tapping C twice is exactly that case, because the
//! second press arrives as a key repeat and many apps skip the redundant
//! pasteboard write. Watching the keyboard sees the keystroke itself, so the
//! ⌘-held gesture works. This is what DeepL does, and it is why DeepL asks for
//! Accessibility permission on first launch.
//!
//! `NSEvent`'s global monitor is observe-only — it cannot swallow or rewrite
//! events, so copy keeps working normally in every other app.

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;

    /// `kVK_ANSI_C`. Virtual key codes are positional, so this is the physical
    /// C key on any keyboard layout.
    const KEY_C: u16 = 8;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    /// Whether this app may observe keyboard events. Without it the monitor
    /// installs cleanly but never receives anything.
    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn open_privacy_settings() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }

    /// Installs a global ⌘C monitor. Must run on the main thread — the monitor
    /// is attached to its run loop. Returns false if macOS refused.
    pub fn install<F>(on_copy: F) -> bool
    where
        F: Fn() + Send + Sync + 'static,
    {
        use block2::RcBlock;
        use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

        let block = RcBlock::new(move |event: NonNull<NSEvent>| {
            // Safety: AppKit hands us a valid event for the callback's duration.
            let event = unsafe { event.as_ref() };

            // A held-down C autorepeats; only deliberate presses count.
            if event.isARepeat() || event.keyCode() != KEY_C {
                return;
            }
            // Copy is ⌘C and nothing more: ⌘⇧C, ⌘⌥C and ⌘⌃C belong to other
            // apps, and pairing them off as copies fires on gestures the user
            // aimed somewhere else. Caps lock and fn are left out of the test —
            // they ride along on ordinary keys without changing the shortcut.
            let flags = event.modifierFlags();
            let extras = NSEventModifierFlags::Shift
                | NSEventModifierFlags::Control
                | NSEventModifierFlags::Option;
            if !flags.contains(NSEventModifierFlags::Command) || flags.intersects(extras) {
                return;
            }
            on_copy();
        });

        match NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block) {
            Some(monitor) => {
                // The monitor lives for the process; releasing it would remove it.
                std::mem::forget(monitor);
                true
            }
            None => false,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn is_trusted() -> bool {
        false
    }

    pub fn open_privacy_settings() {}

    pub fn install<F>(_on_copy: F) -> bool
    where
        F: Fn() + Send + Sync + 'static,
    {
        false
    }
}

pub use imp::{install, is_trusted, open_privacy_settings};

/// Whether this platform has a keyboard-level path at all.
pub const fn is_available() -> bool {
    cfg!(target_os = "macos")
}
