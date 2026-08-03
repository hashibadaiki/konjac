use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Only applies to a fresh install — an existing `settings.json` keeps whatever
/// model it already names.
///
/// Translation is a fixed transform, so the headroom above sonnet buys little
/// here, and measured on this app's own invocation sonnet is not the slower
/// choice either: 6,000 characters took 25.9s on sonnet against 24.6s on haiku,
/// and 48,000 took 127s against 147s. What it does buy is length. The point
/// where the model stops returning the whole translation is set by its output
/// ceiling, and sonnet's is twice haiku's — intact at 144,000 source characters
/// where haiku is already dropping the head of the document at 80,000.
pub const DEFAULT_MODEL: &str = "sonnet";

/// The marker recording that the user has been told what enabling the gesture
/// sends, and where, and agreed to it. See [`Settings::gated`].
pub const CLIPBOARD_CONSENT: &str = "clipboard-consent";

/// Fields dropped since earlier versions (`shortcut`, `shortcut_enabled`,
/// `auto_translate_clipboard`) are simply ignored when an old `settings.json`
/// is read: serde skips unknown keys, so nothing else has to be migrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Path to (or bare name of) the `claude` executable. Translation runs
    /// through the CLI so it authenticates with the user's Claude subscription.
    pub claude_bin: String,
    /// A CLI model alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model
    /// id such as `claude-opus-4-8`.
    pub model: String,
    pub source_lang: String,
    pub target_lang: String,
    pub tone: String,
    /// Show the window and translate when the user presses ⌘C twice in quick
    /// succession. Needs a detector — see [`crate::clipboard_watch::is_detectable`]
    /// — and the user's consent, see [`Settings::gated`].
    pub double_copy_enabled: bool,
    pub double_copy_window_ms: u64,
    /// Whether a gesture recognized by the *clipboard* detector may start a
    /// translation on its own, rather than only filling the input box.
    ///
    /// Off by default because that detector cannot tell a copy from any other
    /// app's clipboard write (see [`crate::clipboard_watch`]): a dictation tool
    /// putting text back would otherwise send whatever was on the clipboard to
    /// Anthropic with no press of the button. The keyboard detector reads ⌘C
    /// itself and has no such blind spot, so it is not subject to this.
    pub clipboard_auto_translate: bool,
    pub auto_copy_result: bool,
    pub timeout_secs: u64,
    /// Whether to ask GitHub for the newest release on launch and say so when
    /// this build is behind it.
    ///
    /// Covers the notice only. The advisory that stops a build people must not
    /// keep using is fetched either way — see [`crate::update`] — because a
    /// switch that also turns that off would leave the installs most in need of
    /// reaching as the ones that cannot be reached.
    pub check_for_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            claude_bin: "claude".into(),
            model: DEFAULT_MODEL.into(),
            source_lang: "auto".into(),
            target_lang: "Japanese".into(),
            tone: "default".into(),
            // Off on a fresh install, on purpose. Watching for the gesture is
            // what makes the app read the clipboard at all, and a detector that
            // fires by mistake sends whatever is on it — a password, a token, an
            // internal document — to Anthropic. That is not a thing to opt a
            // user into on their behalf; enabling it is their call, made once
            // they have been told what it does (`gated`).
            double_copy_enabled: false,
            double_copy_window_ms: 600,
            clipboard_auto_translate: false,
            auto_copy_result: false,
            // Idle, not total — see `run_cli_streaming`. All it has to cover is
            // the wait for the first event, measured at 2-8 seconds (the CLI
            // spends about 2 of that starting Node). Once text is flowing the
            // gaps are nothing: 0.8s at the widest, 0.2-0.4s typically. So 30
            // gives the slow start four times the room it has ever needed, and
            // still gives up on a stall in half a minute rather than two.
            timeout_secs: 30,
            // On, unlike the clipboard gesture above. The two are not the same
            // kind of ask: that one reads what the user copied and sends it to
            // Anthropic, this one asks a public endpoint what the newest tag
            // is and sends nothing of the user's at all. Defaulting it off
            // would mostly mean nobody hears about the release that fixes the
            // bug they are hitting.
            check_for_updates: true,
        }
    }
}

impl Settings {
    /// Clamp anything the frontend could have sent out of range.
    pub fn normalized(mut self) -> Self {
        self.claude_bin = self.claude_bin.trim().to_owned();
        if self.claude_bin.is_empty() {
            self.claude_bin = "claude".into();
        }
        self.model = self.model.trim().to_owned();
        if self.model.is_empty() {
            self.model = DEFAULT_MODEL.into();
        }
        self.timeout_secs = self.timeout_secs.clamp(5, 600);
        self.double_copy_window_ms = self.double_copy_window_ms.clamp(
            crate::clipboard_watch::MIN_WINDOW_MS,
            crate::clipboard_watch::MAX_WINDOW_MS,
        );
        // Same predicate the frontend asks about and the status pane reports,
        // so an unsupported platform cannot end up with the box ticked.
        if !crate::clipboard_watch::is_detectable() {
            self.double_copy_enabled = false;
        }
        self
    }

    /// Force the gesture off until the user has agreed to what it does.
    ///
    /// Applied on the way in *and* on the way out — loading a `settings.json`
    /// and saving one both pass through here — so the flag can only ever be
    /// true alongside the consent marker, whether it got there through the
    /// checkbox, a file copied from another machine, or a hand edit.
    ///
    /// It only ever clears the flag. Consent is permission to enable, not an
    /// instruction to: a user who agreed once and later switched the gesture
    /// off stays off.
    pub fn gated(mut self, consented: bool) -> Self {
        if !consented {
            self.double_copy_enabled = false;
        }
        self
    }
}

pub fn consent_granted(app: &AppHandle) -> bool {
    marker_seen(app, CLIPBOARD_CONSENT)
}

pub fn grant_consent(app: &AppHandle) {
    mark_seen(app, CLIPBOARD_CONSENT);
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let consented = consent_granted(app);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
        .gated(consented)
}

/// A one-shot "this already happened" marker, kept beside `settings.json` as an
/// empty file.
///
/// Deliberately not a [`Settings`] field. The frontend rebuilds that struct
/// field by field every time it saves, so a field it does not know about is
/// reset to its default on the next save — and the whole point of a marker is
/// that it survives.
fn marker_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(settings_path(app)?.with_file_name(name))
}

pub fn marker_seen(app: &AppHandle, name: &str) -> bool {
    marker_path(app, name).is_ok_and(|path| path.exists())
}

/// Best-effort: a marker that cannot be written costs one repeated prompt, so
/// there is nothing here worth failing the caller over.
pub fn mark_seen(app: &AppHandle, name: &str) {
    let Ok(path) = marker_path(app, name) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, b"");
}

pub fn store(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("設定ディレクトリを作成できません: {e}"))?;
    }
    let raw =
        serde_json::to_string_pretty(settings).map_err(|e| format!("設定を書き出せません: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("設定を保存できません: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_fields_fall_back_to_defaults() {
        let settings = Settings {
            claude_bin: "   ".into(),
            model: "".into(),
            ..Settings::default()
        }
        .normalized();

        assert_eq!(settings.claude_bin, "claude");
        assert_eq!(settings.model, DEFAULT_MODEL);
    }

    #[test]
    fn timeout_is_clamped() {
        let low = Settings {
            timeout_secs: 0,
            ..Settings::default()
        }
        .normalized();
        let high = Settings {
            timeout_secs: 99_999,
            ..Settings::default()
        }
        .normalized();
        assert_eq!(low.timeout_secs, 5);
        assert_eq!(high.timeout_secs, 600);
    }

    /// Settings files written before a field existed must still load.
    #[test]
    fn partial_json_uses_defaults_for_missing_fields() {
        let settings: Settings = serde_json::from_str(r#"{"model":"haiku"}"#).unwrap();
        assert_eq!(settings.model, "haiku");
        assert_eq!(settings.target_lang, "Japanese");
        assert_eq!(settings.timeout_secs, 30);
    }

    /// Nothing watches the clipboard on a machine where the app has only ever
    /// been installed — that is the whole of the opt-in.
    #[test]
    fn a_fresh_install_does_not_watch_the_clipboard() {
        let settings = Settings::default();
        assert!(!settings.double_copy_enabled);
        assert!(!settings.clipboard_auto_translate);
    }

    /// Including when the file on disk says otherwise: a `settings.json` from
    /// before the gesture became opt-in, or copied from another machine, still
    /// has to clear consent on *this* one.
    #[test]
    fn consent_is_required_before_the_gesture_runs() {
        let stored: Settings = serde_json::from_str(r#"{"double_copy_enabled":true}"#).unwrap();
        assert!(stored.double_copy_enabled);

        assert!(!stored.clone().gated(false).double_copy_enabled);
        assert!(stored.gated(true).double_copy_enabled);
    }

    /// Consent says the user *may* turn it on, not that it is on. Otherwise
    /// switching the gesture back off would not stick.
    #[test]
    fn consent_alone_does_not_enable_the_gesture() {
        let settings = Settings {
            double_copy_enabled: false,
            ..Settings::default()
        }
        .gated(true);

        assert!(!settings.double_copy_enabled);
    }

    /// A `settings.json` written before the field existed has to come back as
    /// "yes, tell me about releases". That rests on the container's
    /// `#[serde(default)]` filling missing fields from [`Settings::default`]
    /// rather than from the field type — `bool`'s own default would switch the
    /// notice off for every install that predates it.
    #[test]
    fn update_notices_survive_an_older_settings_file() {
        let settings: Settings = serde_json::from_str(r#"{"model":"haiku"}"#).unwrap();
        assert!(settings.check_for_updates);
        assert!(Settings::default().check_for_updates);
    }

    /// And an explicit no stays no.
    #[test]
    fn update_notices_can_be_switched_off() {
        let settings: Settings = serde_json::from_str(r#"{"check_for_updates":false}"#).unwrap();
        assert!(!settings.check_for_updates);
        assert!(!settings.normalized().check_for_updates);
    }

    /// And files written *before* the global shortcut was dropped must load
    /// too, keeping the settings that are still meaningful.
    #[test]
    fn retired_fields_are_ignored() {
        let settings: Settings = serde_json::from_str(
            r#"{"shortcut":"CmdOrCtrl+Shift+T","shortcut_enabled":true,
                "auto_translate_clipboard":false,"tone":"technical"}"#,
        )
        .unwrap();
        assert_eq!(settings.tone, "technical");
        assert_eq!(settings.model, DEFAULT_MODEL);
    }
}
