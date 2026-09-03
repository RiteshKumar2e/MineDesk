use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Holds the handle to the bundled `minedesk-agent` sidecar so it can be
/// killed cleanly on Quit, rather than left as an orphaned background
/// process after the GUI exits - std::process::Child (and this wrapper
/// around it) does not kill its child on drop, so an explicit kill is the
/// only way to guarantee it stops with the app.
struct AgentProcess(Mutex<Option<CommandChild>>);

/// Mirrors the fields `backend/agent/src/config.rs` writes to
/// `%ProgramData%\MineDesk\agent.toml` after self-registration - read-only
/// here, and `agent_secret` is deliberately not surfaced to the frontend,
/// since it is a bearer credential and the webview has no need for it.
#[derive(serde::Deserialize)]
struct AgentConfigFile {
    device_id: String,
}

#[derive(serde::Serialize)]
struct DeviceIdentity {
    device_id: Option<String>,
}

fn agent_config_path() -> std::path::PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    std::path::PathBuf::from(base).join("MineDesk").join("agent.toml")
}

/// Real, persisted user preference - not a UI-only toggle. Stored next to
/// agent.toml so it survives updates the same way the device identity does.
/// Default (missing file) is `true`: matches the tray-resident behavior
/// this app has always had, so upgrading from an older version that had no
/// such setting doesn't silently change what closing the window does.
#[derive(serde::Serialize, serde::Deserialize)]
struct AppSettings {
    #[serde(default = "default_true")]
    minimize_to_tray: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { minimize_to_tray: true }
    }
}

fn settings_path() -> std::path::PathBuf {
    agent_config_path().with_file_name("desktop-settings.json")
}

fn load_settings() -> AppSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_minimize_to_tray() -> bool {
    load_settings().minimize_to_tray
}

#[tauri::command]
fn set_minimize_to_tray(enabled: bool) -> Result<(), String> {
    let settings = AppSettings { minimize_to_tray: enabled };
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(), json).map_err(|e| e.to_string())
}

/// Lets the frontend write directly to a file we can inspect, for the cases
/// (like this one) where the production build has no devtools console to
/// read the browser-side error from. Not wired to anything sensitive - just
/// a plain text append.
#[tauri::command]
fn debug_log(message: String) {
    if let Some(dir) = agent_config_path().parent() {
        let path = dir.join("frontend-debug.log");
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(file, "{message}");
        }
    }
}

/// Polled by the frontend after launch: the sidecar self-registers
/// asynchronously (it has to reach the API first), so the config file may
/// not exist yet on the very first call - the frontend retries rather than
/// this blocking, so a slow/offline network doesn't hang the UI thread.
#[tauri::command]
fn get_device_identity() -> DeviceIdentity {
    let device_id = std::fs::read_to_string(agent_config_path())
        .ok()
        .and_then(|raw| toml::from_str::<AgentConfigFile>(&raw).ok())
        .map(|cfg| cfg.device_id);
    DeviceIdentity { device_id }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn kill_agent(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AgentProcess>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if enabled { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(AgentProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_device_identity,
            is_autostart_enabled,
            set_autostart_enabled,
            get_minimize_to_tray,
            set_minimize_to_tray,
            debug_log
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // The bundled agent is what actually makes this machine
            // reachable (screen capture, input injection, WebRTC) - the
            // window above is just the dashboard. Starting it here means a
            // single install does both, the way a real installed AnyDesk
            // client does, instead of needing a second "download the agent"
            // step. No visible console window: the sidecar is a console
            // subsystem binary (see backend/agent/README.md), but
            // tauri-plugin-shell spawns Windows children with
            // CREATE_NO_WINDOW, so nothing flashes on screen.
            match app.shell().sidecar("minedesk-agent") {
                Ok(sidecar) => match sidecar.spawn() {
                    Ok((mut events, child)) => {
                        *app.state::<AgentProcess>().0.lock().unwrap() = Some(child);
                        // The sidecar has no console (CREATE_NO_WINDOW), so
                        // its stdout/stderr - the only way to see what the
                        // capture/WebRTC/input code is actually doing - goes
                        // nowhere unless something reads this event stream.
                        // Written next to agent.toml so it's easy to find
                        // alongside the identity it belongs to.
                        let log_path = agent_config_path().with_file_name("agent-sidecar.log");
                        tauri::async_runtime::spawn(async move {
                            let mut file = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&log_path)
                                .ok();
                            while let Some(event) = events.recv().await {
                                let line = match event {
                                    CommandEvent::Stdout(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                                    CommandEvent::Stderr(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                                    CommandEvent::Error(err) => Some(format!("[sidecar error] {err}")),
                                    CommandEvent::Terminated(payload) => Some(format!("[sidecar exited] {payload:?}")),
                                    _ => None,
                                };
                                if let (Some(line), Some(file)) = (line, file.as_mut()) {
                                    use std::io::Write;
                                    let _ = writeln!(file, "{}", line.trim_end());
                                }
                            }
                        });
                    }
                    Err(err) => log::error!("failed to start minedesk-agent sidecar: {err}"),
                },
                Err(err) => log::error!("minedesk-agent sidecar not found: {err}"),
            }

            let open_item = MenuItem::with_id(app, "open", "Open MineDesk", true, None::<&str>)?;
            let new_session_item = MenuItem::with_id(app, "new_session", "New Session", true, None::<&str>)?;
            let my_address_item = MenuItem::with_id(app, "my_address", "My Address", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit MineDesk", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;

            let tray_menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &separator,
                    &new_session_item,
                    &my_address_item,
                    &settings_item,
                    &separator,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("MineDesk")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "new_session" => {
                        show_main_window(app);
                        let _ = app.emit("tray:new-session", ());
                    }
                    "my_address" => {
                        show_main_window(app);
                        let _ = app.emit("tray:my-address", ());
                    }
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit("tray:settings", ());
                    }
                    "quit" => {
                        kill_agent(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // The whole point of a remote-desktop client is that the
            // machine stays reachable after you close the dashboard - so by
            // default the window's X button hides it rather than exiting
            // the app, exactly like AnyDesk/TeamViewer's tray-resident
            // behavior. This is now a real, persisted preference (Settings
            // panel) rather than the only option: someone who never wants
            // background access can turn it off and have X actually quit,
            // stopping the agent with it.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if load_settings().minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        kill_agent(window.app_handle());
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
