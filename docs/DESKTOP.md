# Windows Desktop

Oh Story Desktop uses Tauri 2 and Windows WebView2 to run the existing DSH Web
application and all five creative workbenches. It includes Node.js 24, the pinned
DSH runtime and the locally built `@oh-story/dsh` plugin. The desktop executable
starts its own DSH service; users do not need Node.js or pnpm installed.

## Run

The initial supported target is Windows 10/11 x64 with Microsoft Edge WebView2
Runtime installed.

- Portable build: open `Oh Story.exe` in the complete
  `release/Oh-Story-0.1.8-windows-x64` directory. Keep its `runtime` directory
  beside the executable; copying the executable alone is insufficient.
- Installer build: use the NSIS installer under
  `apps/desktop/src-tauri/target/release/bundle/nsis` when generated.
- Closing the window keeps the application running in the system tray. Use
  the tray's quit command to stop the application and its owned DSH processes.

Select a workspace and configure models in the existing DSH interface. Model
requests still require provider credentials and network access. Desktop packaging
does not change the tools, permissions, approvals or creative-file save behavior.
Python, ffmpeg/ffprobe, media-provider credentials and optional Skill dependencies
are not bundled. The video workbench retains its environment checks.

The WeChat workbench opens accounts under `公众号/<account>/`, with article
editing, local draft recovery and isolated Markdown/HTML previews. Local raster
images are resolved within the same account; previews run without scripts or
external network resources. Reference originals under `参考文章/` are read-only.
Creation requests use `/wechat-article` in the current session's composer.

## Data And Drafts

Desktop-owned data is stored under `%APPDATA%/com.ohstory.desktop`:

- `dsh`: DSH profiles, model settings, credentials and durable sessions.
- `webview`: persistent WebView browser data, including unsaved draft backups.
- `logs`: local runtime diagnostics.
- `desktop.json`: the desktop service port, default `47831`.

Use the running application's tray command **Open Data Folder** to locate its
active data. Windows can redirect AppData for applications started by an MSIX
packaged tool, so a tool's apparent Roaming directory may differ from the one
used when launching the portable executable directly from Explorer.

The service binds only to `127.0.0.1`. Its address remains stable across launches
so draft backups continue to use the same browser origin. If the port is occupied,
startup reports an error instead of connecting to an unrelated server or silently
changing origins. Close the conflicting application and retry. As a last resort,
edit the `port` field in `desktop.json` while Oh Story is closed. Changing the
port creates a different draft-storage origin; save or export drafts first.

Desktop data is independent of browser sessions, browser draft backups and other
DSH installations. Existing workspace files can be opened from either version,
but their unsaved browser drafts do not automatically transfer. Save those drafts
to their workspace files before switching. To back up desktop data, quit the
application completely and copy the data directory as well as your workspace
files. Do not delete `webview` when preserving unsaved drafts.

## Build

Build prerequisites: Node.js 24, pnpm, Rust stable, Visual Studio C++ Build Tools,
Windows SDK and WebView2. Dependencies are locked separately for the desktop
shell and the bundled DSH runtime. Preparation needs package-registry access
unless dependencies are cached, and downloads the matching Node license once.

```powershell
pnpm install --frozen-lockfile
pnpm desktop
pnpm desktop:portable
pnpm desktop:build
```

`desktop` starts development mode. `desktop:portable` produces the complete
portable folder. `desktop:build` produces an NSIS installer and may download
Tauri packaging tools. No certificate or automatic update service is configured;
local builds are unsigned.

Preparation copies the Node 24 executable used for the build. To use another
Node 24 executable, set `OH_STORY_DESKTOP_NODE`. For offline builds, set
`OH_STORY_DESKTOP_NODE_LICENSE` to that release's local `LICENSE` file. Generated
runtime resources are ignored by Git; rebuild them after changing the launcher,
plugin or dependency lockfile.

The desktop runtime pins a pnpm patch for DSH's workspace UI under
`apps/desktop/runtime-deps/patches`. On a first launch with no workspace, New
Session opens the existing directory selection flow and then creates the
workspace and session. Explicit New Session creates and selects a fresh session;
passive workspace navigation can reuse an empty session. The patch preserves
cancellation and retry; repeated pending requests share one directory chooser
or session creation operation.
Recheck this patch when upgrading DSH.

A second runtime patch adds per-model reasoning capabilities to the Models
page's advanced settings. Custom OpenAI-compatible routes can declare their
supported levels and request values; the existing chat selector then exposes
those levels. Model discovery still reflects the configured endpoint's listing,
so a model omitted by that endpoint needs its provider-confirmed ID entered
manually. The application does not infer capabilities from a model's name.

The model selector also clears a session's saved reasoning level when that
level is removed or reasoning capabilities are disabled. This correction uses
the existing session selection API so subsequent requests use a supported default.

## Releases

Published desktop builds are portable zips attached to the Releases page, named
`Oh-Story-<app-version>-windows-x64.zip`. Unzip one and open `Oh Story.exe`
inside the resulting `Oh-Story-<app-version>-windows-x64` folder, keeping the
`runtime` directory beside the executable as described under **Run**.

No certificate or automatic update service is configured, so published builds
are unsigned and Windows SmartScreen may warn on first launch. No installer is
published; run the portable build.

Maintainers publishing a build: the tag rules are in `docs/RELEASING.md`.

## Verification

```powershell
pnpm test:desktop
pnpm desktop:prepare
pnpm --filter @oh-story/desktop test:models
pnpm --filter @oh-story/desktop test:navigation
pnpm test:desktop:native
pnpm test:desktop:native --models-only
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The native smoke test uses its own temporary desktop data, workspace, service
port and WebView debugging port. It tests the actual desktop window and draft
recovery across a process restart without calling an external model. Debugging
and the `OH_STORY_DESKTOP_DATA_DIR` override are restricted to debug builds.

The models-only check uses a local mock OpenAI endpoint and dummy credentials.
It checks model discovery, per-model settings, chat selections, persistence and
the reasoning parameters in Responses and Chat Completions requests.

## Implementation

The native shell starts bundled Node inside a Windows Job Object. The job owns
its entire child process tree, which is terminated when the desktop exits or
crashes. Startup waits for the owned DSH process's authenticated local URL.
Runtime failures return to the bundled recovery screen.

Only the bundled startup/recovery screen can invoke desktop commands. The DSH
page, generated game previews and external pages receive no Tauri capability
grants. Native navigation is restricted to the bundled screen and the selected
local DSH origin. External HTTP/HTTPS links open in the system browser. DSH
continues to own authentication and API authorization.

The Windows Desktop GitHub Actions workflow runs the isolated native tests and
uploads a portable build as a CI artifact. It can also be started manually. That
artifact is CI evidence rather than a release.
