mod process;

use process::OwnedProcess;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, WebviewWindow, WebviewWindowBuilder,
};
use url::Url;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Serialize)]
struct DesktopStatus {
    state: &'static str,
    message: String,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum LauncherStatus {
    Ready { url: String },
    Error { message: String },
}

struct RuntimeSession {
    generation: u64,
    process: Option<OwnedProcess>,
    status_file: Option<PathBuf>,
    ready_url: Option<Url>,
    status: DesktopStatus,
}

struct DesktopRuntime {
    data_dir: PathBuf,
    resource_dir: PathBuf,
    session: Mutex<RuntimeSession>,
}

fn is_bundled_page(url: &Url) -> bool {
    let local_origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    local_origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

fn validate_ready_url(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "Invalid desktop service URL")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
    {
        return Err("Desktop service must use the local loopback interface");
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 1 || pairs[0].0 != "token" || pairs[0].1.is_empty() {
        return Err("Desktop service did not provide its authentication token");
    }
    Ok(url)
}

fn ensure_bundled_caller(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !is_bundled_page(&window.url().map_err(|e| e.to_string())?) {
        return Err("This operation is only available on the desktop startup page".into());
    }
    Ok(())
}

#[tauri::command]
fn desktop_status(
    window: WebviewWindow,
    runtime: tauri::State<DesktopRuntime>,
) -> Result<DesktopStatus, String> {
    ensure_bundled_caller(&window)?;
    Ok(runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone())
}

#[tauri::command]
fn desktop_retry(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    ensure_bundled_caller(&window)?;
    start_runtime(&app);
    Ok(())
}

#[tauri::command]
fn desktop_open_data(
    window: WebviewWindow,
    runtime: tauri::State<DesktopRuntime>,
) -> Result<(), String> {
    ensure_bundled_caller(&window)?;
    open_folder(&runtime.data_dir)
}

#[tauri::command]
fn desktop_open_logs(
    window: WebviewWindow,
    runtime: tauri::State<DesktopRuntime>,
) -> Result<(), String> {
    ensure_bundled_caller(&window)?;
    open_folder(&runtime.data_dir.join("logs"))
}

fn open_folder(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Opening desktop data folders is currently supported on Windows only".into())
}

fn is_external_http_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            !host.is_empty() && host != "localhost" && !host.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(address)) => !address.is_loopback() && !address.is_unspecified(),
        Some(url::Host::Ipv6(address)) => {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address
                    .to_ipv4()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
        None => false,
    }
}

fn open_external_url(url: &Url) -> Result<(), String> {
    if !is_external_http_url(url) {
        return Err("Only external HTTP and HTTPS links can open in the browser".into());
    }
    #[cfg(windows)]
    {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let address: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                null_mut(),
                verb.as_ptr(),
                address.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("The default browser could not open this link".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Opening external links is currently supported on Windows only".into())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn stop_session(session: &mut RuntimeSession) {
    session.process.take();
    if let Some(path) = session.status_file.take() {
        let _ = fs::remove_file(path);
    }
    session.ready_url = None;
}

fn navigate_startup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        let local = "http://tauri.localhost/index.html";
        #[cfg(not(windows))]
        let local = "tauri://localhost/index.html";
        let _ = window.navigate(Url::parse(local).expect("valid bundled URL"));
    }
}

fn set_failure(app: &AppHandle, generation: u64, message: String) {
    let runtime = app.state::<DesktopRuntime>();
    if let Ok(mut session) = runtime.session.lock() {
        if session.generation != generation {
            return;
        }
        stop_session(&mut session);
        session.status = DesktopStatus {
            state: "error",
            message,
        };
    }
    navigate_startup(app);
}

fn start_runtime(app: &AppHandle) {
    let runtime = app.state::<DesktopRuntime>();
    let generation;
    let status_file;
    {
        let Ok(mut session) = runtime.session.lock() else {
            return;
        };
        stop_session(&mut session);
        session.generation += 1;
        generation = session.generation;
        session.status = DesktopStatus {
            state: "starting",
            message: String::new(),
        };
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        status_file = runtime.data_dir.join(format!(
            "runtime-status-{}-{timestamp}-{generation}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&status_file);
        let runtime_dir = runtime.resource_dir.join("runtime");
        match OwnedProcess::spawn(
            &runtime_dir.join("node.exe"),
            &runtime_dir.join("launcher.mjs"),
            &runtime.data_dir,
            &status_file,
        ) {
            Ok(process) => {
                session.process = Some(process);
                session.status_file = Some(status_file.clone());
            }
            Err(error) => {
                session.status = DesktopStatus {
                    state: "error",
                    message: format!("Unable to start the bundled runtime: {error}"),
                };
                drop(session);
                navigate_startup(app);
                return;
            }
        }
    }
    let handle = app.clone();
    thread::spawn(move || monitor_runtime(handle, generation, status_file));
}

fn monitor_runtime(app: AppHandle, generation: u64, status_file: PathBuf) {
    let started = Instant::now();
    let mut ready = false;
    loop {
        thread::sleep(Duration::from_millis(300));
        let exit = {
            let runtime = app.state::<DesktopRuntime>();
            let Ok(session) = runtime.session.lock() else {
                return;
            };
            if session.generation != generation || session.process.is_none() {
                return;
            }
            session.process.as_ref().unwrap().exit_code()
        };
        match exit {
            Ok(Some(code)) => {
                let message = if ready {
                    format!("The local service stopped (exit code {code}). Your saved work remains in the data folder.")
                } else {
                    // Prefer the launcher's actionable startup error if it exited after reporting it.
                    read_launcher_status(&status_file).and_then(|status| match status {
                        LauncherStatus::Error { message } => Some(message),
                        _ => None,
                    }).unwrap_or_else(|| format!("The local service exited during startup (exit code {code}). Check the logs and retry."))
                };
                set_failure(&app, generation, message);
                return;
            }
            Err(error) => {
                set_failure(
                    &app,
                    generation,
                    format!("Unable to monitor the local service: {error}"),
                );
                return;
            }
            Ok(None) => {}
        }
        if ready {
            continue;
        }
        match read_launcher_status(&status_file) {
            Some(LauncherStatus::Ready { url }) => match validate_ready_url(&url) {
                Ok(url) => {
                    let runtime = app.state::<DesktopRuntime>();
                    {
                        let Ok(mut session) = runtime.session.lock() else {
                            return;
                        };
                        if session.generation != generation {
                            return;
                        }
                        session.ready_url = Some(url.clone());
                        session.status = DesktopStatus {
                            state: "ready",
                            message: String::new(),
                        };
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        if window.navigate(url).is_err() {
                            set_failure(
                                &app,
                                generation,
                                "Unable to open the creative workbenches.".into(),
                            );
                            return;
                        }
                    }
                    let _ = fs::remove_file(&status_file);
                    ready = true;
                }
                Err(error) => {
                    set_failure(&app, generation, error.into());
                    return;
                }
            },
            Some(LauncherStatus::Error { message }) => {
                set_failure(&app, generation, message);
                return;
            }
            None if started.elapsed() >= STARTUP_TIMEOUT => {
                set_failure(&app, generation, "The local service did not become ready within 120 seconds. Check the logs and retry.".into());
                return;
            }
            None => {}
        }
    }
}

fn read_launcher_status(path: &Path) -> Option<LauncherStatus> {
    if fs::metadata(path).ok()?.len() > 32_768 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .setup(|app| {
            let default_dir = app.path().app_data_dir()?;
            let data_dir = if cfg!(debug_assertions) {
                std::env::var_os("OH_STORY_DESKTOP_DATA_DIR")
                    .map(PathBuf::from)
                    .unwrap_or(default_dir)
            } else {
                default_dir
            };
            fs::create_dir_all(data_dir.join("logs"))?;
            app.manage(DesktopRuntime {
                data_dir: data_dir.clone(),
                resource_dir: app.path().resource_dir()?,
                session: Mutex::new(RuntimeSession {
                    generation: 0,
                    process: None,
                    status_file: None,
                    ready_url: None,
                    status: DesktopStatus {
                        state: "starting",
                        message: String::new(),
                    },
                }),
            });
            let navigation_app = app.handle().clone();
            let builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(data_dir.join("webview"));
            #[cfg(debug_assertions)]
            let builder = if let Some(port) = std::env::var("OH_STORY_DESKTOP_CDP_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port >= 1024)
            {
                builder.additional_browser_args(&format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ))
            } else {
                builder
            };
            builder
                .on_navigation(move |url| {
                    if is_bundled_page(url) {
                        return true;
                    }
                    navigation_app
                        .state::<DesktopRuntime>()
                        .session
                        .lock()
                        .map(|session| {
                            session
                                .ready_url
                                .as_ref()
                                .is_some_and(|ready| ready.origin() == url.origin())
                        })
                        .unwrap_or(false)
                })
                .on_new_window(|url, _| {
                    let _ = open_external_url(&url);
                    NewWindowResponse::Deny
                })
                .build()?;

            let open = MenuItem::with_id(app, "open", "Open Oh Story", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "Open Data Folder", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "Open Logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Oh Story", true, None::<&str>)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open, &data, &logs])
                .separator()
                .item(&quit)
                .build()?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("Application icon missing")?
                        .clone(),
                )
                .tooltip("Oh Story")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "data" => {
                        let _ = open_folder(&app.state::<DesktopRuntime>().data_dir);
                    }
                    "logs" => {
                        let _ = open_folder(&app.state::<DesktopRuntime>().data_dir.join("logs"));
                    }
                    _ => show_window(app),
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            start_runtime(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            desktop_retry,
            desktop_open_data,
            desktop_open_logs
        ])
        .build(tauri::generate_context!())
        .expect("Oh Story desktop could not start");
    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(runtime) = app.try_state::<DesktopRuntime>() {
                if let Ok(mut session) = runtime.session.lock() {
                    session.generation += 1;
                    stop_session(&mut session);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_allow_only_http_without_native_or_loopback_targets() {
        for allowed in [
            "https://github.com/deepseek-ai",
            "http://example.com/docs?q=story",
            "https://[2606:4700:4700::1111]/",
        ] {
            assert!(
                is_external_http_url(&Url::parse(allowed).unwrap()),
                "rejected {allowed}"
            );
        }
        for denied in [
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,hello",
            "tauri://localhost/index.html",
            "ms-settings:display",
            "https://user:pass@example.com/",
            "http://localhost:47831/",
            "https://tauri.localhost/",
            "http://LOCALHOST./",
            "http://127.0.0.1:47831/",
            "http://127.1/",
            "http://2130706433/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::]/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            assert!(
                !is_external_http_url(&Url::parse(denied).unwrap()),
                "accepted {denied}"
            );
        }
    }

    #[test]
    fn readiness_requires_authenticated_loopback_root() {
        assert!(validate_ready_url("http://127.0.0.1:47831/?token=test").is_ok());
        assert!(validate_ready_url("http://127.0.0.1:65535/?token=test").is_ok());
        for invalid in [
            "https://127.0.0.1:47831/?token=test",
            "http://localhost:47831/?token=test",
            "http://127.0.0.1.evil.test:47831/?token=test",
            "http://user:pass@127.0.0.1:47831/?token=test",
            "http://127.0.0.1:0/?token=test",
            "http://127.0.0.1:47831/other?token=test",
            "http://127.0.0.1:47831/",
            "http://127.0.0.1:47831/?token=",
            "http://127.0.0.1:47831/?token=test&token=other",
            "http://127.0.0.1:47831/?token=test#fragment",
        ] {
            assert!(validate_ready_url(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn native_commands_are_restricted_to_bundled_startup_page() {
        for allowed in ["http://tauri.localhost/index.html", "tauri://localhost/"] {
            assert!(is_bundled_page(&Url::parse(allowed).unwrap()));
        }
        for denied in [
            "http://127.0.0.1:47831/",
            "http://tauri.localhost.evil.test/",
            "http://tauri.localhost:3000/",
            "http://tauri.localhost/game.html",
            "http://user@tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(!is_bundled_page(&Url::parse(denied).unwrap()));
        }
    }

    #[test]
    fn status_protocol_rejects_unknown_states_and_missing_fields() {
        assert!(serde_json::from_str::<LauncherStatus>(
            r#"{"state":"ready","url":"http://127.0.0.1:47831/?token=test"}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<LauncherStatus>(
            r#"{"state":"error","message":"Port occupied"}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<LauncherStatus>(r#"{"state":"ready"}"#).is_err());
        assert!(serde_json::from_str::<LauncherStatus>(r#"{"state":"unknown"}"#).is_err());
    }
}
