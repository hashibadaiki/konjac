//! Double-copy detection.
//!
//! `⌘C ⌘C` cannot be a global accelerator: registering `Cmd+C` would swallow
//! the copy shortcut in every other app. Instead this watches the platform's
//! clipboard *change counter*, which increments on every write even when the
//! copied text is identical — so two copies in quick succession are visible
//! without reading a single keyboard event, and without needing accessibility
//! permissions.
//!
//! Linux has no equivalent counter (X11 exposes selection ownership, not a
//! write count), so the feature reports itself unsupported there.
//!
//! Nothing here reads what is *on* the clipboard. The counter is a number that
//! goes up; the body is read once, by [`crate::present_clipboard`], at the
//! moment a double copy is recognized — which is why this watcher only ever
//! runs with the user's consent ([`crate::settings::Settings::gated`]) and why
//! [`Watcher::is_enabled`] is checked again at that read.
//!
//! The counter's blind spot is *who* wrote. A dictation tool that inserts text
//! by putting it on the clipboard, pasting, and then putting the user's old
//! clipboard back produces two writes that the counter cannot tell from two
//! copies — and reading the contents to compare them is not free either, since
//! macOS now alerts on programmatic pasteboard reads. What is free is timing:
//! writes that share a poll interval are too close together to be two presses
//! (see [`Watcher::note_burst`]). Beyond that the fallback cannot separate the
//! two, and the keyboard detector — immune, because inserting text sends ⌘V and
//! never ⌘C — is the way out.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Also the "too fast to be a person" threshold: writes that share one interval
/// are treated as one app's burst, so this has to stay well under the shortest
/// gap between two deliberate presses of ⌘C.
const POLL_INTERVAL: Duration = Duration::from_millis(60);
/// AppKit is not ready while `setup()` runs, so the first pasteboard read has
/// to wait for the event loop to come up.
const STARTUP_GRACE: Duration = Duration::from_millis(1200);

pub const MIN_WINDOW_MS: u64 = 150;
pub const MAX_WINDOW_MS: u64 = 2000;

/// Live view of the watcher, surfaced in the settings pane so a
/// "it doesn't fire" report can be traced to a specific stage.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// Some detector is possible on this platform ([`is_detectable`]).
    pub supported: bool,
    /// A detector is live.
    pub running: bool,
    pub enabled: bool,
    pub window_ms: u64,
    /// Which detector is in use: `keyboard`, `clipboard`, or `none`.
    pub source: &'static str,
    /// macOS only: the keyboard detector is unavailable for want of
    /// Accessibility permission, so ⌘ held down with two taps of C is invisible.
    pub needs_permission: bool,
    /// Most recent raw clipboard counter value (clipboard detector only).
    pub change_count: i64,
    /// Copies attributed to the user (this app's own writes excluded).
    pub copies_seen: u64,
    /// Clipboard writes rejected as another app's burst rather than a press.
    pub bursts_ignored: u64,
    /// Times a double copy was recognized and the window was presented.
    pub doubles_fired: u64,
}

pub struct Watcher {
    enabled: AtomicBool,
    window_ms: AtomicU64,
    /// Clipboard writes this app made itself, which must not count as copies.
    pending_self_writes: AtomicI64,
    running: AtomicBool,
    /// Set once the keyboard monitor takes over, which suppresses the
    /// clipboard detector so a single gesture cannot fire twice.
    keyboard_active: AtomicBool,
    change_count: AtomicI64,
    copies_seen: AtomicU64,
    bursts_ignored: AtomicU64,
    doubles_fired: AtomicU64,
    last_copy_at: Mutex<Option<Instant>>,
}

impl Watcher {
    pub fn new(enabled: bool, window_ms: u64) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            window_ms: AtomicU64::new(window_ms),
            pending_self_writes: AtomicI64::new(0),
            running: AtomicBool::new(false),
            keyboard_active: AtomicBool::new(false),
            change_count: AtomicI64::new(0),
            copies_seen: AtomicU64::new(0),
            bursts_ignored: AtomicU64::new(0),
            doubles_fired: AtomicU64::new(0),
            last_copy_at: Mutex::new(None),
        }
    }

    pub fn configure(&self, enabled: bool, window_ms: u64) {
        self.enabled.store(enabled, Ordering::Relaxed);
        self.window_ms.store(window_ms, Ordering::Relaxed);
    }

    /// The single condition under which the clipboard *body* may be read —
    /// checked again at the read itself, in [`crate::present_clipboard`], rather
    /// than trusted to hold from whenever the detector last looked.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Call immediately after this app writes to the clipboard.
    pub fn note_self_write(&self) {
        // The keyboard detector never looks at the counter, and the polling
        // thread has already exited by then, so nothing would ever consume
        // these — recording them would just grow a number forever.
        if self.uses_keyboard() {
            return;
        }
        self.pending_self_writes.fetch_add(1, Ordering::Relaxed);
    }

    pub fn mark_keyboard_active(&self) {
        self.keyboard_active.store(true, Ordering::Relaxed);
        self.running.store(true, Ordering::Relaxed);
    }

    pub fn uses_keyboard(&self) -> bool {
        self.keyboard_active.load(Ordering::Relaxed)
    }

    /// Records one user copy and reports whether it completed a double tap.
    /// Shared by both detectors so the pairing rule has a single definition.
    pub fn note_copy(&self) -> bool {
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        self.copies_seen.fetch_add(1, Ordering::Relaxed);

        let window = Duration::from_millis(self.window_ms.load(Ordering::Relaxed));
        let now = Instant::now();

        let Ok(mut last) = self.last_copy_at.lock() else {
            return false;
        };
        let is_double = last.is_some_and(|earlier| now.duration_since(earlier) <= window);

        // Clear on a hit so a third copy starts a fresh pair rather than
        // firing again off the second.
        *last = if is_double { None } else { Some(now) };
        drop(last);

        if is_double {
            self.doubles_fired.fetch_add(1, Ordering::Relaxed);
        }
        is_double
    }

    /// Several clipboard writes landed inside one [`POLL_INTERVAL`] — faster
    /// than anyone presses ⌘C twice, so this is one app writing in a burst, not
    /// the user. Dictation tools (Aqua Voice, Wispr Flow, …) insert text by
    /// writing the transcript, pasting it, then writing the previous clipboard
    /// back; counting those two writes as two taps fired the window on every
    /// dictation.
    ///
    /// The pending half-pair goes too: what such an app left on the clipboard
    /// must not become the first tap of a gesture the user never made.
    pub fn note_burst(&self) {
        self.bursts_ignored.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut last) = self.last_copy_at.lock() {
            *last = None;
        }
    }

    pub fn status(&self) -> WatchStatus {
        let keyboard = self.keyboard_active.load(Ordering::Relaxed);
        let running = self.running.load(Ordering::Relaxed);

        WatchStatus {
            supported: is_detectable(),
            running,
            enabled: self.enabled.load(Ordering::Relaxed),
            window_ms: self.window_ms.load(Ordering::Relaxed),
            source: match (keyboard, running) {
                (true, _) => "keyboard",
                (false, true) => "clipboard",
                (false, false) => "none",
            },
            needs_permission: crate::key_watch::is_available() && !keyboard,
            change_count: self.change_count.load(Ordering::Relaxed),
            copies_seen: self.copies_seen.load(Ordering::Relaxed),
            bursts_ignored: self.bursts_ignored.load(Ordering::Relaxed),
            doubles_fired: self.doubles_fired.load(Ordering::Relaxed),
        }
    }

    /// Consume up to `observed` recorded self-writes, returning how many
    /// of the observed changes they account for.
    fn take_self_writes(&self, observed: i64) -> i64 {
        let mut pending = self.pending_self_writes.load(Ordering::Relaxed);
        loop {
            let consumed = pending.min(observed).max(0);
            if consumed == 0 {
                return 0;
            }
            match self.pending_self_writes.compare_exchange_weak(
                pending,
                pending - consumed,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return consumed,
                Err(actual) => pending = actual,
            }
        }
    }
}

/// Whether this platform exposes a clipboard change counter, i.e. whether the
/// no-permission fallback detector can run.
pub const fn is_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Whether ⌘C ⌘C can be detected at all here, by either detector. The single
/// predicate behind the settings checkbox, `normalized()`, and `supported`.
pub const fn is_detectable() -> bool {
    is_supported() || crate::key_watch::is_available()
}

#[cfg(target_os = "macos")]
fn change_count() -> Option<i64> {
    use objc2_app_kit::NSPasteboard;
    // NSPasteboard is not a main-thread-only class in objc2's model (its
    // bindings take no MainThreadMarker), so polling from this thread is fine
    // — but only once AppKit itself is up, hence STARTUP_GRACE.
    Some(NSPasteboard::generalPasteboard().changeCount() as i64)
}

#[cfg(target_os = "windows")]
fn change_count() -> Option<i64> {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    Some(unsafe { GetClipboardSequenceNumber() } as i64)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn change_count() -> Option<i64> {
    None
}

/// Starts the polling thread. Does nothing on platforms without a change
/// counter; the thread lives for the process lifetime.
pub fn spawn<F>(watcher: Arc<Watcher>, on_double_copy: F)
where
    F: Fn() + Send + 'static,
{
    if !is_supported() {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_GRACE);

        // Read lazily: the first successful read establishes the baseline, so
        // a counter that is not yet available simply delays startup rather
        // than pinning the baseline to a bogus zero.
        let mut last_count: Option<i64> = None;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            // The keyboard monitor, where available, sees strictly more than
            // this does — stand down rather than double-fire on one gesture.
            if watcher.uses_keyboard() {
                return;
            }

            let Some(count) = change_count() else {
                watcher.running.store(false, Ordering::Relaxed);
                return;
            };
            watcher.running.store(true, Ordering::Relaxed);
            watcher.change_count.store(count, Ordering::Relaxed);

            let Some(previous) = last_count else {
                last_count = Some(count);
                continue;
            };
            if count == previous {
                continue;
            }
            if count < previous {
                // Counter reset (rare, e.g. session change) — resynchronize.
                last_count = Some(count);
                continue;
            }

            let observed = count - previous;
            last_count = Some(count);

            // Don't let self-writes accumulate while the feature is off.
            let copies = observed - watcher.take_self_writes(observed);
            if copies <= 0 || !watcher.enabled.load(Ordering::Relaxed) {
                continue;
            }

            // Two writes in one observation are machine speed, not two presses.
            if copies > 1 {
                watcher.note_burst();
                continue;
            }

            if watcher.note_copy() {
                on_double_copy();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_writes_are_consumed_at_most_once() {
        let watcher = Watcher::new(true, 600);
        watcher.note_self_write();
        watcher.note_self_write();

        assert_eq!(watcher.take_self_writes(1), 1);
        assert_eq!(watcher.take_self_writes(5), 1);
        assert_eq!(watcher.take_self_writes(5), 0);
    }

    /// Nothing consumes self-writes once the keyboard detector is in charge, so
    /// recording them would grow a counter that is never drained.
    #[test]
    fn self_writes_are_dropped_under_the_keyboard_detector() {
        let watcher = Watcher::new(true, 600);
        watcher.mark_keyboard_active();
        watcher.note_self_write();

        assert_eq!(watcher.take_self_writes(1), 0);
    }

    #[test]
    fn take_self_writes_is_a_no_op_without_pending_writes() {
        let watcher = Watcher::new(true, 600);
        assert_eq!(watcher.take_self_writes(3), 0);
    }

    #[test]
    fn configure_updates_both_knobs() {
        let watcher = Watcher::new(false, 600);
        watcher.configure(true, 900);

        let status = watcher.status();
        assert!(status.enabled);
        assert_eq!(status.window_ms, 900);
    }

    /// Until a detector reports in, the pane must not claim the watcher is live.
    #[test]
    fn status_starts_not_running() {
        let status = Watcher::new(true, 600).status();
        assert!(!status.running);
        assert_eq!(status.source, "none");
        assert_eq!(status.copies_seen, 0);
        assert_eq!(status.bursts_ignored, 0);
        assert_eq!(status.doubles_fired, 0);
    }

    #[test]
    fn second_copy_inside_the_window_is_a_double() {
        let watcher = Watcher::new(true, 600);
        assert!(!watcher.note_copy());
        assert!(watcher.note_copy());
        assert_eq!(watcher.status().doubles_fired, 1);
    }

    /// A third copy must start a fresh pair instead of firing off the second.
    #[test]
    fn a_triple_tap_fires_once() {
        let watcher = Watcher::new(true, 600);
        watcher.note_copy();
        assert!(watcher.note_copy());
        assert!(!watcher.note_copy());
        assert_eq!(watcher.status().doubles_fired, 1);
    }

    #[test]
    fn copies_outside_the_window_do_not_pair() {
        let watcher = Watcher::new(true, MIN_WINDOW_MS);
        assert!(!watcher.note_copy());
        std::thread::sleep(Duration::from_millis(MIN_WINDOW_MS + 60));
        assert!(!watcher.note_copy());
        assert_eq!(watcher.status().copies_seen, 2);
        assert_eq!(watcher.status().doubles_fired, 0);
    }

    /// Inserting dictated text writes the transcript, pastes, then writes the
    /// user's clipboard back. Landing in one poll, that is a burst: counted for
    /// diagnosis, never fired, and it clears any half-finished pair so the text
    /// the other app left behind cannot start a gesture either.
    #[test]
    fn a_burst_is_ignored_and_drops_the_pending_copy() {
        let watcher = Watcher::new(true, 600);
        watcher.note_copy();

        watcher.note_burst();

        assert!(!watcher.note_copy());
        let status = watcher.status();
        assert_eq!(status.bursts_ignored, 1);
        assert_eq!(status.copies_seen, 2);
        assert_eq!(status.doubles_fired, 0);
    }

    /// Two presses must not pair up while the feature is off, and — the part
    /// that matters for the clipboard body — `is_enabled` must keep saying no,
    /// since that is what gates the read.
    #[test]
    fn disabled_watcher_ignores_copies() {
        let watcher = Watcher::new(false, 600);
        assert!(!watcher.note_copy());
        assert!(!watcher.note_copy());
        assert_eq!(watcher.status().copies_seen, 0);
        assert!(!watcher.is_enabled());
    }

    /// Turning it off at runtime (unticking the box, or a save that lands while
    /// a gesture is half-finished) has to shut the read off too.
    #[test]
    fn configure_can_withdraw_the_clipboard_read() {
        let watcher = Watcher::new(true, 600);
        assert!(watcher.is_enabled());

        watcher.configure(false, 600);
        assert!(!watcher.is_enabled());
        assert!(!watcher.note_copy());
    }

    #[test]
    fn keyboard_detector_takes_over_the_source_label() {
        let watcher = Watcher::new(true, 600);
        watcher.mark_keyboard_active();
        let status = watcher.status();
        assert!(watcher.uses_keyboard());
        assert_eq!(status.source, "keyboard");
        assert!(!status.needs_permission);
    }
}
