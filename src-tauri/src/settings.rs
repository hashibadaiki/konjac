use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The on-device engine, and the one a fresh install uses.
pub const ENGINE_PLAMO: &str = "plamo";
/// The `claude` CLI.
pub const ENGINE_CLAUDE: &str = "claude";

/// The marker recording that the user has been told what enabling the gesture
/// sends, and where, and agreed to it. See [`Settings::gated`].
pub const CLIPBOARD_CONSENT: &str = "clipboard-consent";

/// Fields dropped since earlier versions (`shortcut`, `shortcut_enabled`,
/// `auto_translate_clipboard`) are simply ignored when an old `settings.json`
/// is read: serde skips unknown keys, so nothing else has to be migrated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Which engine translates: `plamo` (on this machine) or `claude` (the
    /// `claude` CLI, which sends the text to Anthropic).
    pub engine: String,
    /// Which PLaMo 3 Translate model translates: `0.8b`, `2b`, `8b` or `31b`.
    /// See [`crate::models::MODELS`]. Kept while `engine` is `claude`, so
    /// switching back lands on the same size.
    pub model_size: String,
    /// Path to (or bare name of) the `claude` executable, for the `claude`
    /// engine.
    pub claude_bin: String,
    pub source_lang: String,
    pub target_lang: String,
    /// The register of a Japanese translation: `default`, `polite` (です・ます)
    /// or `plain` (だ・である). The model takes no register for other targets.
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
    /// an external translation service with no press of the button. The keyboard
    /// detector reads ⌘C itself and has no such blind spot, so it is not subject
    /// to this.
    pub clipboard_auto_translate: bool,
    pub auto_copy_result: bool,
    /// For the `claude` engine: how long the CLI may go without a word before
    /// the run is abandoned. Idle, not total — see `claude::run_cli_streaming`.
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
            engine: ENGINE_PLAMO.into(),
            model_size: crate::models::DEFAULT_SIZE.into(),
            claude_bin: "claude".into(),
            source_lang: "auto".into(),
            target_lang: "Japanese".into(),
            tone: "default".into(),
            // Off on a fresh install, on purpose. Watching for the gesture is
            // what makes the app read the clipboard at all, and a detector that
            // fires by mistake reads whatever is on it — a password, a token, an
            // internal document. Translation now stays on this machine, but
            // reading the clipboard unasked is still not a thing to opt a user
            // into on their behalf; enabling it is their call, made once
            // they have been told what it does (`gated`).
            double_copy_enabled: false,
            double_copy_window_ms: 600,
            clipboard_auto_translate: false,
            auto_copy_result: false,
            // Idle, not total. All it has to cover is the wait for the CLI's
            // first event, measured at 2-8 seconds; once text flows the gaps are
            // well under a second.
            timeout_secs: 30,
            // On, unlike the clipboard gesture above. The two are not the same
            // kind of ask: that one reads what the user copied, this one asks a public endpoint what the newest tag
            // is and sends nothing of the user's at all. Defaulting it off
            // would mostly mean nobody hears about the release that fixes the
            // bug they are hitting.
            check_for_updates: true,
        }
    }
}

/// Tones from before the switch to PLaMo map onto the two registers it has:
/// business writing is です・ます, casual is だ・である, and technical writing has
/// no register of its own.
fn normalized_tone(tone: &str) -> &'static str {
    match tone {
        "polite" | "formal" => "polite",
        "plain" | "casual" => "plain",
        _ => "default",
    }
}

impl Settings {
    /// Clamp anything the frontend could have sent out of range.
    pub fn normalized(mut self) -> Self {
        if crate::models::find(self.model_size.trim()).is_none() {
            self.model_size = crate::models::DEFAULT_SIZE.into();
        }
        self.model_size = self.model_size.trim().to_owned();
        if self.engine != ENGINE_CLAUDE {
            self.engine = ENGINE_PLAMO.into();
        }
        self.claude_bin = self.claude_bin.trim().to_owned();
        if self.claude_bin.is_empty() {
            self.claude_bin = "claude".into();
        }
        self.timeout_secs = self.timeout_secs.clamp(5, 600);
        self.tone = normalized_tone(&self.tone).into();
        // A language the model does not offer (Portuguese, which the Claude
        // route used to translate) falls back rather than failing every translation until changed.
        if self.source_lang != "auto" && crate::plamo::language_code(&self.source_lang).is_none() {
            self.source_lang = "auto".into();
        }
        if crate::plamo::language_code(&self.target_lang).is_none() {
            self.target_lang = "Japanese".into();
        }
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

/// Gives a debug build a directory of its own, so `npm run tauri dev` and an
/// installed release do not write over each other.
///
/// Split out from [`config_dir`] and taking the flag as an argument so the
/// naming can be tested without an `AppHandle`.
fn scoped(dir: PathBuf, dev: bool) -> PathBuf {
    if !dev {
        return dir;
    }
    // `with_extension` is not the tool for this: the identifier is spelled with
    // dots, so it would replace `konjac` rather than append to the whole name.
    match dir.file_name().and_then(|name| name.to_str()) {
        Some(name) => dir.with_file_name(format!("{name}.dev")),
        None => dir,
    }
}

/// Where `settings.json` and the one-shot markers live.
///
/// The directory is named after `identifier`, which a debug build and a release
/// build share — so without [`scoped`] they would share this, and what is kept
/// here is precisely the state that decides what a *first* launch looks like. A
/// developer's `clipboard-consent`, left over from that morning's `tauri dev`,
/// is enough to make the installed app skip the welcome pane it was meant to
/// show and put macOS's own permission alert up cold instead, with nothing on
/// screen to say what asked for it. Keeping them apart is also the only way to
/// see that flow a second time without deleting the directory by hand.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("設定ディレクトリを取得できません: {e}"))?;
    Ok(scoped(dir, cfg!(debug_assertions)))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("settings.json"))
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
    Ok(config_dir(app)?.join(name))
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

    /// A release build writes where it always has: the suffix must not reach
    /// the installs people actually run, or an update would look like a wipe.
    #[test]
    fn a_release_build_keeps_the_plain_directory() {
        let dir = PathBuf::from("/Users/x/Library/Application Support/dev.hashibadaiki.konjac");
        assert_eq!(scoped(dir.clone(), false), dir);
    }

    /// And a debug build gets its own, appended to the whole identifier rather
    /// than replacing its last dotted component.
    #[test]
    fn a_debug_build_gets_a_directory_of_its_own() {
        let dir = PathBuf::from("/Users/x/Library/Application Support/dev.hashibadaiki.konjac");
        assert_eq!(
            scoped(dir, true),
            PathBuf::from("/Users/x/Library/Application Support/dev.hashibadaiki.konjac.dev")
        );
    }

    /// Nothing sensible to append to, so the plain directory is still better
    /// than no directory: the two builds sharing it is the old behaviour, and
    /// failing to find one at all would lose the settings outright.
    #[test]
    fn a_nameless_directory_is_left_alone() {
        assert_eq!(scoped(PathBuf::from("/"), true), PathBuf::from("/"));
    }

    #[test]
    fn unknown_fields_fall_back_to_defaults() {
        let settings = Settings {
            model_size: "70b".into(),
            target_lang: "Klingon".into(),
            source_lang: "Klingon".into(),
            ..Settings::default()
        }
        .normalized();

        assert_eq!(settings.model_size, crate::models::DEFAULT_SIZE);
        assert_eq!(settings.target_lang, "Japanese");
        assert_eq!(settings.source_lang, "auto");
    }

    /// Settings files written before a field existed must still load.
    #[test]
    fn partial_json_uses_defaults_for_missing_fields() {
        let settings: Settings = serde_json::from_str(r#"{"tone":"plain"}"#).unwrap();
        assert_eq!(settings.tone, "plain");
        assert_eq!(settings.target_lang, "Japanese");
        assert_eq!(settings.model_size, crate::models::DEFAULT_SIZE);
    }

    /// A `settings.json` from the Claude/Google era loads: the fields that went
    /// away are ignored, its tone lands on the nearest register, and a language
    /// the model lacks falls back instead of failing every translation.
    #[test]
    fn a_settings_file_from_before_plamo_loads() {
        let settings: Settings = serde_json::from_str(
            r#"{"google_translate_enabled":true,"claude_bin":"claude","model":"sonnet",
                "timeout_secs":30,"tone":"formal","target_lang":"Portuguese",
                "auto_copy_result":true}"#,
        )
        .unwrap();
        let settings = settings.normalized();
        assert_eq!(settings.model_size, crate::models::DEFAULT_SIZE);
        assert_eq!(settings.engine, ENGINE_PLAMO);
        assert_eq!(settings.tone, "polite");
        assert_eq!(settings.target_lang, "Japanese");
        assert!(settings.auto_copy_result);
    }

    #[test]
    fn engine_and_cli_fields_are_normalized() {
        let settings = Settings {
            engine: "gpt".into(),
            claude_bin: "  ".into(),
            timeout_secs: 0,
            ..Settings::default()
        }
        .normalized();
        assert_eq!(settings.engine, ENGINE_PLAMO);
        assert_eq!(settings.claude_bin, "claude");
        assert_eq!(settings.timeout_secs, 5);

        let claude = Settings {
            engine: ENGINE_CLAUDE.into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(claude.engine, ENGINE_CLAUDE);
    }

    /// A fresh install translates on the machine; Claude is something to opt into.
    #[test]
    fn a_fresh_install_uses_the_on_device_engine() {
        assert_eq!(Settings::default().engine, ENGINE_PLAMO);
    }

    #[test]
    fn old_tones_map_onto_the_two_registers() {
        for (old, new) in [
            ("formal", "polite"),
            ("casual", "plain"),
            ("technical", "default"),
            ("default", "default"),
            ("polite", "polite"),
            ("plain", "plain"),
            ("nonsense", "default"),
        ] {
            let settings = Settings {
                tone: old.into(),
                ..Settings::default()
            }
            .normalized();
            assert_eq!(settings.tone, new, "{old}");
        }
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
        let settings: Settings = serde_json::from_str(r#"{"tone":"plain"}"#).unwrap();
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
                "auto_translate_clipboard":false,"tone":"plain"}"#,
        )
        .unwrap();
        assert_eq!(settings.tone, "plain");
        assert_eq!(settings.model_size, crate::models::DEFAULT_SIZE);
    }
}
