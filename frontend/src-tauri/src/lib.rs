use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

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
            set_autostart_enabled
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
                    Ok((_events, child)) => {
                        *app.state::<AgentProcess>().0.lock().unwrap() = Some(child);
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
            // machine stays reachable after you close the dashboard - so
            // the window's X button hides it rather than exiting the app,
            // exactly like AnyDesk/TeamViewer's tray-resident behavior. The
            // agent (and this process) only actually stop via the tray's
            // "Quit MineDesk", handled in the tray menu below.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
