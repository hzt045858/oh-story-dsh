fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "desktop_retry",
            "desktop_open_data",
            "desktop_open_logs",
        ]),
    ))
    .expect("failed to build desktop resources");
}
