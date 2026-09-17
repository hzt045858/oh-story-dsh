# Architecture

oh-story-dsh is a Cordis plugin loaded into DeepSeek Harness. The repository ships the `@oh-story/dsh` package with Host and Browser entries, plus an optional Windows desktop distribution of that same application.

## Desktop distribution

`apps/desktop` hosts the existing DSH Web application in a Tauri 2 window. Its
bundled Node.js 24 launcher uses the official DSH CLI with an isolated `DSH_HOME`,
the pinned runtime and the locally built plugin. It introduces no second Agent,
conversation UI or creative-project database. The Windows shell owns the runtime
process tree through a Job Object, including cleanup after a desktop crash.
Desktop commands are restricted to the bundled startup/recovery page; neither
the DSH HTTP origin nor game previews receive native capability grants. A stable
loopback port and persistent WebView data preserve the existing draft-backup
origin across restarts. See [desktop operation and builds](DESKTOP.md).

## Ownership

| Surface | Owner |
| --- | --- |
| Workspace, Session and durable history | DeepSeek Harness |
| Agent loop, provider, model and credentials | DeepSeek Harness |
| Preset, sandbox, tools, permissions and approvals | DeepSeek Harness |
| Chat, Trajectory, Todo and Composer | DeepSeek Harness conversation UI |
| Novel craft and specialist personas | Pinned Oh Story Skills and Roles |
| Short-drama workflow and project contracts | Pinned Drama Skills |
| Interactive-game workflow and artifact contracts | Pinned NovelToGame Skills |
| Video-recap workflow and artifact contracts | Pinned video-recap Skills |
| Creative file tree, editor, production projection, game/video preview and file following | `@oh-story/dsh` Browser contribution |

## Host entry

The Host entry registers nine contributions in the current Cordis context:

1. An `oh-story` Skill provider for 13 pinned novel Skills.
2. A `short-drama` Skill provider for 10 pinned Drama Skills.
3. A `novel-to-game` Skill provider for 7 pinned game-production Skills.
4. A `video-recap` Skill provider for 6 pinned video Skills.
5. The `oh_story_role` tool, backed by DSH's `spawn` provider and bounded by the caller's visible tools.
6. The read-only `oh_story_bundled_reference` tool for exact, pinned Role craft references.
7. The side-effect-free `oh_story_production` UI-intent tool for semantic production focus, explicit sequence order and Agent-owned job projection. Cosmetic canvas layout remains creator-controlled Session state.
8. `tools/pre-execute` and `tools/post-execute` hooks for long-form outline and Tracking checks.
9. A Session-scoped creative file route for Markdown, text, JSON, JSONL and previewable production media, plus separate game and video-preview routes.

All four providers prepend a small DSH bridge at load time. The bridge maps upstream platform integration points to the current Session, tools, approvals and UI while leaving craft instructions and references intact. The short-drama bridge fixes the Drama Skills 0.6 creator-first boundary: episodes keep only the requested subset of up to five creator-facing Markdown documents, no empty documents or nominal stages are backfilled, persisted reviews remain readable Markdown while oral reviews write nothing, production keeps the exact-job confirmation contract, and legacy v0.5 structured projects are never migrated in place. The NovelToGame bridge keeps `game-adaptations/<project>` as the project root, `build/app/index.html` as the playable authority and `qa/verification.json` as the six-check QA authority. The video bridge keeps each project under `video-recaps/<project>`, uses `work/` as the upstream work directory, leaves upstream manifests and timelines authoritative, and keeps API keys process-only. It does not introduce a second Agent runtime, render queue, project database or editing timeline. Bundled legacy validators remain maintenance resources and do not reactivate the old JSON/JSONL workflow.

Specialist Roles preserve their upstream structured file tools and intersect them with the calling Agent's visible DSH tools. Roles that reference shared `story-setup` craft material receive only the plugin's `oh_story_bundled_reference` reader when it is visible. The reader exposes an allowlist built from the pinned package, resolves every file canonically inside that package, rejects path escape, and fails closed if a scoped same-name tool shadows it; project Skills can therefore neither redirect Role references nor inject replacement instructions. Roles never probe `.claude`, `.codex` or other deployment directories.

The prose guards and file route resolve the live Agent and use that Agent's DSH `FileSystem`, so their view of the workspace matches native tools under local, sandboxed and remote providers. The route first applies the same Host, Origin and Fetch Metadata trust boundary as DSH's native browser API, then uses the Agent filesystem and sandbox policy for resolution, containment, reads and atomic `replaceIfVersion` writes. Media preview is read-only and extension allowlisted. Media whose canonical process path is a real file inside the host-visible workspace root is streamed with HTTP byte ranges and no whole-file buffer; every other backend uses the DSH bounded byte API and retains a 256 MiB fallback cap. Unparseable or unsupported Range headers are ignored per RFC 9110, and only satisfiability failures answer 416. Editable access remains limited to documented creative project directories. Loopback is trusted by default; explicit non-loopback authorities must be declared through the plugin's `trustedHosts` config. Child Sessions do not receive an editor route.

Playable game assets are served from workspace `build/app` directories or the bundled example through a separate content route. Every path is canonically contained, files are size-limited and HTML receives a restrictive CSP. On loopback, the Browser swaps `127.0.0.1` and `localhost` for the iframe origin, preserving same-origin storage inside a game while isolating generated scripts from the DSH application origin. The fallback sandbox omits `allow-same-origin` when an alternate origin is unavailable.

## Browser entry

The Browser entry uses two official extension slots:

| Slot | Contribution |
| --- | --- |
| `shell.overlay` | Declares the Session-scoped three-column creative workbench seat |
| `tool.call.toolview` | Compact `oh_story_role` invocation view |

The workbench opens automatically for a Session whose workspace holds creative files, a workspace game project or a video project. The bundled game example never counts as a workspace project. Empty workspaces expose five compact entry buttons and keep the official conversation layout until the creator opens a workbench. Collapsing any workbench restores those entries. The explicit open/closed choice is persisted per workspace in browser storage and takes priority over automatic detection.

The bridge portals its workbench into the stable `conversation.session` layout seam. 小说/短剧 retain the file-tree/editor/Chat three-column surface. 游戏 switches to a focused two-column surface: the generated-game preview owns the larger left region and the mounted official conversation remains the right region, so Chat state, streaming, tools, Todo, approvals, history and Composer continue to use DSH implementations.

视频 uses the same left-Studio/right-Conversation geometry without importing an NLE runtime. Project discovery reads a small allowlist of upstream artifacts and skips frame, ASR-chunk, cache and TTS-segment directories. The player exposes source, `edited_source.mp4` and the assembly output, keeps the loaded version stable during Agent writes, and makes the creator opt into a new version. The artifact panel is read-only; `recap_run_manifest.json`, `recap_phase.json`, `timeline.json` and `assembly_manifest.json` remain the lifecycle authority. The runtime preflight probes the DSH host process for Python, ffmpeg/libass, ffprobe and whether credentials are present, never their values; the Agent's own execution world is reported by upstream `video-recap --doctor`.

Game Studio discovers workspace projects from `game-adaptations/*`, fingerprints `build/app`, retains the current playable version during an Agent build, and exposes only Preview plus read-only project-file inspection. The Game Studio and Preview panel stay mounted while project files, Chat, or the same Session's 小说 workspace are visible, preserving the live iframe and player state. A new digest is never loaded merely because the iframe lost focus; the creator explicitly chooses `载入新版本`. Narrow layouts show either Studio or Chat at a time instead of shrinking the playable surface below a usable width; both regions and their drafts remain mounted.

QA remains invisible infrastructure. NovelToGame Skills, packaged QA artifacts and automated gates retain the six-check contract, while Game Studio intentionally renders no QA tab, pass/fail cards, badge or release score. The upstream schema has no build digest, so the Host-side API never guesses that an imported PASS belongs to the current preview: it reports that record as `UNBOUND`, binds an observed QA revision to its preview digest, and changes the binding to `STALE` when the preview digest moves. The immutable bundled example is `PINNED`.

The overlay declares a strict Session child slot, so DSH supplies `sessionId`, `useSession` and a per-Session workbench Store without manual Session subscriptions. DSH intentionally omits a tool-only Assistant from the visible Chat `partial`; its official Step location data still publishes that Assistant's streamed blocks, which the Browser reads from `chat.timeline`. Executing and nested tools come from `runningCalls`. The Browser restricts both sources to supported creative paths and projects them over the last disk version. Once a tool settles, the workspace route is the authority again. The file tree preserves every project directory level; selection changes also switch the 小说/短剧 mode and expand the matching group plus all ancestor directories.

For a selected Drama 0.6 episode, the Browser parses only that episode's existing five Markdown documents into a disposable `short-drama/v1` projection. Explicit visual IDs remain stable across title edits; duplicate IDs, generated fallback IDs, unresolved sources/references, malformed production headings and conflicting motion blocks produce navigable diagnostics instead of silent guesses. It provides shot and asset cards, cross-document navigation, a Session-scoped and episode-keyed job projection, workspace-backed media versions, sequence validation and a draggable creator-controlled relationship canvas. A project media library indexes previewable results already visible through the Agent FileSystem across episode and delivery directories; manual cross-episode image references remain episode-keyed Session preferences and are included only in an explicitly prepared video job. Switching episodes rebuilds document/media projections and isolates jobs, version selections, manual references, sequence and canvas layout by episode directory. The projection never writes a parallel database. Prompt editing stays in the owning creator Markdown or the normal DSH Chat instead of being duplicated on production cards.

Image and video buttons inject an exact prepare-only `/short-drama-produce` request through the current Session's official `ConversationController`. The Session projection remains `awaiting_confirmation` until the creator confirms the displayed preview and the executing Agent records that same job ID through `oh_story_production`; only then does it become running. Queue items are matched to the official Conversation Queue and can only be removed through its Queue API, while stopping an active Turn calls the official Conversation cancellation API and preserves the remaining Queue. Media-to-target and media-to-job association uses exact path tokens, never substring containment. A completed paid Turn without correlated workspace output becomes `dispatched_unknown`, not an automatically retryable failure. DSH remains the sole owner of tools, provider/model choice, approvals, cancellation, durable history and Trajectory. Optional GPT Image 2, Seedance and MiniMax Music adapters implement verified request contracts, but their external configuration, account access and credentials remain outside the plugin. Results become versions only after they appear under the selected episode or delivery directories in the Agent FileSystem.

Agent operability follows that ownership boundary. The Agent can directly execute a confirmed production turn with the current Preset's visible tools and can change canvas content by editing creator documents or writing media results, which rebuilds the projection. It can also call `oh_story_production`; successful durable tool calls are replayed in official DSH Chat order and idempotently applied to the per-Session Browser Store. Layout, zoom, selected references and sequence preferences remain interface state rather than creative truth. The tool emits no file, media, network or provider side effect and explicitly does not count as creator confirmation, so production authority stays with Drama Skills and DSH approvals rather than a hidden sidecar runtime.

When the Agent is idle, a capture listener recognizes existing workspace file links inside the official conversation. Those links update the same selection state used by Agent file following. Human-dirty buffers take precedence over incoming disk or Agent state and surface a per-file conflict with explicit disk/local resolution. The DSH Session Store retains editor state across in-process Session switches. Separately, the novel and short-drama text editors automatically back up unsaved human drafts to browser `localStorage`, scoped by origin, workspace cwd and Session ID. Only each dirty file's `content`, `saved` baseline and filesystem `version` are backed up; editor navigation and production-panel preferences are not included. Reopening the original Session after a page reload or DSH restart restores its drafts. Changed disk files surface conflicts, deleted files leave drafts available to download or discard, and changes from another page prompt the creator instead of overwriting either draft. Storage failures offer retry and download actions. Backups do not transfer across browsers or origins (including ports), and clearing site data removes them. File reads carry the opaque DSH filesystem version; writing a draft to disk remains an explicit manual save using that version as an atomic precondition, rejecting stale writes instead of overwriting concurrent disk changes.

Draft backup writers hold an exclusive browser Web Lock for their workspace/Session scope. Another page can retain edits in memory but must release the owning page and retry before updating that backup. Browsers without Web Locks report backup unavailability. When drafts first become dirty, `POST /oh-story/draft-session` asks DSH's official `SessionPersistence.ensureMaterialized` to retain the exact live Session, including an empty conversation. This creates no chat event and writes no creative file. The backup status remains pending until that request succeeds, so a creator who only edits documents can still resume after a Host restart.

Markdown rendering is implemented as a safe React element tree with tables, task lists, quotes and fenced code. Raw HTML is treated as text and external links are limited to HTTP(S). JSONL is parsed one record per source line, keeps malformed lines visible, and summarizes stable IDs, types and statuses. Every preview shares its buffer and save path with source editing.

## First-party WeChat Skill

`packages/knowledge/wechat/skills/wechat-article` is a first-party Skill registered
by its own provider and copied into the release bundle. It is not part of the
four pinned upstream manifests. Its V5.0-derived workflow keeps each account's
source corpus, semantic annotations, topic/global style evidence and generated
articles separate. Python helpers audit files, merge Agent-authored annotations,
retrieve full reference articles, record image dispatch receipts, render HTML and
produce PNG text cards. Semantic classification and style analysis remain Agent work.

The `wechat` workbench shares the file tree, editor, conflict checks and draft
backup mechanism with fiction and drama. Its file route includes Markdown, HTML,
JSON and raster media under `公众号/<account>/`. Reference originals under each
account's `参考文章/` directory are read-only in both the editor and PUT route.
Markdown is parsed with marked and HTML sanitized with DOMPurify; previews use
an opaque sandboxed iframe with scripts and external resources disabled. Only
listed raster images from the same account are fetched by the application and
embedded as data URLs. The creation button prepares `/wechat-article` in the
current session's official composer. Image jobs can
reuse the pinned provider adapter without invoking the short-drama lifecycle or
writing episode paths. The adapter path is supplied by the Skill bridge and must
exist in the current execution environment. The bundled WeChat publisher uses the
official stable-token, image/material, draft, freepublish and mass-message APIs.
It prepares immutable account-bound snapshots, validates source hashes, serializes
writers per account, caches media per AppID and persists each external operation
before dispatch. Draft, public publication and subscriber mass sending are distinct
states. Unknown outcomes require reconciliation; due-time checks do not constitute
a running scheduler. Credentials stay in the execution environment.

`wechat/upstreams.json` records six researched projects. Selected unmodified MIT
and Apache reference files and MIT theme definitions are bundled with their licenses
and hash checks; the renderer consumes the theme color tokens. AGPL and restricted
source-available projects have provenance entries only, with independent implementations
for their referenced capabilities. They do not become additional DSH Skill providers.

## Upstream assets

`packages/knowledge/oh-story/manifest.json` pins the Oh Story release, commit, 13 Skills, 7 Roles, agents version and every file hash. `packages/knowledge/drama/manifest.json` performs the same role for 10 Drama Skills. `packages/knowledge/novel-to-game/manifest.json` pins NovelToGame 0.3.0, all 7 Skills and the complete playable `jin-ping-mei` example. `packages/knowledge/video-recap/manifest.json` pins video-recap-skills 0.4.0, all 6 Skills and every bundled file hash.

The Drama Skills standalone dashboard server and assets are omitted during synchronization because the creator surface is supplied by the DSH workbench. Oh Story's login/CDP rank scrapers and platform deployment helpers are also excluded; the two scan Skills use DSH-native, visible-tool research instructions instead. Synchronization rejects Python bytecode, `__pycache__` and `.DS_Store` workspace pollution before manifests are generated. Remaining workflow, reference, validation and production-adapter resources are packaged with their upstream paths.

## Product boundaries

Each workbench projects the pinned upstream contract; none of them becomes a
second source of creative truth.

- Short drama reads the five creator-first Markdown documents per episode. The
  production view projects them through the lightweight `short-drama/v1`
  protocol and reports duplicate ids, dangling references and malformed
  headings against their source lines. Empty documents are never pre-created,
  and stages the creator did not ask for are never backfilled.
- The game workbench keeps QA in `/game-qa`, native tool results and
  `qa/verification.json`. It adds no QA tab, card or badge of its own.
- The video workbench offers version switching, stage hints and artifact
  viewing. It carries no multi-track timeline or heavy editor.
- `oh_story_production` opens and focuses semantic targets, sets shot order and
  records the jobs the Agent actually ran. It never edits creative documents,
  never generates media, and never stands in for a paid-production
  confirmation.
- Bundled media exists for offline interaction regression only and is never
  presented as a provider success.
- The video runtime check reports only whether Python, ffmpeg/libass, ffprobe
  and keys are ready inside the DSH Host process. Provider credentials are
  never sent to the browser; `video-recap --doctor` remains authoritative.
- Short-drama media comes from provider adapters, never from the DeepSeek model.
  The plugin registers the four bundled adapters (GPT Image 2, Seedance,
  MiniMax H3, MiniMax Music) in a credential-free adapter config outside every
  project, names that file and each adapter's required variables to the
  `short-drama-produce` Skill, and the 生产 view reports per adapter whether
  the Host environment has them. Presence only is reported; values never
  reach the Skill text, the browser, or a project file. A creator-owned config
  named by `OH_STORY_DRAMA_ADAPTER_CONFIG` is used untouched.

## Release boundary

The build produces Host and Browser bundles under `packages/dsh-plugin/lib`, copies all four knowledge sets, and rejects known parallel-runtime markers. Generated `lib` and tarballs are release artifacts and are excluded from Git history.
