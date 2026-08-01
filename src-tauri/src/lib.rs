mod clipboard_watch;
mod key_watch;
mod settings;
mod translate;

use std::sync::{Arc, Mutex};

use clipboard_watch::Watcher;
use settings::Settings;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use translate::TranslateResult;

struct AppState {
    settings: Mutex<Settings>,
    watcher: Arc<Watcher>,
}

fn read_settings(state: &State<AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "設定の読み込みに失敗しました".to_string())
}

/// Payload for the frontend when the ⌘C ⌘C gesture fires.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TriggerPayload {
    text: Option<String>,
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
fn present_clipboard(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };

        let text = handle.clipboard().read_text().ok();
        raise(&window);
        let _ = handle.emit("trigger-activated", TriggerPayload { text });
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

/// Opens the OS pane where the user grants keyboard-observation access.
#[tauri::command]
fn open_accessibility_settings() {
    key_watch::open_privacy_settings();
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
    let next = settings.normalized();

    settings::store(&app, &next)?;

    state
        .watcher
        .configure(next.double_copy_enabled, next.double_copy_window_ms);

    // Permission may have been granted since startup, and turning the gesture
    // on is the moment the user cares whether the better detector is running.
    if next.double_copy_enabled {
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
    translate::translate(
        &current,
        &text,
        &source_lang,
        &target_lang,
        &tone,
        move |chunk| {
            let _ = app.emit(
                "translate-delta",
                DeltaPayload {
                    id: stream_id,
                    text: chunk.to_owned(),
                },
            );
        },
    )
    .await
}

#[tauri::command]
async fn check_cli(settings: Settings) -> Result<translate::CliStatus, String> {
    translate::check_cli(&settings.normalized()).await
}

/// Opens the Claude Code install page in the default browser. Takes no argument
/// on purpose: the URL is a constant, so the frontend cannot aim this anywhere.
#[tauri::command]
fn open_setup_docs() {
    let url = translate::SETUP_DOCS_URL;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        // `start` is a shell builtin, not a program, and the empty string is the
        // window title `start` would otherwise take the URL for.
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
                present_clipboard(&fire_handle);
            }
        });

        if installed {
            watcher.mark_keyboard_active();
        }
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

            app.manage(AppState {
                settings: Mutex::new(loaded),
                watcher: watcher.clone(),
            });

            // Prefer the keyboard monitor where permitted: it sees ⌘C presses
            // the source app never turns into a clipboard write. The clipboard
            // poller runs as the no-permission fallback and stands itself down
            // if the monitor comes up later.
            install_key_watch(&handle, &watcher);

            let watch_handle = handle.clone();
            clipboard_watch::spawn(watcher, move || {
                present_clipboard(&watch_handle);
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
            check_cli,
            write_clipboard,
            platform_supports_double_copy,
            clipboard_status,
            open_accessibility_settings,
            recheck_accessibility,
            open_setup_docs
        ])
        .run(tauri::generate_context!())
        .expect("error while running konjac");
}
