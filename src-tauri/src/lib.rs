mod clipboard_watch;
mod engine;
mod key_watch;
mod models;
mod plamo;
mod settings;
mod update;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clipboard_watch::Watcher;
use settings::Settings;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

struct AppState {
    settings: Mutex<Settings>,
    watcher: Arc<Watcher>,
    engine: Arc<engine::Engine>,
    downloads: Arc<models::Downloads>,
    /// Only ever talks to Hugging Face, to fetch a model.
    http: reqwest::Client,
}

/// Where the model files live. Unlike the settings this is not split between
/// debug and release builds: the files are gigabytes, identical for both, and
/// downloading each one twice to keep two builds apart would buy nothing.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models"))
        .map_err(|e| format!("モデルの保存先を決められません: {e}"))
}

/// The selected model's file, when it is on disk.
fn installed_model(app: &AppHandle, size: &str) -> Result<Option<PathBuf>, String> {
    let model = models::find(size).ok_or_else(|| format!("知らないモデルです: {size}"))?;
    let path = model.path(&models_dir(app)?);
    Ok(path.is_file().then_some(path))
}

/// Reads the selected model in on a thread of its own, so the first
/// translation does not pay for it. Best-effort: a model that will not load
/// says so again, properly, when a translation asks for it.
fn preload(app: &AppHandle, engine: &Arc<engine::Engine>, size: &str) {
    let Ok(Some(path)) = installed_model(app, size) else {
        return;
    };
    let engine = engine.clone();
    std::thread::spawn(move || {
        if let Err(err) = engine.preload(&path) {
            eprintln!("konjac: {err}");
        }
    });
}

fn read_settings(state: &State<AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "設定の読み込みに失敗しました".to_string())
}

/// Which detector recognized the gesture. The frontend needs to know, because
/// only one of them is proof that a person pressed a key: the keyboard monitor
/// sees ⌘C itself, while the clipboard counter sees *a* write and cannot say
/// whose. What follows a write it cannot attribute is filling the input box,
/// not a translation — see [`Settings::clipboard_auto_translate`].
const TRIGGER_KEYBOARD: &str = "keyboard";
const TRIGGER_CLIPBOARD: &str = "clipboard";

/// Payload for the frontend when the ⌘C ⌘C gesture fires.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TriggerPayload {
    text: Option<String>,
    source: &'static str,
}

/// Brings the window back regardless of how it went away. `show` alone is not
/// enough for a minimized window: it is still "visible" as far as the platform
/// is concerned, so it would stay parked in the taskbar/Dock.
fn raise(window: &tauri::WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Touching the platform UI toolkit must happen on the main thread on macOS,
/// and the tray menu handler runs on another one.
#[cfg(desktop)]
fn show_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            raise(&window);
        }
    });
}

/// Shows the window and hands the clipboard to the frontend to translate.
/// Only the ⌘C ⌘C detectors do this: pressing copy twice is an explicit ask,
/// so it must not clobber the input box on a plain "open the window".
///
/// This is the one place in the app that reads what is on the clipboard without
/// the user asking in so many words, so the condition is checked here rather
/// than inferred from the caller: the detectors already refuse to fire while the
/// feature is off, and the feature cannot be on without consent, but a read that
/// slipped through either of those would be the exact failure this guards.
fn present_clipboard(app: &AppHandle, source: &'static str) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };

        let enabled = handle
            .try_state::<AppState>()
            .is_some_and(|state| state.watcher.is_enabled());
        let text = if enabled {
            handle.clipboard().read_text().ok()
        } else {
            None
        };

        raise(&window);
        let _ = handle.emit("trigger-activated", TriggerPayload { text, source });
    });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    read_settings(&state)
}

#[tauri::command]
fn platform_supports_double_copy() -> bool {
    clipboard_watch::is_detectable()
}

#[tauri::command]
fn clipboard_status(state: State<AppState>) -> clipboard_watch::WatchStatus {
    state.watcher.status()
}

/// Whether the user has agreed to the clipboard being read. Asked at
/// boot so the settings pane knows whether ticking the box needs the disclosure
/// put in front of the user first.
#[tauri::command]
fn clipboard_consent(app: AppHandle) -> bool {
    settings::consent_granted(&app)
}

/// Records that the disclosure was shown and accepted. Enabling the gesture is
/// a separate step — this only lifts the gate, it does not turn anything on.
#[tauri::command]
fn grant_clipboard_consent(app: AppHandle) {
    settings::grant_consent(&app);
}

/// The marker recording that the first-launch question about the gesture has
/// been put to the user. Separate from the consent marker because declining is
/// an answer too, and a decline that left no trace would ask again every launch.
const FIRST_RUN_ASKED: &str = "first-run-asked";

/// Whether the first-launch question has already been answered. An install that
/// predates this pane but has consented has been asked in the older way, so the
/// frontend treats that as answered as well.
#[tauri::command]
fn first_run_answered(app: AppHandle) -> bool {
    settings::marker_seen(&app, FIRST_RUN_ASKED)
}

#[tauri::command]
fn mark_first_run_answered(app: AppHandle) {
    settings::mark_seen(&app, FIRST_RUN_ASKED);
}

/// Opens the OS pane where the user grants keyboard-observation access.
///
/// Asks first, because the pane on its own is not enough: an app appears in the
/// Accessibility list only once it has requested the permission, so a user sent
/// there beforehand finds no row to switch on. Asking is idempotent — macOS
/// keeps the row afterwards whichever way it was answered.
#[tauri::command]
fn open_accessibility_settings(app: AppHandle) {
    // The alert is UI, so it belongs on the main thread; commands need not be.
    let _ = app.run_on_main_thread(|| {
        key_watch::request_trust();
        key_watch::open_privacy_settings();
    });
}

/// Permission can be granted while the app is running, so re-attempt the
/// keyboard monitor on demand rather than only at startup.
#[tauri::command]
fn recheck_accessibility(
    app: AppHandle,
    state: State<AppState>,
) -> Result<clipboard_watch::WatchStatus, String> {
    install_key_watch(&app, &state.watcher);
    Ok(state.watcher.status())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    // The frontend asks for consent before it ever sends `double_copy_enabled:
    // true`, but it is the frontend — the flag is only trustworthy once it has
    // been through the same gate the loader applies.
    let next = settings.normalized().gated(settings::consent_granted(&app));
    let previous_size = read_settings(&state)?.model_size;

    settings::store(&app, &next)?;

    if next.model_size != previous_size {
        preload(&app, &state.engine, &next.model_size);
    }

    state
        .watcher
        .configure(next.double_copy_enabled, next.double_copy_window_ms);

    // Permission may have been granted since startup, and turning the gesture
    // on is the moment the user cares whether the better detector is running.
    if next.double_copy_enabled {
        // Covers the user who left the gesture off at first launch: that is
        // when the startup ask is skipped, so this is their first one.
        request_accessibility_once(&app, &next);
        install_key_watch(&app, &state.watcher);
    }

    *state
        .settings
        .lock()
        .map_err(|_| "設定の更新に失敗しました".to_string())? = next.clone();

    Ok(next)
}

/// A fragment of a translation in progress. `id` is the frontend's own counter
/// for the run it is waiting on, echoed back so a late chunk from an abandoned
/// run cannot land in the box.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    id: u32,
    text: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslateResult {
    text: String,
    /// The model size that answered, e.g. `2b`.
    model: String,
    /// The language codes actually used. Can differ from what was asked: with
    /// the source on auto, Japanese text into Japanese goes to English.
    source: Option<String>,
    target: String,
    elapsed_ms: u128,
}

#[tauri::command]
async fn translate(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    source_lang: String,
    target_lang: String,
    tone: String,
    stream_id: u32,
) -> Result<TranslateResult, String> {
    let current = read_settings(&state)?;
    let started = Instant::now();

    let path = installed_model(&app, &current.model_size)?.ok_or_else(|| {
        format!(
            "モデル {} がまだダウンロードされていません。設定画面からダウンロードしてください。",
            current.model_size
        )
    })?;
    let direction = plamo::direction(&source_lang, &target_lang, &text)?;
    let form = plamo::form(&tone, direction.target);
    let source = direction.source.map(str::to_owned);
    let target = direction.target.to_owned();

    let engine = state.engine.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let request = engine::Request {
            text: &text,
            direction,
            form,
        };
        engine.translate(&path, &request, |chunk| {
            let _ = app.emit(
                "translate-delta",
                DeltaPayload {
                    id: stream_id,
                    text: chunk.to_owned(),
                },
            );
        })
    })
    .await
    .map_err(|e| format!("翻訳が異常終了しました: {e}"))??;

    Ok(TranslateResult {
        text: output,
        model: current.model_size,
        source,
        target,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Every model, whether it is on disk, and which one is downloading now.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelsReport {
    models: Vec<models::ModelStatus>,
    downloading: Option<&'static str>,
    dir: String,
}

#[tauri::command]
fn model_statuses(app: AppHandle, state: State<AppState>) -> Result<ModelsReport, String> {
    let dir = models_dir(&app)?;
    Ok(ModelsReport {
        models: models::statuses(&dir),
        downloading: state.downloads.active(),
        dir: dir.display().to_string(),
    })
}

/// Fetches a model, reporting progress as `model-download` events. Resolves
/// once the file is verified and in place.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    size: String,
) -> Result<(), String> {
    let model = models::find(&size).ok_or_else(|| format!("知らないモデルです: {size}"))?;
    let dir = models_dir(&app)?;
    let emitter = app.clone();
    models::download(&state.downloads, &state.http, &dir, model, move |progress| {
        let _ = emitter.emit("model-download", progress);
    })
    .await?;

    // The usual reason to download one is to use it straight away.
    if read_settings(&state)?.model_size == size {
        preload(&app, &state.engine, &size);
    }
    Ok(())
}

#[tauri::command]
fn cancel_download(state: State<AppState>) {
    state.downloads.cancel();
}

#[tauri::command]
fn delete_model(app: AppHandle, state: State<AppState>, size: String) -> Result<(), String> {
    let model = models::find(&size).ok_or_else(|| format!("知らないモデルです: {size}"))?;
    if state.downloads.active() == Some(model.size) {
        return Err("ダウンロード中のモデルは削除できません。先に中止してください。".into());
    }
    let dir = models_dir(&app)?;
    // Let go of it first. The file is memory-mapped while loaded, and Windows
    // refuses to delete a file that is.
    state.engine.unload(&model.path(&dir));
    models::delete(&dir, model)
}

/// Hands a URL to whatever the platform opens links with.
///
/// Private, and every caller passes either a constant or a string that has been
/// through [`update::is_advisory_url`] — the frontend never reaches this with a
/// URL of its own choosing.
fn open_external(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        // `start` is a shell builtin, not a program, and the empty string is the
        // window title `start` would otherwise take the URL for. Going through
        // `cmd` is also why an advisory's URL is checked for shell syntax
        // before it gets here.
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    let _ = command.spawn();
}

/// Opens the model licence in the default browser. Takes no argument on
/// purpose: the URL is a constant, so the frontend cannot aim this anywhere.
#[tauri::command]
fn open_model_license() {
    open_external(models::LICENSE_URL);
}

/// What this build calls itself. Shown in the settings pane, and compared
/// against what GitHub reports — see [`check_versions`].
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Weighs this build against the newest release and the floor a published
/// advisory sets. Both come from the frontend, which did the fetching; the
/// comparison — and so the decision to stop translating — is made here.
#[tauri::command]
fn check_versions(
    app: AppHandle,
    latest: Option<String>,
    minimum: Option<String>,
) -> update::Verdict {
    update::verdict(
        &app.package_info().version.to_string(),
        latest.as_deref(),
        minimum.as_deref(),
    )
}

/// Stands the ⌘C ⌘C watcher down for the rest of this run, without touching
/// what is on disk.
///
/// Called when an advisory withdraws this build. Refusing to translate is only
/// half a stop: the watcher is what reads the clipboard in the first place, and
/// on a build people have been told to stop using it should not keep doing that
/// while they go and fetch the fixed one. Nothing is persisted, so lifting the
/// advisory gives the setting back at the next launch rather than leaving the
/// user with a box they have to re-tick.
#[tauri::command]
fn halt_watching(state: State<AppState>) -> Result<(), String> {
    let current = read_settings(&state)?;
    state.watcher.configure(false, current.double_copy_window_ms);
    Ok(())
}

/// Opens the page where a fixed build is downloaded. A constant, like
/// [`open_model_license`].
#[tauri::command]
fn open_releases_page() {
    open_external(update::RELEASES_PAGE_URL);
}

/// Opens the advisory behind a block. Unlike every other URL the app opens this
/// one arrived over the network, so it is refused unless it points into this
/// repository and is spelled with characters no shell reads as syntax.
#[tauri::command]
fn open_advisory(url: String) -> Result<(), String> {
    if !update::is_advisory_url(&url) {
        return Err("このリンクは開けません".into());
    }
    open_external(&url);
    Ok(())
}

/// Writes go through here rather than the JS plugin so the double-copy watcher
/// can tell this app's own writes apart from the user's copies.
#[tauri::command]
fn write_clipboard(app: AppHandle, state: State<AppState>, text: String) -> Result<(), String> {
    state.watcher.note_self_write();
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("クリップボードに書き込めません: {e}"))
}

// ------------------------------------------------------------------ detectors

/// How often to look for the permission having been granted. It is granted in
/// System Settings — outside this app, with no notification when it lands — so
/// looking is the only way to notice. `AXIsProcessTrusted` is a cheap local
/// lookup, and the thread that calls it stops for good once the monitor is up.
const TRUST_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The marker that keeps the first-launch permission alert to one appearance.
const ACCESSIBILITY_ASKED: &str = "accessibility-asked";

/// Installs the keyboard monitor if macOS has granted permission and it is not
/// already running. Safe to call repeatedly.
fn install_key_watch(app: &AppHandle, watcher: &Arc<Watcher>) {
    if !key_watch::is_available() || watcher.uses_keyboard() || !key_watch::is_trusted() {
        return;
    }

    let handle = app.clone();
    let watcher = watcher.clone();

    // The monitor attaches to the main thread's run loop.
    let _ = app.run_on_main_thread(move || {
        if watcher.uses_keyboard() {
            return;
        }

        let fire_handle = handle.clone();
        let fire_watcher = watcher.clone();
        let installed = key_watch::install(move || {
            if fire_watcher.note_copy() {
                present_clipboard(&fire_handle, TRIGGER_KEYBOARD);
            }
        });

        if installed {
            watcher.mark_keyboard_active();
            // The permission can land while a "grant this" prompt is on screen,
            // and the frontend has no other way to hear that it did.
            let _ = handle.emit("watch-source-changed", ());
        }
    });
}

/// Watches for the permission being granted while the app runs, and promotes
/// the detector the moment it is.
///
/// Without this the user grants the permission, comes back, and nothing has
/// changed until they find a button to press — which reads as the permission
/// not having worked.
fn spawn_trust_poll(app: &AppHandle, watcher: &Arc<Watcher>) {
    if !key_watch::is_available() || watcher.uses_keyboard() {
        return;
    }

    let app = app.clone();
    let watcher = watcher.clone();

    std::thread::spawn(move || loop {
        std::thread::sleep(TRUST_POLL_INTERVAL);
        if watcher.uses_keyboard() {
            return;
        }
        if key_watch::is_trusted() {
            install_key_watch(&app, &watcher);
        }
    });
}

/// Puts up macOS's own permission alert on the first launch that could use the
/// permission, the way DeepL does.
///
/// Since the gesture is opt-in that is no longer the first launch, but the one
/// after it is switched on — which is the better moment for it anyway: an alert
/// asking to observe the keyboard makes sense next to a feature the user just
/// asked for, and none at all for one they have not.
///
/// Asked once and only once: the alert arrives unprompted, so repeating it
/// every launch would be nagging — and it has done its lasting job after one
/// appearance anyway, since that is what puts the app in the Accessibility list
/// for the user to find later.
fn request_accessibility_once(app: &AppHandle, settings: &Settings) {
    if !key_watch::is_available()
        || !settings.double_copy_enabled
        || key_watch::is_trusted()
        || settings::marker_seen(app, ACCESSIBILITY_ASKED)
    {
        return;
    }

    settings::mark_seen(app, ACCESSIBILITY_ASKED);
    // The alert is UI. Reached from `setup` (already the main thread) and from
    // saving the settings (a command, which is not), so it is dispatched either
    // way rather than left to the caller to remember.
    let _ = app.run_on_main_thread(|| {
        key_watch::request_trust();
    });
}

// ------------------------------------------------------------------ tray

/// The window has no decorations and stays out of the taskbar, so once it is
/// hidden the tray icon is the only way back to it — and the only way to quit.
#[cfg(desktop)]
fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "コンニャクを開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("コンニャク")
        .menu(&menu)
        // On macOS a menu bar item is expected to open its menu on any click.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        });

    // Baked in from `bundle.icon`; skip rather than fail if it is missing.
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

// ------------------------------------------------------------------ run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);

            let watcher = Arc::new(Watcher::new(
                loaded.double_copy_enabled,
                loaded.double_copy_window_ms,
            ));

            // Before `loaded` is handed over to the state it lives in.
            request_accessibility_once(&handle, &loaded);

            let engine = Arc::new(engine::Engine::default());
            preload(&handle, &engine, &loaded.model_size);

            let http = reqwest::Client::builder()
                .user_agent(concat!("konjac/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(15))
                // Per read, not for the whole file: a model takes minutes.
                .read_timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| format!("HTTP クライアントを作れません: {e}"))?;

            app.manage(AppState {
                settings: Mutex::new(loaded),
                watcher: watcher.clone(),
                engine,
                downloads: Arc::default(),
                http,
            });

            // Prefer the keyboard monitor where permitted: it sees ⌘C presses
            // the source app never turns into a clipboard write. The clipboard
            // poller runs as the no-permission fallback and stands itself down
            // if the monitor comes up later.
            install_key_watch(&handle, &watcher);
            // Where it is not permitted yet, keep looking, so that granting the
            // permission is the whole of what the user has to do.
            spawn_trust_poll(&handle, &watcher);

            let watch_handle = handle.clone();
            clipboard_watch::spawn(watcher, move || {
                present_clipboard(&watch_handle, TRIGGER_CLIPBOARD);
            });

            // A tray that fails to appear must not stop the app: the window is
            // already on screen and stays usable.
            #[cfg(desktop)]
            if let Err(err) = install_tray(&handle) {
                eprintln!("konjac: トレイアイコンを作れません: {err}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            translate,
            model_statuses,
            download_model,
            cancel_download,
            delete_model,
            open_model_license,
            write_clipboard,
            platform_supports_double_copy,
            clipboard_status,
            clipboard_consent,
            grant_clipboard_consent,
            first_run_answered,
            mark_first_run_answered,
            open_accessibility_settings,
            recheck_accessibility,
            app_version,
            check_versions,
            halt_watching,
            open_releases_page,
            open_advisory
        ])
        .run(tauri::generate_context!())
        .expect("error while running konjac");
}
