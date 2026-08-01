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
    use std::ffi::c_void;
    use std::ptr::NonNull;

    /// `kVK_ANSI_C`. Virtual key codes are positional, so this is the physical
    /// C key on any keyboard layout.
    const KEY_C: u16 = 8;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        /// The same test as [`AXIsProcessTrusted`], except the options
        /// dictionary can ask macOS to put its own alert up when the answer is
        /// no. Takes a `CFDictionaryRef`.
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        /// `CFStringRef`. Typed as an opaque pointer so the `extern` block
        /// stays FFI-safe; it is cast where it is used.
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    /// Whether this app may observe keyboard events. Without it the monitor
    /// installs cleanly but never receives anything.
    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Asks for the permission, putting up the system alert when it is missing.
    ///
    /// This is also the only way the app gets into the Accessibility list at
    /// all — an app cannot add its own row, so until it has asked once, sending
    /// the user to the permission pane sends them to a list this app is not in
    /// and there is nothing there to switch on.
    ///
    /// Returns whether permission is already in hand. The alert is answered
    /// outside this process, so `false` means "not yet", never "refused".
    pub fn request_trust() -> bool {
        use objc2_foundation::{NSDictionary, NSNumber, NSString};

        // Safety: the framework owns this string for the life of the process,
        // and CFString is toll-free bridged to NSString.
        let key: &NSString = unsafe { &*(kAXTrustedCheckOptionPrompt as *const NSString) };
        let prompt = NSNumber::new_bool(true);
        let options = NSDictionary::from_slices(&[key], &[&*prompt]);
        let options: *const NSDictionary<NSString, NSNumber> = &*options;

        unsafe { AXIsProcessTrustedWithOptions(options.cast()) }
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

    pub fn request_trust() -> bool {
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

pub use imp::{install, is_trusted, open_privacy_settings, request_trust};

/// Whether this platform has a keyboard-level path at all.
pub const fn is_available() -> bool {
    cfg!(target_os = "macos")
}
