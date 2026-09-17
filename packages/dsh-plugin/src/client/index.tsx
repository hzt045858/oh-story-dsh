import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { createSnapshotStore, defineStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { IConversation, PartialAssistant, RunningToolCall } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRenderSlots, PropsRuntime, PropsStore } from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  creativeRelativePath,
  fileMutations,
  latestSettledMutation,
  mutatingCallIds,
  preferredWorkbenchFile,
  previewMutation,
  streamingAssistant,
  workbenchLabel,
  workbenchModeForPath,
  type WorkbenchMode
} from "./file-activity.js";
import { buildFileTree, type FileTreeNode } from "./file-tree.js";
import { draftBackupKey, draftBackupStorage, isDirtyDraft, type DraftScope } from "./draft-backup.js";
import { acquireDraftBackupLock, hasDraftBackupLock } from "./draft-backup-lock.js";
import {
  checkDraftSession,
  restoreDraftSession,
  sameDraftScope,
  syncDraftSession,
  updateDraftUnloadGuard,
  type DraftSessionState,
  type FileBuffer
} from "./draft-session.js";
import { JsonlPreview } from "./jsonl-preview.js";
import { WechatPreview } from "./wechat-preview.js";
import { isWechatReferencePath } from "../wechat-files.js";
import { MarkdownPreview } from "./markdown-preview.js";
import {
  creatorDocumentPaths,
  episodeDirectoryForPath,
  isCreatorDocumentPath,
  parseEpisodeProduction,
  type DramaDocumentTarget,
  type DramaProductionSection
} from "./drama-production.js";
import { DramaProductionView } from "./drama-production-view.js";
import { applyProductionDocumentResults, productionDocumentRequests } from "./production-documents.js";
import { createPendingJob, type
  CanvasPoint,
  mediaTargetFromPath,
  type ProductionJob,
  type ProductionMediaVersion,
  type ProductionQueueEntry,
  type ProductionSequenceItem
} from "./production-runtime.js";
import { settledProductionIntents, type SettledProductionIntent } from "./production-intents.js";
import { OH_STORY_PRODUCTION_TOOL_NAME } from "../production-intent.js";
import { VideoStudio, type VideoProject } from "./video-studio.js";
import {
  hasCreativeProject,
  readWorkbenchPreference,
  resolveWorkbenchOpen,
  workbenchPreferenceStorage,
  writeWorkbenchPreference,
  type WorkbenchPreference
} from "./workbench-presence.js";
import { endpoint, handleTabKey } from "./workbench-ui.js";
import { enterWorkbench, type WorkbenchEntryHost, type WorkbenchEntryRequest } from "./workbench-entry.js";
import styles from "./plugin.css?inline";

export const name = "oh-story";
export const inject = ["slots", "sessions", "conversation"];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "oh-story.workspace": { kind: "single"; scope: "session" };
  }
}

interface WorkspaceFile {
  readonly path: string;
  readonly bytes: number;
  readonly version: string;
  readonly kind: "text" | "media";
  readonly mimeType?: string | undefined;
}
interface WorkspacePayload {
  readonly cwd: string;
  readonly files: readonly WorkspaceFile[];
  readonly games: readonly GameProject[];
  readonly videos: readonly VideoProject[];
  readonly shortDrama: Record<string, unknown> | null;
  readonly metadataErrors: readonly string[];
  readonly mode: "dsh-session";
}
interface GameProject {
  readonly id: string;
  readonly root: string;
  readonly title: string;
  readonly source: "workspace" | "example";
  readonly previewReady: boolean;
  readonly previewUrl?: string | undefined;
  readonly previewVersion: string;
}
interface FilePayload {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly version: string;
}
interface WorkbenchMemory extends DraftSessionState {
  draftSessionReady: boolean;
  draftSessionError: string | undefined;
  workbenchPreference: WorkbenchPreference | undefined;
  editorMode: "preview" | "source" | "production";
  expanded: Record<string, boolean>;
  selected: string | undefined;
  lastSelected: Partial<Record<WorkbenchMode, string>>;
  workbench: WorkbenchMode;
  gameTab: "preview" | "design";
  gameProjectId: string | undefined;
  gamePane: "studio" | "chat";
  videoTab: "preview" | "artifacts";
  videoProjectId: string | undefined;
  videoPane: "studio" | "chat";
  productionSection: DramaProductionSection;
  productionSelectedIds: Record<string, string | undefined>;
  productionJobs: Record<string, ProductionJob[]>;
  productionSelections: Record<string, Record<string, string>>;
  productionReferences: Record<string, Record<string, string[]>>;
  productionSequence: Record<string, ProductionSequenceItem[]>;
  productionCanvas: Record<string, Record<string, CanvasPoint>>;
  productionZoom: Record<string, number>;
  productionIntentCalls: Record<string, boolean>;
}

type Update<T> = T | ((current: T) => T);

function applyUpdate<T>(current: T, update: Update<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function restoreWorkbenchDrafts(draft: WorkbenchMemory, scope: DraftScope): void {
  if (!sameDraftScope(draft.draftScope, scope)) draft.draftSessionError = undefined;
  const selected = restoreDraftSession(draft, scope, draftBackupStorage());
  if (selected !== undefined) {
    draft.selected = selected;
    const mode = workbenchModeForPath(selected) ?? "story";
    draft.workbench = mode;
    draft.lastSelected[mode] = selected;
    draft.editorMode = "source";
  }
  syncDraftSession(draft, draft.selected);
}

function createWorkbenchStore() {
  return defineStore({
    init: (): WorkbenchMemory => ({
      buffers: {},
      draftScope: undefined,
      draftSnapshot: undefined,
      draftError: undefined,
      recoveredDrafts: 0,
      draftSessionReady: false,
      draftSessionError: undefined,
      workbenchPreference: undefined,
      editorMode: "preview",
      expanded: {},
      selected: undefined,
      lastSelected: {},
      workbench: "story",
      gameTab: "preview",
      gameProjectId: undefined,
      gamePane: "studio",
      videoTab: "preview",
      videoProjectId: undefined,
      videoPane: "studio",
      productionSection: "shots",
      productionSelectedIds: {},
      productionJobs: {},
      productionSelections: {},
      productionReferences: {},
      productionSequence: {},
      productionCanvas: {},
      productionZoom: {},
      productionIntentCalls: {}
    }),
    actions: {
      initializeDrafts: (draft, scope: DraftScope) => {
        if (!sameDraftScope(draft.draftScope, scope)) restoreWorkbenchDrafts(draft, scope);
        else {
          checkDraftSession(draft, draftBackupStorage());
          updateDraftUnloadGuard(draft);
        }
      },
      retryDraftBackup: (draft) => {
        if (draft.draftScope !== undefined) restoreWorkbenchDrafts(draft, draft.draftScope);
      },
      setDraftBackupAccess: (draft, scope: DraftScope, result: "owned" | "busy" | "unavailable") => {
        if (!sameDraftScope(draft.draftScope, scope)) return;
        if (result === "owned") restoreWorkbenchDrafts(draft, scope);
        else {
          draft.draftError = result;
          updateDraftUnloadGuard(draft);
        }
      },
      setDraftSessionResult: (draft, scope: DraftScope, error: string | undefined) => {
        if (!sameDraftScope(draft.draftScope, scope)) return;
        draft.draftSessionReady = error === undefined;
        draft.draftSessionError = error;
        updateDraftUnloadGuard(draft);
      },
      checkDraftBackup: (draft) => {
        checkDraftSession(draft, draftBackupStorage());
        updateDraftUnloadGuard(draft);
      },
      dismissDraftRecovery: (draft) => { draft.recoveredDrafts = 0; },
      setBuffers: (draft, update: Update<Record<string, FileBuffer>>) => {
        draft.buffers = applyUpdate(draft.buffers, update);
        if (!Object.values(draft.buffers).some(isDirtyDraft)) draft.recoveredDrafts = 0;
        syncDraftSession(draft, draft.selected);
      },
      setWorkbenchPreference: (draft, update: Update<WorkbenchPreference | undefined>) => {
        draft.workbenchPreference = applyUpdate(draft.workbenchPreference, update);
      },
      setEditorMode: (draft, update: Update<WorkbenchMemory["editorMode"]>) => {
        draft.editorMode = applyUpdate(draft.editorMode, update);
      },
      setExpanded: (draft, update: Update<Record<string, boolean>>) => {
        draft.expanded = applyUpdate(draft.expanded, update);
      },
      setSelected: (draft, update: Update<string | undefined>) => {
        draft.selected = applyUpdate(draft.selected, update);
        const mode = workbenchModeForPath(draft.selected);
        if (draft.selected !== undefined && mode !== undefined) draft.lastSelected[mode] = draft.selected;
        syncDraftSession(draft, draft.selected);
      },
      setWorkbench: (draft, update: Update<WorkbenchMode>) => {
        draft.workbench = applyUpdate(draft.workbench, update);
      },
      setGameTab: (draft, update: Update<WorkbenchMemory["gameTab"]>) => {
        draft.gameTab = applyUpdate(draft.gameTab, update);
      },
      setGameProjectId: (draft, update: Update<string | undefined>) => {
        draft.gameProjectId = applyUpdate(draft.gameProjectId, update);
      },
      setGamePane: (draft, update: Update<WorkbenchMemory["gamePane"]>) => {
        draft.gamePane = applyUpdate(draft.gamePane, update);
      },
      setVideoTab: (draft, update: Update<WorkbenchMemory["videoTab"]>) => {
        draft.videoTab = applyUpdate(draft.videoTab, update);
      },
      setVideoProjectId: (draft, update: Update<string | undefined>) => {
        draft.videoProjectId = applyUpdate(draft.videoProjectId, update);
      },
      setVideoPane: (draft, update: Update<WorkbenchMemory["videoPane"]>) => {
        draft.videoPane = applyUpdate(draft.videoPane, update);
      },
      setProductionSection: (draft, update: Update<DramaProductionSection>) => {
        draft.productionSection = applyUpdate(draft.productionSection, update);
      },
      setProductionSelectedIds: (draft, update: Update<Record<string, string | undefined>>) => {
        draft.productionSelectedIds = applyUpdate(draft.productionSelectedIds, update);
      },
      setProductionJobs: (draft, update: Update<Record<string, ProductionJob[]>>) => {
        draft.productionJobs = applyUpdate(draft.productionJobs, update);
      },
      setProductionSelections: (draft, update: Update<Record<string, Record<string, string>>>) => {
        draft.productionSelections = applyUpdate(draft.productionSelections, update);
      },
      setProductionReferences: (draft, update: Update<Record<string, Record<string, string[]>>>) => {
        draft.productionReferences = applyUpdate(draft.productionReferences, update);
      },
      setProductionSequence: (draft, update: Update<Record<string, ProductionSequenceItem[]>>) => {
        draft.productionSequence = applyUpdate(draft.productionSequence, update);
      },
      setProductionCanvas: (draft, update: Update<Record<string, Record<string, CanvasPoint>>>) => {
        draft.productionCanvas = applyUpdate(draft.productionCanvas, update);
      },
      setProductionZoom: (draft, update: Update<Record<string, number>>) => {
        draft.productionZoom = applyUpdate(draft.productionZoom, update);
      },
      setProductionIntentCalls: (draft, update: Update<Record<string, boolean>>) => {
        draft.productionIntentCalls = applyUpdate(draft.productionIntentCalls, update);
      }
    }
  });
}

class WorkspaceRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const GROUP_ORDER: Readonly<Record<WorkbenchMode, readonly string[]>> = {
  story: ["正文", "大纲", "设定", "追踪", "对标", "参考资料"],
  drama: ["项目", "输入", "项目开发", "设定集", "剧集", "审查", "创作者决策", "交付"],
  game: ["game-adaptations"],
  video: ["video-recaps"],
  wechat: ["公众号"]
};

const WORKBENCH_MODES = ["story", "drama", "game", "video", "wechat"] as const;
const EDITOR_MODES = ["preview", "source", "production"] as const;

function groupForPath(path: string): string {
  if (path.startsWith("公众号/") && path.split("/").length > 2) return path.split("/").slice(0, 2).join("/");
  return path === "short-drama.json" ? "项目" : path.split("/", 1)[0] ?? "其他";
}

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { readonly error?: string };
  if (!response.ok) throw new WorkspaceRequestError(response.status, value.error ?? `HTTP ${String(response.status)}`);
  return value;
}

function FileTreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  activityPath,
  onToggle,
  onSelect
}: {
  readonly nodes: readonly FileTreeNode[];
  readonly depth: number;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly selected: string | undefined;
  readonly activityPath: string | undefined;
  readonly onToggle: (path: string, open: boolean) => void;
  readonly onSelect: (path: string) => void;
}) {
  return <>{nodes.map((node) => {
    if (node.kind === "file") return <button
      type="button"
      key={node.path}
      style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties}
      title={node.path}
      aria-label={node.path}
      data-file-path={node.path}
      data-agent-target={node.path === activityPath || undefined}
      aria-current={node.path === selected ? "page" : undefined}
      onClick={() => { onSelect(node.path); }}
    >{node.name}</button>;
    const open = selected?.startsWith(`${node.path}/`) === true || expanded[node.path] === true;
    return <details className="oh-story-file-folder" key={node.path} open={open} onToggle={(event) => { onToggle(node.path, event.currentTarget.open); }}>
      <summary style={{ "--oh-story-indent": `${String(depth * 14)}px` } as CSSProperties} title={node.path}>{node.name}<span>{node.fileCount}</span></summary>
      <FileTreeNodes
        nodes={node.children}
        depth={depth + 1}
        expanded={expanded}
        selected={selected}
        activityPath={activityPath}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </details>;
  })}</>;
}

function useWorkspace(sessionId: string): {
  readonly workspace: WorkspacePayload | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
} {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ readonly sessionId: string; readonly workspace: WorkspacePayload }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void fetch(endpoint("workspace", sessionId), { signal: controller.signal })
      .then((response) => json<WorkspacePayload>(response))
      .then((workspace) => { if (!controller.signal.aborted) setResult({ sessionId, workspace }); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [sessionId, version]);
  return { workspace: result?.sessionId === sessionId ? result.workspace : undefined, error, loading, reload };
}

function isolatedPreviewUrl(path: string, version: string, revision: number): { readonly href: string; readonly isolated: boolean } {
  const url = new URL(path, globalThis.location.origin);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.searchParams.set("build", version);
  url.searchParams.set("reload", String(revision));
  return { href: url.toString(), isolated: url.origin !== globalThis.location.origin };
}

/**
 * An iframe fires `load`, not `error`, when a navigation commits an HTTP error response, so the
 * frame's own events cannot tell a working preview from the route's JSON error body. Probe the
 * same URL out of band and report a non-OK or non-HTML answer as a real failure.
 */
function PreviewProbe({ href, onFailed }: { readonly href: string; readonly onFailed: () => void }) {
  // Hold the callback in a ref so an inline arrow from the caller cannot re-trigger the probe.
  const failedRef = useRef(onFailed);
  useEffect(() => { failedRef.current = onFailed; }, [onFailed]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(href, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.includes("text/html")) failedRef.current();
      })
      .catch(() => { if (!controller.signal.aborted) failedRef.current(); });
    return () => { controller.abort(); };
  }, [href]);
  return null;
}

function GamePreview({ project, building }: { readonly project: GameProject; readonly building: boolean }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFullscreenFocus = useRef(false);
  const [focused, setFocused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadedVersion, setLoadedVersion] = useState(project.previewVersion);
  useEffect(() => {
    const document = shellRef.current?.ownerDocument;
    if (document === undefined) return;
    const restore = (): void => {
      if (document.fullscreenElement !== null || !restoreFullscreenFocus.current) return;
      restoreFullscreenFocus.current = false;
      fullscreenButtonRef.current?.focus();
    };
    document.addEventListener("fullscreenchange", restore);
    return () => { document.removeEventListener("fullscreenchange", restore); };
  }, []);
  if (!project.previewReady || project.previewUrl === undefined) return <div className="oh-game-preview-empty">
    <span aria-hidden>◫</span>
    <strong>还没有可试玩版本</strong>
    <p>在右侧 Chat 使用 <code>/novel-to-game quick</code>，产物写入 <code>game-adaptations/&lt;project&gt;/build/app/</code> 后会自动出现在这里。</p>
    <div className="oh-game-prompt-example"><span>描述示例</span><q>把《作品名》改编成网页互动游戏，目标玩家是……，核心玩法是……，希望整体风格……</q></div>
  </div>;
  const preview = isolatedPreviewUrl(project.previewUrl, loadedVersion, revision);
  const pending = project.previewVersion !== loadedVersion;
  /** Accept the newer build the creator just chose. */
  const reload = (): void => {
    setLoaded(false);
    setLoadError(false);
    setLoadedVersion(project.previewVersion);
    setRevision((value) => value + 1);
  };
  /** Re-run the build the creator already accepted; never silently adopt a newer one. */
  const refresh = (): void => {
    setLoaded(false);
    setLoadError(false);
    setRevision((value) => value + 1);
  };
  const runtimeState = loadError ? "预览载入失败 · 可重新载入"
    : building ? "Agent 正在更新游戏文件 · 当前预览保持不变"
      : pending ? "新版本已就绪 · 由你决定何时载入"
        : loaded ? (preview.isolated ? "预览已载入" : "预览已载入 · 当前部署无法隔离来源，存档功能不可用")
          : "正在载入预览…";
  const fullscreen = (): void => {
    const shell = shellRef.current;
    if (shell === null) return;
    restoreFullscreenFocus.current = true;
    void shell.requestFullscreen().catch(() => { restoreFullscreenFocus.current = false; });
  };
  return <div ref={shellRef} className="oh-game-preview-shell" data-state={loadError ? "error" : building ? "building" : loaded ? "ready" : "loading"}>
    <div className="oh-game-preview-status">
      <span className="oh-game-runtime-state" role="status" aria-live="polite" title={runtimeState}><i aria-hidden /><em>{runtimeState}</em></span>
      <div>
        {pending && !building && <button type="button" onClick={reload}>载入新版本</button>}
        <button className="oh-game-reload" type="button" onClick={refresh} aria-label="重新载入游戏"><span aria-hidden>↻</span><b>刷新</b></button>
        <button ref={fullscreenButtonRef} type="button" onClick={fullscreen}>全屏试玩</button>
      </div>
    </div>
    <PreviewProbe href={preview.href} onFailed={() => { setLoaded(false); setLoadError(true); }} />
    <iframe
      key={`${project.id}:${loadedVersion}:${String(revision)}`}
      src={preview.href}
      title={`《${project.title}》可试玩预览`}
      sandbox={preview.isolated
        ? "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
        : "allow-scripts allow-forms allow-modals allow-downloads"}
      allow="autoplay; fullscreen; gamepad"
      allowFullScreen
      referrerPolicy="no-referrer"
      onLoad={() => { setLoadError(false); setLoaded(true); }}
      onError={() => { setLoaded(false); setLoadError(true); }}
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); }}
    />
    <div className="oh-game-focus-hint" data-focused={focused || undefined}>{focused ? "游戏正在接收键鼠输入" : "点击画面进入试玩"}</div>
  </div>;
}

function GameDesign({
  project,
  files,
  selected,
  sessionId,
  onSelect
}: {
  readonly project: GameProject;
  readonly files: readonly WorkspaceFile[];
  readonly selected: string | undefined;
  readonly sessionId: string;
  readonly onSelect: (path: string) => void;
}) {
  const documents = useMemo(() => files.filter((file) => file.path.startsWith(`${project.root}/`) && (
    /\.(?:md|txt|json|jsonl|html|css|[cm]?js|tsx?|jsx)$/iu.test(file.path)
  )), [files, project.root]);
  const preferred = selected !== undefined && documents.some((file) => file.path === selected)
    ? selected
    : documents.find((file) => file.path === `${project.root}/PRODUCT_BRIEF.md`)?.path ?? documents[0]?.path;
  const [path, setPath] = useState(preferred);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [readRevision, setReadRevision] = useState(0);
  const version = documents.find((file) => file.path === path)?.version;
  useEffect(() => { setPath(preferred); }, [preferred, project.id]);
  useEffect(() => {
    if (path === undefined || project.source === "example") { setContent(undefined); return; }
    const controller = new AbortController();
    setContent(undefined);
    setError(undefined);
    void fetch(endpoint("file", sessionId, path), { signal: controller.signal })
      .then((response) => json<FilePayload>(response))
      .then((file) => { if (!controller.signal.aborted) setContent(file.content); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { controller.abort(); };
  }, [path, project.source, readRevision, sessionId, version]);
  if (project.source === "example") return <div className="oh-game-design-empty">
    <strong>内置完整示例</strong>
    <p>《金瓶梅 · 风月总账》的完整可玩构建与 QA 校验结果随插件打包，可直接在左侧试玩。上游的产品简报、分析、概念、设计与源小说不随包分发，可在 novel-to-game 仓库查看完整创作过程。</p>
    <code>novel-to-game/examples/jin-ping-mei</code>
  </div>;
  if (documents.length === 0 || path === undefined) return <div className="oh-game-design-empty">当前项目还没有可检查的设计或源文件。</div>;
  const markdown = path.toLocaleLowerCase().endsWith(".md");
  return <div className="oh-game-design">
    <label>项目文件<select value={path} onChange={(event) => {
      setPath(event.target.value);
      onSelect(event.target.value);
    }}>{documents.map((file) => <option value={file.path} key={file.path}>{file.path.slice(project.root.length + 1)}</option>)}</select></label>
    {error !== undefined ? <div className="oh-story-error" role="alert">{error}<button type="button" onClick={() => { setReadRevision((value) => value + 1); }}>重试</button></div>
      : content === undefined ? <div className="oh-game-design-empty">正在载入文件…</div>
        : markdown ? <MarkdownPreview content={content} label={path} />
          : <pre className="oh-game-source" aria-label={`${path} 源码`}>{content}</pre>}
  </div>;
}

function GameStudio({
  sessionId,
  workspace,
  building,
  selected,
  gameTab,
  gameProjectId,
  hidden,
  onGameTab,
  onGameProject,
  workbenches,
  paneId,
  labelledBy,
  onWorkbench,
  onCollapse,
  onRefresh,
  onSelect
}: {
  readonly sessionId: string;
  readonly workspace: WorkspacePayload;
  readonly building: boolean;
  readonly selected: string | undefined;
  readonly gameTab: WorkbenchMemory["gameTab"];
  readonly gameProjectId: string | undefined;
  readonly hidden: boolean;
  readonly onGameTab: (tab: WorkbenchMemory["gameTab"]) => void;
  readonly onGameProject: (id: string) => void;
  readonly workbenches: readonly WorkbenchMode[];
  readonly paneId: string;
  readonly labelledBy: string;
  readonly onWorkbench: (mode: WorkbenchMode) => void;
  readonly onCollapse: () => void;
  readonly onRefresh: () => void;
  readonly onSelect: (path: string) => void;
}) {
  const project = workspace.games.find((value) => value.id === gameProjectId) ?? workspace.games[0];
  const studioRef = useRef<HTMLElement>(null);
  const tabsId = useId();
  useLayoutEffect(() => {
    const studio = studioRef.current;
    if (studio === null) return;
    const publishWidth = () => {
      studio.toggleAttribute("data-oh-game-narrow", studio.clientWidth <= 540);
    };
    publishWidth();
    const observer = new ResizeObserver(publishWidth);
    observer.observe(studio);
    return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (project !== undefined && project.id !== gameProjectId) onGameProject(project.id);
  }, [gameProjectId, onGameProject, project]);
  if (project === undefined) return <main ref={studioRef} id={paneId} className="oh-game-studio" role="tabpanel" aria-labelledby={labelledBy} hidden={hidden}><div className="oh-game-design-empty">游戏能力正在载入…</div></main>;
  const tabs = ["preview", "design"] as const;
  return <main ref={studioRef} id={paneId} className="oh-game-studio" data-source={project.source} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden}>
    <header className="oh-game-toolbar">
      <div className="oh-workbench-cluster">
        {workbenches.length > 1 && <div className="oh-game-mode-tabs" role="tablist" aria-label="创作工作台">
          {workbenches.map((mode) => <button
            type="button"
            role="tab"
            key={mode}
            aria-selected={mode === "game"}
            tabIndex={mode === "game" ? 0 : -1}
            onKeyDown={(event) => { handleTabKey(event, workbenches, "game", onWorkbench); }}
            onClick={() => { onWorkbench(mode); }}
          >{workbenchLabel(mode)}</button>)}
        </div>}
        <button className="oh-workbench-refresh" type="button" title="刷新项目文件" aria-label="刷新项目文件" onClick={onRefresh}>↻</button>
        <button className="oh-workbench-collapse" type="button" title="收起创作工作台" aria-label="收起创作工作台" onClick={onCollapse}>×</button>
      </div>
      <label className="oh-game-project" title="切换项目将重新载入试玩"><span>游戏项目</span><select aria-label="游戏项目；切换将重新载入试玩" value={project.id} onChange={(event) => { onGameProject(event.target.value); }}>
        {workspace.games.some((item) => item.source === "workspace") && <optgroup label="我的项目">{workspace.games.filter((item) => item.source === "workspace").map((item) => <option value={item.id} key={item.id}>{`我的项目 · ${item.title}`}</option>)}</optgroup>}
        {workspace.games.some((item) => item.source === "example") && <optgroup label="内置示例">{workspace.games.filter((item) => item.source === "example").map((item) => <option value={item.id} key={item.id}>{`内置示例 · ${item.title}`}</option>)}</optgroup>}
      </select></label>
      <div className="oh-game-tabs" role="tablist" aria-label="游戏工作台">
        {tabs.map((tab) => <button
          key={tab}
          type="button"
          role="tab"
          tabIndex={gameTab === tab ? 0 : -1}
          aria-selected={gameTab === tab}
          id={`${tabsId}-${tab}-tab`}
          aria-controls={`${tabsId}-${tab}-panel`}
          onKeyDown={(event) => { handleTabKey(event, tabs, gameTab, onGameTab); }}
          onClick={() => { onGameTab(tab); }}
        >{tab === "preview" ? "试玩" : project.source === "example" ? "说明" : "项目文件"}</button>)}
      </div>
    </header>
    <div className="oh-game-panels">
      <div className="oh-game-panel" role="tabpanel" id={`${tabsId}-preview-panel`} aria-labelledby={`${tabsId}-preview-tab`} hidden={gameTab !== "preview"}>
        <GamePreview key={`${project.id}:${String(project.previewReady)}`} project={project} building={building} />
      </div>
      <div className="oh-game-panel" role="tabpanel" id={`${tabsId}-design-panel`} aria-labelledby={`${tabsId}-design-tab`} hidden={gameTab !== "design"}>
        <GameDesign project={project} files={workspace.files} selected={selected} sessionId={sessionId} onSelect={onSelect} />
      </div>
    </div>
  </main>;
}

function CreativeWorkbench({
  sessionId,
  runningCalls,
  partial,
  settledMutation,
  sessionRunning,
  productionQueue,
  productionIntents,
  sendProductionPrompt,
  cancelProduction,
  removeQueuedProduction,
  workspace,
  error,
  workspaceLoading,
  reload,
  open,
  retryDraftBackup,
  useStore,
  useInput,
  inputActions,
  actions
}: {
  readonly sessionId: string;
  readonly runningCalls: readonly RunningToolCall[];
  readonly partial: PartialAssistant | null;
  readonly settledMutation: string | undefined;
  readonly sessionRunning: boolean;
  readonly productionQueue: readonly ProductionQueueEntry[];
  readonly productionIntents: readonly SettledProductionIntent[];
  readonly workspace: WorkspacePayload | undefined;
  readonly error: string | undefined;
  readonly workspaceLoading: boolean;
  readonly reload: () => void;
  readonly open: boolean;
  readonly retryDraftBackup: () => void;
} & Pick<WorkbenchSlotProps, "useStore" | "useInput" | "inputActions" | "actions" | "sendProductionPrompt" | "cancelProduction" | "removeQueuedProduction">) {
  const composerDraft = useInput((input) => input.draft);
  const inputPhase = useInput((input) => input.phase);
  const activities = useMemo(
    () => fileMutations(runningCalls, partial),
    [partial, runningCalls]
  );
  const normalizedActivities = useMemo(() => activities.flatMap((activity) => {
    const path = creativeRelativePath(activity.path, workspace?.cwd);
    return path === undefined ? [] : [{ activity, path }];
  }), [activities, workspace?.cwd]);
  const primaryActivity = normalizedActivities.at(-1);
  const activityPaths = useMemo(() => new Set(normalizedActivities.map((value) => value.path)), [normalizedActivities]);
  const activity = primaryActivity?.activity;
  const activityPath = primaryActivity?.path;
  const workbench = useStore((memory) => memory.workbench);
  const setWorkbench = actions.setWorkbench;
  const gameTab = useStore((memory) => memory.gameTab);
  const setGameTab = actions.setGameTab;
  const gameProjectId = useStore((memory) => memory.gameProjectId);
  const setGameProjectId = actions.setGameProjectId;
  const gamePane = useStore((memory) => memory.gamePane);
  const setGamePane = actions.setGamePane;
  const videoTab = useStore((memory) => memory.videoTab);
  const setVideoTab = actions.setVideoTab;
  const videoProjectId = useStore((memory) => memory.videoProjectId);
  const setVideoProjectId = actions.setVideoProjectId;
  const videoPane = useStore((memory) => memory.videoPane);
  const setVideoPane = actions.setVideoPane;
  const selected = useStore((memory) => memory.selected);
  const lastSelected = useStore((memory) => memory.lastSelected);
  const setSelected = actions.setSelected;
  const buffers = useStore((memory) => memory.buffers);
  const draftError = useStore((memory) => memory.draftError);
  const recoveredDrafts = useStore((memory) => memory.recoveredDrafts);
  const draftSessionReady = useStore((memory) => memory.draftSessionReady);
  const draftSessionError = useStore((memory) => memory.draftSessionError);
  const setBuffers = actions.setBuffers;
  const buffersRef = useRef<Record<string, FileBuffer>>({});
  const expanded = useStore((memory) => memory.expanded);
  const setExpanded = actions.setExpanded;
  const productionSection = useStore((memory) => memory.productionSection);
  const setProductionSection = actions.setProductionSection;
  const productionSelectedIds = useStore((memory) => memory.productionSelectedIds);
  const productionJobsByEpisode = useStore((memory) => memory.productionJobs);
  const productionSelectionsByEpisode = useStore((memory) => memory.productionSelections);
  const productionReferencesByEpisode = useStore((memory) => memory.productionReferences);
  const productionSequenceByEpisode = useStore((memory) => memory.productionSequence);
  const productionCanvasByEpisode = useStore((memory) => memory.productionCanvas);
  const productionZoomByEpisode = useStore((memory) => memory.productionZoom);
  const productionIntentCalls = useStore((memory) => memory.productionIntentCalls);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const setWorkbenchPreference = actions.setWorkbenchPreference;
  const applyWorkbenchPreference = useCallback((preference: WorkbenchPreference): void => {
    setWorkbenchPreference(preference);
    writeWorkbenchPreference(workbenchPreferenceStorage(), workspace?.cwd, preference);
  }, [setWorkbenchPreference, workspace?.cwd]);
  const compactTabsId = useId();
  const compactStudioId = `${compactTabsId}-studio-panel`;
  const compactVideoStudioId = `${compactTabsId}-video-studio-panel`;
  const compactChatId = `${compactTabsId}-chat-panel`;
  const navRef = useRef<HTMLElement>(null);
  const activityBases = useRef(new Map<string, { readonly path: string; readonly base: string }>());
  const previousSignals = useRef<ReadonlySet<string>>(new Set());
  const previousSettledMutation = useRef(settledMutation);
  const saveLocks = useRef(new Set<string>());
  const [fileLoadErrors, setFileLoadErrors] = useState<Record<string, string | undefined>>({});
  const [fileReadRevision, setFileReadRevision] = useState(0);
  const buffer = selected === undefined ? undefined : buffers[selected];
  const selectedFile = workspace?.files.find((file) => file.path === selected);
  const selectedMedia = selectedFile?.kind === "media";
  const dirty = buffer?.source === "human" && buffer.content !== buffer.saved;
  const saving = buffer?.saving === true;
  const fileError = (selected === undefined ? undefined : fileLoadErrors[selected]) ?? buffer?.error;
  const conflict = buffer?.conflict;
  const selectedLower = selected?.toLocaleLowerCase();
  const markdown = selectedLower?.endsWith(".md") === true;
  const wechatPreviewable = workbench === "wechat" && (markdown || selectedLower?.endsWith(".html") === true);
  const readOnlyReference = selected !== undefined && isWechatReferencePath(selected);
  const jsonl = selectedLower?.endsWith(".jsonl") === true;
  const structured = jsonl || selectedLower?.endsWith(".json") === true;
  const previewable = markdown || jsonl || wechatPreviewable;
  const episodeDirectory = episodeDirectoryForPath(selected);
  const productionAvailable = selected !== undefined && isCreatorDocumentPath(selected) && episodeDirectory !== undefined;
  const editorModes = productionAvailable ? EDITOR_MODES : EDITOR_MODES.filter((mode) => mode !== "production");
  const episodeDocumentPaths = useMemo(
    () => episodeDirectory === undefined ? [] : creatorDocumentPaths(workspace?.files.filter((file) => file.kind === "text") ?? [], episodeDirectory),
    [episodeDirectory, workspace?.files]
  );
  const episodeDocuments = useMemo(() => Object.fromEntries(episodeDocumentPaths.flatMap((path) => {
    const current = buffers[path];
    return current === undefined || current.missing === true ? [] : [[path, current.content] as const];
  })), [buffers, episodeDocumentPaths]);
  const episodeProduction = useMemo(
    () => episodeDirectory === undefined ? undefined : parseEpisodeProduction(episodeDocuments, episodeDirectory),
    [episodeDirectory, episodeDocuments]
  );
  const productionLibrary = useMemo(() => (workspace?.files ?? []).flatMap((file): ProductionMediaVersion[] => {
    if (file.kind !== "media" || file.mimeType?.startsWith("audio/") === true) return [];
    if (!file.path.startsWith("剧集/") && !file.path.startsWith("交付/")) return [];
    const targetId = file.path.toLocaleUpperCase().match(/(?:SHOT|IMG|MOTION|VISUAL)-[A-Z0-9-]+/u)?.[0] ?? file.path.split("/").at(-2) ?? "PROJECT-MEDIA";
    return [{
      id: `workspace:${file.path}:${file.version}`,
      targetId,
      kind: file.mimeType?.startsWith("image/") === true ? "image" : "video",
      url: endpoint("media", sessionId, file.path),
      path: file.path
    }];
  }), [sessionId, workspace?.files]);
  const productionVersions = useMemo(() => {
    if (episodeProduction === undefined) return [];
    const episodeName = episodeProduction.episodeDirectory.split("/").at(-1) ?? "";
    const knownTargets = [
      ...episodeProduction.shots.map((shot) => shot.id),
      ...episodeProduction.assets.map((asset) => asset.id),
      ...episodeProduction.visualAssets.map((asset) => asset.id),
      ...episodeProduction.motions.map((motion) => motion.id)
    ].sort((left, right) => right.length - left.length);
    const motionTargets = new Map(episodeProduction.motions.flatMap((motion) => motion.shotId === undefined ? [] : [[motion.id, motion.shotId] as const]));
    const fromWorkspace = productionLibrary.flatMap((version) => {
      if (version.path === undefined || (!version.path.startsWith(`${episodeProduction.episodeDirectory}/`) && !version.path.startsWith(`交付/${episodeName}/`))) return [];
      const matched = mediaTargetFromPath(version.path, knownTargets);
      // Drama Skills 0.7 renders the assembled cut into 制作成果/成片/; earlier native
      // compositions wrote 成片-<job>.mp4 beside the per-shot results.
      const composition = /(?:^|\/)成片-[^/]+\.mp4$/iu.test(version.path)
        || /(?:^|\/)制作成果\/成片\//u.test(version.path);
      if (matched === undefined && !composition) return [];
      const targetId = matched === undefined ? episodeProduction.episodeDirectory : motionTargets.get(matched) ?? matched;
      return [{ ...version, targetId }];
    });
    const byId = new Map<string, ProductionMediaVersion>();
    for (const version of fromWorkspace) byId.set(version.id, version);
    return [...byId.values()];
  }, [episodeProduction, productionLibrary]);
  const productionSelectedId = episodeDirectory === undefined ? undefined : productionSelectedIds[episodeDirectory];
  const productionJobs = episodeDirectory === undefined ? [] : productionJobsByEpisode[episodeDirectory] ?? [];
  const productionSelections = episodeDirectory === undefined ? {} : productionSelectionsByEpisode[episodeDirectory] ?? {};
  const productionReferences = episodeDirectory === undefined ? {} : productionReferencesByEpisode[episodeDirectory] ?? {};
  const productionSequence = episodeDirectory === undefined ? [] : productionSequenceByEpisode[episodeDirectory] ?? [];
  const productionCanvas = episodeDirectory === undefined ? {} : productionCanvasByEpisode[episodeDirectory] ?? {};
  const productionZoom = episodeDirectory === undefined ? .65 : productionZoomByEpisode[episodeDirectory] ?? .65;
  const setProductionSelectedId = useCallback((selectedId: string | undefined) => {
    if (episodeDirectory !== undefined) actions.setProductionSelectedIds((current) => ({ ...current, [episodeDirectory]: selectedId }));
  }, [actions, episodeDirectory]);
  const setProductionJobs = useCallback((jobs: ProductionJob[]) => {
    if (episodeDirectory !== undefined) actions.setProductionJobs((current) => ({ ...current, [episodeDirectory]: jobs }));
  }, [actions, episodeDirectory]);
  const setProductionSelections = useCallback((selections: Record<string, string>) => {
    if (episodeDirectory !== undefined) actions.setProductionSelections((current) => ({ ...current, [episodeDirectory]: selections }));
  }, [actions, episodeDirectory]);
  const setProductionReferences = useCallback((references: Record<string, string[]>) => {
    if (episodeDirectory !== undefined) actions.setProductionReferences((current) => ({ ...current, [episodeDirectory]: references }));
  }, [actions, episodeDirectory]);
  const setProductionSequence = useCallback((sequence: ProductionSequenceItem[]) => {
    if (episodeDirectory !== undefined) actions.setProductionSequence((current) => ({ ...current, [episodeDirectory]: sequence }));
  }, [actions, episodeDirectory]);
  const setProductionCanvas = useCallback((canvas: Record<string, CanvasPoint>) => {
    if (episodeDirectory !== undefined) actions.setProductionCanvas((current) => ({ ...current, [episodeDirectory]: canvas }));
  }, [actions, episodeDirectory]);
  const setProductionZoom = useCallback((zoom: number) => {
    if (episodeDirectory !== undefined) actions.setProductionZoom((current) => ({ ...current, [episodeDirectory]: zoom }));
  }, [actions, episodeDirectory]);
  const editorMode = useStore((memory) => memory.editorMode);
  const setEditorMode = actions.setEditorMode;
  const modeSelection = useRef(selected);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorPositions = useRef(new Map<string, { readonly scrollTop: number; readonly selectionStart: number; readonly selectionEnd: number }>());
  const editorReady = buffer !== undefined && buffer.missing !== true;
  const activeGame = workspace?.games.find((project) => project.id === gameProjectId) ?? workspace?.games[0];
  const activeVideo = workspace?.videos.find((project) => project.id === videoProjectId) ?? workspace?.videos[0];
  const gameBuilding = activeGame?.source === "workspace" && normalizedActivities.some(({ path }) => path.startsWith(`${activeGame.root}/`));
  const videoBuilding = activeVideo !== undefined && normalizedActivities.some(({ path }) => path.startsWith(`${activeVideo.root}/`));

  useLayoutEffect(() => { buffersRef.current = buffers; }, [buffers]);

  const rememberEditorPosition = useCallback((): void => {
    const element = textareaRef.current;
    if (element === null || selected === undefined || element.getAttribute("aria-label") !== selected) return;
    editorPositions.current.set(selected, {
      scrollTop: element.scrollTop,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd
    });
  }, [selected]);

  useLayoutEffect(() => {
    if (editorMode !== "source" || selected === undefined || !editorReady) return;
    const element = textareaRef.current;
    const position = editorPositions.current.get(selected);
    if (element === null || position === undefined) return;
    const end = Math.min(position.selectionEnd, element.value.length);
    element.setSelectionRange(Math.min(position.selectionStart, end), end);
    element.scrollTop = position.scrollTop;
  }, [editorMode, editorReady, selected]);

  const expandPath = useCallback((path: string): void => {
    const segments = path.split("/");
    const ancestors = [groupForPath(path)];
    for (let index = 1; index < segments.length - 1; index += 1) ancestors.push(segments.slice(0, index + 1).join("/"));
    setExpanded((current) => {
      const next = { ...current };
      for (const ancestor of ancestors) next[ancestor] = true;
      return next;
    });
  }, []);

  const revealPath = useCallback((path: string): void => {
    rememberEditorPosition();
    const nextWorkbench = workbenchModeForPath(path) ?? "story";
    setWorkbench(nextWorkbench);
    if (nextWorkbench === "game" && !path.includes("/build/app/")) setGameTab("design");
    setSelected(path);
    expandPath(path);
  }, [expandPath, rememberEditorPosition]);

  useEffect(() => {
    if (workspace === undefined) return;
    const pending = productionIntents.filter(({ callId }) => productionIntentCalls[callId] !== true);
    if (pending.length === 0) return;
    for (const { intent } of pending) {
      if (intent.action === "open_section" || intent.action === "focus_target") {
        const documentPath = ["分镜.md", "图片提示词.md", "视觉设定.md", "剧本.md", "视频提示词.md"]
          .map((name) => `${intent.episode}/${name}`)
          .find((path) => workspace.files.some((file) => file.path === path));
        if (documentPath !== undefined) {
          setWorkbench("drama");
          setSelected(documentPath);
          expandPath(documentPath);
          globalThis.setTimeout(() => { setEditorMode("production"); }, 0);
        }
      }
      if (intent.action === "open_section") setProductionSection(intent.section ?? "shots");
      else if (intent.action === "focus_target") {
        actions.setProductionSelectedIds((current) => ({ ...current, [intent.episode]: intent.targetId }));
        setProductionSection(intent.section ?? (intent.targetId?.startsWith("SHOT-") === true ? "shots" : "assets"));
      } else if (intent.action === "set_sequence") {
        actions.setProductionSequence((current) => ({
          ...current,
          [intent.episode]: (intent.shotIds ?? []).map((shotId) => ({ shotId }))
        }));
      } else if (intent.action === "track_job" && intent.jobId !== undefined && intent.targetId !== undefined && intent.jobKind !== undefined) {
        const { jobId, targetId, jobKind } = intent;
        actions.setProductionJobs((current) => {
          const jobs = current[intent.episode] ?? [];
          if (jobs.some((job) => job.id === jobId)) {
            return {
              ...current,
              [intent.episode]: jobs.map((job) => job.id === jobId ? {
                ...job,
                targetId,
                kind: jobKind,
                status: "running",
                progress: Math.max(10, job.progress),
                prompt: intent.prompt ?? job.prompt,
                expectedOutputs: intent.expectedOutputs ?? job.expectedOutputs,
                error: undefined
              } : job)
            };
          }
          return {
            ...current,
            [intent.episode]: [...jobs, {
              ...createPendingJob({
                id: jobId,
                targetId,
                kind: jobKind,
                prompt: intent.prompt ?? "",
                expectedOutputs: intent.expectedOutputs
              }),
              status: "running",
              progress: 10
            }]
          };
        });
      }
    }
    actions.setProductionIntentCalls((current) => ({
      ...current,
      ...Object.fromEntries(pending.map(({ callId }) => [callId, true]))
    }));
  }, [actions, expandPath, productionIntentCalls, productionIntents, setEditorMode, setProductionSection, setSelected, setWorkbench, workspace]);

  // Latch first entry into the game workbench: before that the Studio must not mount, or every
  // session downloads and runs the bundled example in a display:none iframe. Once mounted it
  // stays mounted so the running game survives later navigation.
  const openedGame = useRef(false);
  if (workbench === "game") openedGame.current = true;
  const gameStudioMounted = openedGame.current;
  const openedVideo = useRef(false);
  if (workbench === "video") openedVideo.current = true;
  const videoStudioMounted = openedVideo.current;

  const followAgentPath = useCallback((path: string): void => {
    expandPath(path);
    const current = selected === undefined ? undefined : buffersRef.current[selected];
    const preserveFocusedDraft = path !== selected
      && current?.source === "human"
      && current.content !== current.saved
      && surfaceRef.current?.ownerDocument.activeElement === textareaRef.current;
    if (preserveFocusedDraft) return;
    // The editor textarea is not mounted in the Game Studio, so the draft guard above can never
    // fire there. Never preempt a running game: agent writes may expand the tree, not navigate.
    if ((workbench === "game" && gameTab === "preview") || (workbench === "video" && videoTab === "preview")) return;
    revealPath(path);
  }, [expandPath, gameTab, revealPath, selected, videoTab, workbench]);

  useEffect(() => {
    if (activityPath !== undefined && activityPath === selected && !selectedMedia) setEditorMode("source");
  }, [activityPath, selected, selectedMedia]);

  useEffect(() => {
    if (modeSelection.current === selected) return;
    modeSelection.current = selected;
    setEditorMode(selected !== undefined && (activityPaths.has(selected) || isDirtyDraft(buffersRef.current[selected])) ? "source" : selectedMedia || previewable ? "preview" : "source");
  }, [activityPaths, previewable, selected, selectedMedia]);

  useEffect(() => {
    if (workspaceLoading) return;
    if (activityPath !== undefined) return;
    if (selected !== undefined && (
      (workspace?.files.some((file) => file.path === selected) ?? false)
      || buffers[selected] !== undefined
    ) && workbenchModeForPath(selected) === workbench) return;
    setSelected(workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, workbench));
  }, [activityPath, buffers, selected, workbench, workspace, workspaceLoading]);

  useEffect(() => {
    if (workspace === undefined || workspaceLoading) return;
    const paths = new Set(workspace.files.map((file) => file.path));
    setBuffers((current) => {
      let changed = false;
      const next = { ...current };
      for (const [path, value] of Object.entries(current)) {
        if (paths.has(path) || activityPaths.has(path)) continue;
        if (value.source === "human" && value.content !== value.saved) {
          if (value.missing !== true) {
            next[path] = { ...value, missing: true, error: "文件已从 workspace 移除。本地草稿仍保留，可复制后放弃草稿。" };
            changed = true;
          }
        } else {
          delete next[path];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activityPaths, workspace, workspaceLoading]);

  useEffect(() => {
    if (selected === undefined || selectedMedia || activityPaths.has(selected)) return;
    if (!(workspace?.files.some((file) => file.path === selected) ?? false)) return;
    const controller = new AbortController();
    const previousVersion = buffersRef.current[selected]?.version;
    setFileLoadErrors((current) => ({ ...current, [selected]: undefined }));
    setBuffers((current) => {
      const existing = current[selected];
      return existing === undefined ? current : { ...current, [selected]: { ...existing, error: undefined } };
    });
    void fetch(endpoint("file", sessionId, selected), { signal: controller.signal })
      .then((response) => json<FilePayload>(response))
      .then((file) => {
        if (controller.signal.aborted) return;
        setBuffers((current) => {
          const existing = current[file.path];
          if (existing?.saving === true || existing?.version !== previousVersion) return current;
          if (existing?.source === "human" && existing.content !== existing.saved) {
            if (existing.content === file.content) return {
              ...current,
              [file.path]: { content: file.content, saved: file.content, source: "disk", version: file.version }
            };
            if (existing.version === file.version || existing.saved === file.content) return {
              ...current,
              [file.path]: { ...existing, version: file.version, missing: false, error: undefined, conflict: undefined }
            };
            return {
              ...current,
              [file.path]: {
                ...existing,
                missing: false,
                error: undefined,
                conflict: {
                  message: `${file.path} 已在磁盘上更新；你的本地草稿没有被覆盖。`,
                  theirs: file.content,
                  theirsVersion: file.version
                }
              }
            };
          }
          return {
            ...current,
            [file.path]: { content: file.content, saved: file.content, source: "disk", version: file.version }
          };
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setFileLoadErrors((current) => ({ ...current, [selected]: message }));
        setBuffers((current) => {
          const existing = current[selected];
          return existing === undefined ? current : {
            ...current,
            [selected]: { ...existing, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      });
    return () => { controller.abort(); };
  }, [activityPaths, fileReadRevision, selected, selectedMedia, sessionId, workspace?.files]);

  useEffect(() => {
    if (!productionAvailable) return;
    const excluded = new Set(activityPaths);
    if (selected !== undefined) excluded.add(selected);
    const requests = productionDocumentRequests(episodeDocumentPaths, workspace?.files ?? [], buffersRef.current, excluded);
    if (requests.length === 0) return;
    const controller = new AbortController();
    void Promise.allSettled(requests.map(({ path }) => fetch(endpoint("file", sessionId, path), { signal: controller.signal }).then((response) => json<FilePayload>(response))))
      .then((results) => {
        if (controller.signal.aborted) return;
        setFileLoadErrors((current) => {
          if (controller.signal.aborted) return current;
          const next = { ...current };
          for (const [index, result] of results.entries()) {
            const request = requests[index];
            if (request === undefined) continue;
            const existing = buffersRef.current[request.path];
            if (existing?.saving === true || existing?.version !== request.previousVersion) continue;
            const reason: unknown = result.status === "rejected" ? result.reason : undefined;
            next[request.path] = result.status === "fulfilled" ? undefined : reason instanceof Error ? reason.message : String(reason);
          }
          return next;
        });
        setBuffers((current) => {
          if (controller.signal.aborted) return current;
          return applyProductionDocumentResults(current, requests, results);
        });
      });
    return () => { controller.abort(); };
  }, [activityPaths, episodeDocumentPaths, productionAvailable, selected, sessionId, workspace?.files]);

  useEffect(() => {
    if (normalizedActivities.length === 0) return;
    for (const { path } of normalizedActivities) expandPath(path);
    if (activityPath !== undefined) followAgentPath(activityPath);
    setBuffers((current) => {
      let next = current;
      for (const { activity: currentActivity, path } of normalizedActivities) {
        const existing = next[path];
        if (existing?.source === "human" && existing.content !== existing.saved) {
          next = {
            ...next,
            [path]: {
              ...existing,
              conflict: { message: `${path} 正由 Agent 修改；你的本地草稿已锁定，不会被覆盖。` }
            }
          };
          continue;
        }
        let basis = activityBases.current.get(currentActivity.callId);
        if (basis === undefined || basis.path !== path) {
          basis = { path, base: existing?.content ?? "" };
          activityBases.current.set(currentActivity.callId, basis);
        }
        const preview = previewMutation(currentActivity, basis.base);
        if (preview === undefined || (existing?.source === "agent" && existing.content === preview)) continue;
        next = {
          ...next,
          [path]: {
            content: preview,
            saved: existing?.saved ?? "",
            source: "agent",
            version: existing?.version ?? ""
          }
        };
      }
      return next;
    });
  }, [activityPath, expandPath, followAgentPath, normalizedActivities]);

  useEffect(() => {
    const signals = new Set(mutatingCallIds(runningCalls));
    for (const { activity: currentActivity } of normalizedActivities) signals.add(currentActivity.callId.split(":", 1)[0] ?? currentActivity.callId);
    const settled = [...previousSignals.current].some((callId) => !signals.has(callId));
    for (const callId of activityBases.current.keys()) {
      if (!signals.has(callId.split(":", 1)[0] ?? callId)) activityBases.current.delete(callId);
    }
    previousSignals.current = signals;
    if (!settled) return;
    reload();
  }, [normalizedActivities, reload, runningCalls]);

  useEffect(() => {
    if (settledMutation === undefined || settledMutation === previousSettledMutation.current) return;
    // The signal carries an absolute path, so creativeRelativePath cannot resolve it until the
    // workspace (and its cwd) has loaded. Consuming the signal first would burn it: the effect
    // re-runs when cwd arrives, but the guard above then short-circuits and the agent's file is
    // never selected. Wait for cwd instead of dropping the follow.
    if (workspace?.cwd === undefined) return;
    previousSettledMutation.current = settledMutation;
    const path = creativeRelativePath(settledMutation.slice(settledMutation.indexOf("\0") + 1), workspace.cwd);
    if (path !== undefined) followAgentPath(path);
    reload();
  }, [followAgentPath, reload, settledMutation, workspace?.cwd]);

  useEffect(() => {
    if (selected === undefined) return;
    for (const button of navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-file-path]") ?? []) {
      if (button.dataset.filePath === selected) {
        button.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [selected]);

  useEffect(() => {
    if (!open || normalizedActivities.length > 0 || workspace === undefined) return;
    const sessionSurface = surfaceRef.current?.parentElement;
    if (sessionSurface === undefined || sessionSurface === null) return;
    const knownPaths = new Set(workspace.files.map((file) => file.path));
    const followOfficialFileLink = (event: MouseEvent): void => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const control = origin.closest<HTMLElement>("button, a");
      if (control === null || control.closest(".oh-story-split-surface") !== null) return;
      const candidates = [control.title, control.getAttribute("aria-label"), control.textContent];
      for (const candidate of candidates) {
        const path = creativeRelativePath(candidate?.trim().replace(/^(?:Open|打开)\s+/u, ""), workspace.cwd);
        if (path === undefined || !knownPaths.has(path)) continue;
        event.preventDefault();
        event.stopPropagation();
        revealPath(path);
        break;
      }
    };
    sessionSurface.addEventListener("click", followOfficialFileLink, true);
    return () => { sessionSurface.removeEventListener("click", followOfficialFileLink, true); };
  }, [normalizedActivities.length, open, revealPath, workspace]);

  useEffect(() => {
    if (workbench !== "game" && workbench !== "video") return;
    const surface = surfaceRef.current;
    const sessionSurface = surface?.parentElement;
    const chat = Array.from(sessionSurface?.children ?? []).find((child) => child !== surface && child instanceof HTMLElement);
    if (!(chat instanceof HTMLElement)) return;
    const previous = {
      id: chat.id,
      role: chat.getAttribute("role"),
      labelledBy: chat.getAttribute("aria-labelledby")
    };
    chat.id = compactChatId;
    chat.setAttribute("role", "tabpanel");
    chat.setAttribute("aria-labelledby", `${compactTabsId}-chat-tab`);
    return () => {
      chat.id = previous.id;
      if (previous.role === null) chat.removeAttribute("role");
      else chat.setAttribute("role", previous.role);
      if (previous.labelledBy === null) chat.removeAttribute("aria-labelledby");
      else chat.setAttribute("aria-labelledby", previous.labelledBy);
    };
  }, [compactChatId, compactTabsId, workbench]);

  const savePath = useCallback(async (path: string) => {
    if (saveLocks.current.has(path)) return;
    const submitted = buffersRef.current[path];
    if (submitted === undefined || submitted.missing === true || submitted.content === submitted.saved) return;
    saveLocks.current.add(path);
    setBuffers((current) => {
      const existing = current[path];
      return existing === undefined ? current : { ...current, [path]: { ...existing, saving: true, error: undefined } };
    });
    try {
      const file = await json<FilePayload>(await fetch(endpoint("file", sessionId, path), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: submitted.content, baseVersion: submitted.version })
      }));
      setBuffers((current) => {
        const latest = current[path];
        if (latest === undefined) return current;
        const unchanged = latest.content === submitted.content;
        return {
          ...current,
          [path]: {
            content: unchanged ? file.content : latest.content,
            saved: file.content,
            source: unchanged ? "disk" : "human",
            version: file.version,
            saving: false
          }
        };
      });
      reload();
    } catch (reason) {
      if (reason instanceof WorkspaceRequestError && reason.status === 412) {
        try {
          const theirs = await json<FilePayload>(await fetch(endpoint("file", sessionId, path)));
          setBuffers((current) => {
            const latest = current[path];
            if (latest === undefined) return current;
            return {
              ...current,
              [path]: {
                ...latest,
                saving: false,
                conflict: {
                  message: `${path} 已在磁盘上更新；请选择保留哪一版。`,
                  theirs: theirs.content,
                  theirsVersion: theirs.version
                }
              }
            };
          });
        } catch (refreshError) {
          setBuffers((current) => {
            const existing = current[path];
            return existing === undefined ? current : {
              ...current,
              [path]: { ...existing, saving: false, error: refreshError instanceof Error ? refreshError.message : String(refreshError) }
            };
          });
        }
      } else {
        setBuffers((current) => {
          const existing = current[path];
          return existing === undefined ? current : {
            ...current,
            [path]: { ...existing, saving: false, error: reason instanceof Error ? reason.message : String(reason) }
          };
        });
      }
    } finally {
      saveLocks.current.delete(path);
    }
  }, [reload, sessionId]);

  useEffect(() => {
    if (!open) return;
    const saveShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "s") return;
      event.preventDefault();
      if (selected !== undefined) void savePath(selected);
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => { globalThis.removeEventListener("keydown", saveShortcut); };
  }, [open, savePath, selected]);

  const groups = useMemo(() => {
    const value = new Map<string, WorkspaceFile[]>();
    const all = [...(workspace?.files ?? [])].filter((file) => workbenchModeForPath(file.path) === workbench);
    if (activityPath !== undefined && !all.some((file) => file.path === activityPath)) all.push({ path: activityPath, bytes: 0, version: "", kind: "text" });
    all.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    for (const file of all) {
      const directory = groupForPath(file.path);
      const files = value.get(directory) ?? [];
      files.push(file);
      value.set(directory, files);
    }
    const order = GROUP_ORDER[workbench];
    return [...value.entries()].sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex)
        || left.localeCompare(right, "zh-Hans-CN");
    });
  }, [activityPath, workbench, workspace]);

  const selectWorkbench = (next: WorkbenchMode): void => {
    if (next === workbench) return;
    rememberEditorPosition();
    setWorkbench(next);
    const previous = lastSelected[next];
    const target = previous !== undefined && (workspace?.files.some((file) => file.path === previous) === true || buffers[previous] !== undefined)
      ? previous
      : workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, next);
    setSelected(target);
    if (target !== undefined) expandPath(target);
  };
  const selectEditorMode = (next: WorkbenchMemory["editorMode"]): void => {
    if (next === "preview") rememberEditorPosition();
    setEditorMode(next);
  };
  const navigateProductionTarget = (target: DramaDocumentTarget): void => {
    const content = buffersRef.current[target.path]?.content ?? "";
    const before = content.slice(0, target.offset);
    const approximateScrollTop = Math.max(0, before.split(/\r?\n/u).length * 28 - 96);
    editorPositions.current.set(target.path, { scrollTop: approximateScrollTop, selectionStart: target.offset, selectionEnd: target.offset });
    modeSelection.current = target.path;
    revealPath(target.path);
    setEditorMode("source");
  };
  const selectedLabel = selected ?? `${workbenchLabel(workbench)}工作台`;
  const selectedBasename = selected?.split("/").at(-1) ?? selectedLabel;
  const prepareCreation = (): void => {
    if (inputPhase === "adjudicating" || inputPhase === "submitting") return;
    // Existing text and reference chips belong to the user; only seed an empty composer.
    if (composerDraft.trim().length === 0) inputActions.setDraft(workbench === "wechat" ? "/wechat-article " : workbench === "story" ? "/story-setup " : "/short-drama ");
    const scroller = surfaceRef.current?.closest("[data-conversation-scroll]");
    scroller?.querySelector<HTMLElement>("[data-composer-seat] [data-composer-input]")?.focus();
  };
  const selectedGroup = selected === undefined ? undefined : groupForPath(selected);
  const toggleGroup = (key: string, open: boolean): void => {
    setExpanded((current) => ({ ...current, [key]: open }));
  };
  const resolveConflict = (keepLocal: boolean): void => {
    if (selected === undefined || conflict?.theirs === undefined || conflict.theirsVersion === undefined) return;
    const theirs = conflict.theirs;
    const theirsVersion = conflict.theirsVersion;
    setBuffers((current) => {
      const existing = current[selected];
      if (existing === undefined) return current;
      return {
        ...current,
        [selected]: keepLocal
          ? { ...existing, saved: theirs, version: theirsVersion, source: "human", conflict: undefined }
          : { content: theirs, saved: theirs, source: "disk", version: theirsVersion }
      };
    });
  };
  const downloadDraft = (): void => {
    if (selected === undefined || buffer === undefined) return;
    const url = URL.createObjectURL(new Blob([buffer.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = selected.split("/").at(-1) ?? "draft.txt";
    link.click();
    globalThis.setTimeout(() => { URL.revokeObjectURL(url); }, 1_000);
  };
  const draftErrorMessage = draftError === "busy"
    ? "另一个页面正在备份此会话。请关闭该页面后重试；当前草稿可保存或下载。"
    : draftError === "changed"
    ? "其他页面已更新此会话的草稿备份。当前内容仍保留；请保存或下载有差异的草稿后重试。"
    : draftError === "invalid"
      ? "草稿备份无法读取，原备份仍保留。当前内容请先保存或下载。"
      : "草稿备份失败，浏览器存储可能不可用或已满。当前内容请先保存或下载。";

  if (!open) {
    return <div ref={surfaceRef} className="oh-story-split-surface" data-open="false">
      <style>{styles}</style>
      <nav className="oh-story-launcher oh-story-entry-modes" aria-label="打开创作工作台">
        {WORKBENCH_MODES.map((mode) => <button key={mode} type="button" onClick={() => {
          selectWorkbench(mode);
          applyWorkbenchPreference("open");
        }}>{workbenchLabel(mode)}</button>)}
      </nav>
    </div>;
  }

  return <div ref={surfaceRef} className="oh-story-split-surface" data-open="true" data-workbench={workbench}>
    <style>{styles}</style>
    {(workbench === "game" || workbench === "video") && <div className="oh-game-mobile-switcher" role="tablist" aria-label={workbench === "game" ? "窄屏游戏工作台" : "窄屏视频工作台"}>
      {(["studio", "chat"] as const).map((pane) => <button
        type="button"
        role="tab"
        key={pane}
        id={`${compactTabsId}-${pane}-tab`}
        aria-controls={pane === "chat" ? compactChatId : workbench === "game" ? compactStudioId : compactVideoStudioId}
        aria-selected={(workbench === "game" ? gamePane : videoPane) === pane}
        tabIndex={(workbench === "game" ? gamePane : videoPane) === pane ? 0 : -1}
        onKeyDown={(event) => { handleTabKey(event, ["studio", "chat"] as const, workbench === "game" ? gamePane : videoPane, workbench === "game" ? setGamePane : setVideoPane); }}
        onClick={() => { if (workbench === "game") setGamePane(pane); else setVideoPane(pane); }}
      >{pane === "studio" ? "制作" : "对话"}</button>)}
    </div>}
    {workbench === "game" && workspace === undefined && <main id={compactStudioId} className="oh-game-studio" role="tabpanel" aria-labelledby={`${compactTabsId}-studio-tab`}><div className="oh-game-design-empty">{error ?? "正在连接游戏工作台…"}</div></main>}
    {workspace !== undefined && gameStudioMounted && <GameStudio
          sessionId={sessionId}
          workspace={workspace}
          building={gameBuilding}
          selected={selected}
          gameTab={gameTab}
          gameProjectId={gameProjectId}
          hidden={workbench !== "game"}
          onGameTab={setGameTab}
          onGameProject={setGameProjectId}
          workbenches={WORKBENCH_MODES}
          paneId={compactStudioId}
          labelledBy={`${compactTabsId}-studio-tab`}
          onWorkbench={selectWorkbench}
          onCollapse={() => { applyWorkbenchPreference("closed"); }}
          onRefresh={reload}
          onSelect={revealPath}
        />}
    {workbench === "video" && workspace === undefined && <main id={compactVideoStudioId} className="oh-video-studio" role="tabpanel" aria-labelledby={`${compactTabsId}-studio-tab`}><div className="oh-video-preview-empty">{error ?? "正在连接视频工作台…"}</div></main>}
    {workspace !== undefined && videoStudioMounted && <VideoStudio
          sessionId={sessionId}
          projects={workspace.videos}
          running={videoBuilding}
          projectId={videoProjectId}
          tab={videoTab}
          hidden={workbench !== "video"}
          workbenches={WORKBENCH_MODES}
          paneId={compactVideoStudioId}
          labelledBy={`${compactTabsId}-studio-tab`}
          onProject={setVideoProjectId}
          onTab={setVideoTab}
          onWorkbench={selectWorkbench}
          onCollapse={() => { applyWorkbenchPreference("closed"); }}
          onRefresh={reload}
        />}
    {workbench !== "game" && workbench !== "video" && <>
    <aside className="oh-story-tree">
      <div className="oh-story-brand">
        <span className="oh-story-brand-cluster"><strong><span className="oh-story-brand-full">Oh Story</span><span className="oh-story-brand-short">创作</span></strong></span>
        <span className="oh-story-brand-actions">
          <button type="button" onClick={reload} title="刷新" aria-label="刷新项目文件">↻</button>
          <button type="button" onClick={() => { applyWorkbenchPreference("closed"); }} title="收起创作工作台" aria-label="收起创作工作台">×</button>
        </span>
      </div>
      {workspace !== undefined && <div className="oh-story-mode-tabs" role="tablist" aria-label="创作工作台">
        {WORKBENCH_MODES.map((mode) => <button
          type="button"
          role="tab"
          key={mode}
          tabIndex={workbench === mode ? 0 : -1}
          aria-selected={workbench === mode}
          onKeyDown={(event) => { handleTabKey(event, WORKBENCH_MODES, workbench, selectWorkbench); }}
          onClick={() => { selectWorkbench(mode); }}
        >{workbenchLabel(mode)}</button>)}
      </div>}
      {error !== undefined && <div className="oh-story-error">{error}</div>}
      {workspace?.metadataErrors.map((message) => <div className="oh-story-warning" key={message}>{message}</div>)}
      <nav ref={navRef} aria-label={`${workbenchLabel(workbench)}项目文件`}>
        {Object.entries(buffers).some(([path, value]) => isDirtyDraft(value) && workbenchModeForPath(path) === workbench) && <details className="oh-story-file-group" open>
          <summary>本地草稿</summary>
          {Object.entries(buffers).filter(([path, value]) => isDirtyDraft(value) && workbenchModeForPath(path) === workbench).map(([path]) => <button
            type="button" key={path} title={path} aria-label={`本地草稿 ${path}`} data-file-path={path}
            aria-current={selected === path ? "page" : undefined} onClick={() => { revealPath(path); }}
          >{path.split("/").at(-1)}</button>)}
        </details>}
        {groups.map(([directory, files]) => {
          const groupOpen = selectedGroup === directory || expanded[directory] === true;
          return <details className="oh-story-file-group" key={directory} open={groupOpen} onToggle={(event) => { toggleGroup(directory, event.currentTarget.open); }}>
            <summary>{directory}<span>{files.length}</span></summary>
            <FileTreeNodes
              nodes={buildFileTree(files, directory)}
              depth={1}
              expanded={expanded}
              selected={selected}
              activityPath={activityPath}
              onToggle={toggleGroup}
              onSelect={revealPath}
            />
          </details>;
        })}
      </nav>
    </aside>
    <main className="oh-story-editor">
      <header>
        <span className="oh-story-editor-path" title={selected}><span>{selectedLabel}</span><strong>{selectedBasename}</strong></span>
        <div className="oh-story-editor-actions">
          {workbench === "wechat" && <button className="oh-story-save" type="button" onClick={prepareCreation} disabled={inputPhase === "adjudicating" || inputPhase === "submitting"}>新文章</button>}
          {(previewable || productionAvailable) && !selectedMedia && <div className="oh-story-editor-tabs" role="tablist" aria-label={productionAvailable ? "短剧文档查看方式" : markdown ? "Markdown 查看方式" : "JSONL 查看方式"}>
            {editorModes.map((mode) => <button
              type="button"
              role="tab"
              key={mode}
              tabIndex={editorMode === mode ? 0 : -1}
              aria-selected={editorMode === mode}
              onKeyDown={(event) => { handleTabKey(event, editorModes, editorMode, selectEditorMode); }}
              onClick={() => { selectEditorMode(mode); }}
            >{mode === "preview" ? "预览" : mode === "source" ? "源码" : "生产"}</button>)}
          </div>}
          {(dirty || saving) && selected !== undefined && !readOnlyReference && <button className="oh-story-save" type="button" disabled={saving || buffer?.missing === true} onClick={() => { void savePath(selected); }}>
            {saving ? "保存中…" : "保存"}
          </button>}
        </div>
      </header>
      {readOnlyReference && <div className="oh-story-draft-status">参考原文 · 只读</div>}
      {recoveredDrafts > 0 && <div className="oh-story-draft-status" role="status">
        <span>已恢复 {recoveredDrafts} 份本地草稿</span>
        <button type="button" aria-label="关闭草稿恢复提示" title="关闭草稿恢复提示" onClick={() => { actions.dismissDraftRecovery(); }}>×</button>
      </div>}
      {draftError !== undefined && <div className="oh-story-warning" role="alert">
        {draftErrorMessage}<button type="button" onClick={retryDraftBackup}>重试备份</button>
      </div>}
      {draftSessionError !== undefined && Object.values(buffers).some(isDirtyDraft) && <div className="oh-story-warning" role="alert">
        草稿已保留在浏览器，但会话备份失败：{draftSessionError}
        <button type="button" onClick={retryDraftBackup}>重试备份</button>
      </div>}
      {dirty && <div className="oh-story-draft-status" role="status">
        <span>{draftError !== undefined || draftSessionError !== undefined ? "草稿尚未完成备份" : draftSessionReady ? "草稿已备份 · 文件未保存" : "草稿备份中…"}</span>
        {buffer?.missing !== true && <button type="button" onClick={downloadDraft}>下载草稿</button>}
      </div>}
      {activity !== undefined && activityPath !== undefined && activityPath === selected && <div className="oh-story-stream" data-stage={activity.stage} role="status" aria-live="polite">● {activity.stage === "running" ? "Agent 正在应用修改" : "Agent 正在生成文件内容"}</div>}
      {conflict !== undefined && <div className="oh-story-conflict" role="alert">
        <span>{conflict.message}</span>
        {conflict.theirs !== undefined && conflict.theirsVersion !== undefined && selected !== undefined && <div>
          <button type="button" onClick={() => { resolveConflict(false); }}>载入磁盘版本</button>
          <button type="button" onClick={() => { resolveConflict(true); }}>保留本地草稿</button>
        </div>}
      </div>}
      {fileError !== undefined && buffer?.missing !== true && <div className="oh-story-error" role="alert">{fileError}
        {selected !== undefined && fileLoadErrors[selected] !== undefined && <button type="button" onClick={() => { setFileReadRevision((value) => value + 1); }}>重新读取</button>}
      </div>}
      {selected === undefined
        ? workspaceLoading
          ? <div className="oh-story-empty" role="status">正在读取项目…</div>
          : error !== undefined
            ? <div className="oh-story-empty"><p>无法读取项目文件</p><button type="button" onClick={reload}>重新读取</button></div>
            : <section className="oh-story-empty oh-story-start" aria-label={`${workbenchLabel(workbench)}创作起点`}>
              <h2>{workbench === "wechat" ? "开始一篇公众号文章" : workbench === "story" ? "开始一个新故事" : "开始一部新短剧"}</h2>
              <p>{groups.length === 0 ? `还没有${workbenchLabel(workbench)}文件` : "尚未选择文件"}</p>
              <div className="oh-story-start-actions">
                {groups[0]?.[1][0] !== undefined && <button type="button" onClick={() => { const file = groups[0]?.[1][0]; if (file !== undefined) revealPath(file.path); }}>打开文件</button>}
                <button className="oh-story-start-primary" type="button" disabled={inputPhase === "adjudicating" || inputPhase === "submitting"} onClick={prepareCreation}>{composerDraft.trim().length > 0 ? "继续编辑" : "开始创作"}</button>
              </div>
            </section>
        : selectedMedia && selectedFile !== undefined
          ? <div className="oh-story-media-document">{selectedFile.mimeType?.startsWith("image/") === true
              ? <img src={endpoint("media", sessionId, selectedFile.path)} alt={selectedFile.path} />
              : selectedFile.mimeType?.startsWith("audio/") === true
                ? <audio src={endpoint("media", sessionId, selectedFile.path)} controls />
                : <video src={endpoint("media", sessionId, selectedFile.path)} controls preload="metadata" />}</div>
        : buffer === undefined
          ? <div className="oh-story-empty">{fileError === undefined ? `正在加载 ${selected}…` : "文件读取失败"}</div>
        : buffer.missing === true
          ? <><div className="oh-story-warning" role="status">原文件已移除，本地草稿未保存。<button type="button" onClick={downloadDraft}>下载草稿</button><button type="button" onClick={() => {
            if (!globalThis.confirm(`放弃 ${selected} 的本地草稿？此操作无法撤销。`)) return;
            setBuffers((current) => {
              const next = { ...current };
              delete next[selected];
              return next;
            });
            setSelected(workspace === undefined ? undefined : preferredWorkbenchFile(workspace.files, workbench));
          }}>放弃本地草稿</button></div><textarea value={buffer.content} readOnly aria-label={`${selected} 本地草稿`} /></>
        : editorMode === "production" && productionAvailable && episodeProduction !== undefined
          ? <DramaProductionView
              sessionId={sessionId}
              production={episodeProduction}
              sessionRunning={sessionRunning}
              queue={productionQueue}
              section={productionSection}
              selectedId={productionSelectedId}
              jobs={productionJobs}
              versions={productionVersions}
              libraryVersions={productionLibrary}
              selections={productionSelections}
              manualReferences={productionReferences}
              sequence={productionSequence}
              canvas={productionCanvas}
              zoom={productionZoom}
              onSectionChange={setProductionSection}
              onSelect={setProductionSelectedId}
              onNavigate={navigateProductionTarget}
              onJobsChange={setProductionJobs}
              onSelectionsChange={setProductionSelections}
              onManualReferencesChange={setProductionReferences}
              onOpenMedia={(path) => { revealPath(path); }}
              onSequenceChange={setProductionSequence}
              onCanvasChange={setProductionCanvas}
              onZoomChange={setProductionZoom}
              onDispatchPrompt={sendProductionPrompt}
              onCancelTurn={cancelProduction}
              onRemoveQueued={removeQueuedProduction}
              onRefresh={reload}
            />
        : previewable && editorMode === "preview"
          ? wechatPreviewable
            ? <WechatPreview content={buffer.content} path={selected} sessionId={sessionId} files={workspace?.files ?? []} />
          : markdown
            ? <MarkdownPreview content={buffer.content} label={selected} />
            : <JsonlPreview content={buffer.content} label={selected} />
          : <textarea
            ref={textareaRef}
            value={buffer.content}
            readOnly={readOnlyReference}
            data-format={structured ? "structured" : "prose"}
            onBlur={rememberEditorPosition}
            onScroll={rememberEditorPosition}
            onSelect={rememberEditorPosition}
            onChange={(event) => {
              const content = event.target.value;
              setBuffers((current) => ({
                ...current,
                [selected]: {
                  content,
                  saved: current[selected]?.saved ?? "",
                  source: "human",
                  version: current[selected]?.version ?? "",
                  conflict: current[selected]?.conflict,
                  saving: current[selected]?.saving
                }
              }));
            }}
            spellCheck={!structured}
            aria-label={selected}
          />}
    </main>
    </>}
  </div>;
}

interface ProductionConversationFace {
  readonly sendProductionPrompt: (prompt: string) => Promise<void>;
  readonly cancelProduction: () => Promise<void>;
  readonly removeQueuedProduction: (itemId: string) => Promise<void>;
}

interface WorkbenchEntryFace {
  readonly entryRequest: SnapshotStore<WorkbenchEntryRequest | undefined>;
}

type WorkbenchSlotProps = PropsRuntime<"oh-story.workspace"> & PropsStore<ReturnType<typeof createWorkbenchStore>> & ProductionConversationFace & WorkbenchEntryFace;

/** Mount beside the official conversation without replacing Chat or Composer. */
function CreativeSplitBridge({ sessionId, useSession, useChat, useStore, useInput, inputActions, actions, sendProductionPrompt, cancelProduction, removeQueuedProduction, entryRequest }: WorkbenchSlotProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  const runningCalls = useChat((snapshot) => snapshot.legacy.runningCalls);
  const partial = useChat((snapshot) => streamingAssistant(snapshot.timeline));
  const settledMutation = useChat((snapshot) => latestSettledMutation(snapshot));
  const workbench = useStore((memory) => memory.workbench);
  const gamePane = useStore((memory) => memory.gamePane);
  const videoPane = useStore((memory) => memory.videoPane);
  const sessionRunning = useSession((snapshot) => snapshot.running);
  const productionQueue = useSession((snapshot) => snapshot.queue.map((item) => ({ id: item.id, preview: item.preview })));
  const chat = useChat((snapshot) => snapshot);
  const productionIntents = useMemo(() => settledProductionIntents(chat), [chat]);
  const { workspace, error, loading: workspaceLoading, reload } = useWorkspace(sessionId);
  const chosenPreference = useStore((memory) => memory.workbenchPreference);
  const draftScope = useStore((memory) => memory.draftScope);
  const hasDrafts = useStore((memory) => Object.values(memory.buffers).some(isDirtyDraft));
  const draftError = useStore((memory) => memory.draftError);
  const draftSessionReady = useStore((memory) => memory.draftSessionReady);
  const draftsReady = workspace !== undefined && sameDraftScope(draftScope, { sessionId, cwd: workspace.cwd });
  const subscribeEntry = useCallback((listener: () => void) => entryRequest.subscribe(listener), [entryRequest]);
  const readEntry = useCallback(() => entryRequest.getSnapshot(), [entryRequest]);
  const requestedEntry = useSyncExternalStore(subscribeEntry, readEntry);
  const [draftLockRevision, setDraftLockRevision] = useState(0);
  const [draftSessionRevision, setDraftSessionRevision] = useState(0);
  const creativeProject = hasCreativeProject(workspace) || (draftsReady && (hasDrafts || draftError === "invalid" || draftError === "changed"));
  useLayoutEffect(() => {
    if (workspace !== undefined) actions.initializeDrafts({ sessionId, cwd: workspace.cwd });
  }, [actions, sessionId, workspace?.cwd]);
  useLayoutEffect(() => {
    if (!draftsReady || requestedEntry?.sessionId !== sessionId) return;
    actions.setWorkbench(requestedEntry.mode);
    actions.setWorkbenchPreference("open");
    writeWorkbenchPreference(workbenchPreferenceStorage(), workspace?.cwd, "open");
    entryRequest.set(undefined);
  }, [actions, draftsReady, entryRequest, requestedEntry, sessionId, workspace?.cwd]);
  useEffect(() => {
    if (!draftsReady || draftScope === undefined) return;
    return acquireDraftBackupLock(draftScope, (result) => { actions.setDraftBackupAccess(draftScope, result); });
  }, [actions, draftScope, draftLockRevision, draftsReady]);
  const retryDraftBackup = useCallback((): void => {
    if (draftScope !== undefined && hasDraftBackupLock(draftScope)) actions.retryDraftBackup();
    else setDraftLockRevision((value) => value + 1);
    setDraftSessionRevision((value) => value + 1);
  }, [actions, draftScope]);
  useEffect(() => {
    if (!draftsReady || draftScope === undefined || !hasDrafts || draftSessionReady) return;
    const controller = new AbortController();
    void fetch(endpoint("draft-session", sessionId), { method: "POST", signal: controller.signal })
      .then((response) => json<{ readonly sessionId: string }>(response))
      .then((result) => {
        if (result.sessionId !== sessionId) throw new Error("会话备份返回了不同的会话");
        if (!controller.signal.aborted) actions.setDraftSessionResult(draftScope, undefined);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) actions.setDraftSessionResult(draftScope, reason instanceof Error ? reason.message : String(reason));
      });
    return () => { controller.abort(); };
  }, [actions, draftScope, draftSessionReady, draftSessionRevision, draftsReady, hasDrafts, sessionId]);
  useEffect(() => {
    if (!draftsReady || draftScope === undefined) return;
    const check = (): void => { actions.checkDraftBackup(); };
    const changed = (event: StorageEvent): void => {
      if (event.key === null || event.key === draftBackupKey(draftScope)) check();
    };
    globalThis.addEventListener("storage", changed);
    globalThis.addEventListener("focus", check);
    return () => {
      globalThis.removeEventListener("storage", changed);
      globalThis.removeEventListener("focus", check);
    };
  }, [actions, draftScope, draftsReady]);
  // The Session Store holds this Session's choice; localStorage carries the workspace's
  // last choice across restarts. Reading it here keeps the decision in the same render
  // that learns the workspace, so a collapsed workbench never flashes the layout open.
  const storedPreference = useMemo(
    () => readWorkbenchPreference(workbenchPreferenceStorage(), workspace?.cwd),
    [workspace?.cwd]
  );
  const preference = chosenPreference ?? storedPreference;
  const open = resolveWorkbenchOpen(preference, creativeProject);
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined) return;
    const locate = (): void => {
      const anchor = document.querySelector<HTMLElement>("[data-conversation-scroll] > [data-slot='conversation.session']");
      setTarget((current) => current === anchor ? current : anchor ?? undefined);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, [sessionId]);
  useLayoutEffect(() => {
    const scroller = target?.parentElement;
    if (scroller === undefined || scroller === null) return;
    if (!open) {
      // A collapsed workbench returns the conversation to DSH untouched, so the only
      // measurement left is where that column sits: the launcher floats over its corner.
      const publishSeam = (): void => {
        const box = scroller.getBoundingClientRect();
        scroller.style.setProperty("--oh-story-seam-top", `${String(box.top)}px`);
        scroller.style.setProperty("--oh-story-seam-right", `${String(scroller.ownerDocument.documentElement.clientWidth - box.right)}px`);
        scroller.style.setProperty("--oh-story-seam-width", `${String(box.width)}px`);
      };
      publishSeam();
      const seams = new ResizeObserver(publishSeam);
      seams.observe(scroller);
      const view = scroller.ownerDocument.defaultView;
      view?.addEventListener("resize", publishSeam);
      return () => {
        seams.disconnect();
        view?.removeEventListener("resize", publishSeam);
        scroller.style.removeProperty("--oh-story-seam-top");
        scroller.style.removeProperty("--oh-story-seam-right");
        scroller.style.removeProperty("--oh-story-seam-width");
      };
    }
    const composerSeat = (): HTMLElement | null => scroller.querySelector(":scope > [data-composer-seat]");
    // The seat overlaps the Chat column here, so a reader parked at the tail has
    // to be carried across every layout pass; losing the tail does not merely
    // scroll it out of sight, it leaves the last lines behind the Composer.
    // Being parked cannot be read inside the pass — a reflow moves the tail
    // before the observer runs — and it cannot be read from scroll events alone
    // either: the Chat settles over several frames after a resize and every one
    // of those frames scrolls without the reader asking. So only a scroll the
    // reader actually drove releases the tail; reaching the bottom always
    // reclaims it.
    const parkedAtTail = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 8;
    let parked = parkedAtTail();
    let drivenAt = 0;
    const markDriven = (event: Event): void => {
      if (event.target instanceof Node && composerSeat()?.contains(event.target) === true) return;
      // A button click (for example switching the editor preview) is not a
      // scrollbar drag. Its subsequent reflow must not release the Chat tail.
      if (event.type === "pointerdown" && event.target !== scroller) return;
      drivenAt = performance.now();
    };
    const trackParked = (): void => {
      if (parkedAtTail()) parked = true;
      else if (performance.now() - drivenAt < 400) parked = false;
    };
    const publishLayout = (): void => {
      scroller.style.setProperty("--oh-story-scroll-height", `${String(scroller.clientHeight)}px`);
      // DSH 0.1.2 grows the seat with the streaming Todo panel while
      // --dsh-composer-height keeps reporting the bare input height. Publish the
      // measurement beside it rather than over it: the CSS takes the larger, so
      // writing the variable DSH also owns can never turn into a resize duel.
      scroller.style.setProperty("--oh-story-composer-height", `${String(composerSeat()?.getBoundingClientRect().height ?? 0)}px`);
      scroller.dataset.ohStoryWorkbench = workbench;
      const studioPane = workbench === "video" ? videoPane : gamePane;
      scroller.dataset.ohStudioPane = studioPane;
      const compactAt = workbench === "game" || workbench === "video" ? 720 : 620;
      const mediumAt = workbench === "game" || workbench === "video" ? 960 : 900;
      const layout = scroller.clientWidth < compactAt ? "compact" : scroller.clientWidth < mediumAt ? "medium" : "wide";
      if (scroller.dataset.ohStoryLayout !== layout) scroller.dataset.ohStoryLayout = layout;
      if (parked) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    };
    const observer = new ResizeObserver(publishLayout);
    const observed = new WeakSet<Element>();
    // The official seat and Chat flow mount and remount independently of this
    // bridge. The flow is observed because a resized Chat keeps re-wrapping for
    // several frames afterwards: pinning once against the height the first frame
    // reports leaves the reader behind the Composer again once it settles.
    let flowObserved = false;
    const observePanes = (): void => {
      const flow = scroller.querySelector("[data-chat-flow]");
      flowObserved = flow !== null;
      for (const pane of [composerSeat(), flow]) {
        if (pane === null || observed.has(pane)) continue;
        observed.add(pane);
        observer.observe(pane);
      }
    };
    publishLayout();
    scroller.addEventListener("scroll", trackParked, { passive: true });
    for (const driven of ["wheel", "touchmove", "pointerdown", "keydown"]) {
      scroller.addEventListener(driven, markDriven, { passive: true });
    }
    observer.observe(scroller);
    observePanes();
    const seats = new MutationObserver(() => { observePanes(); publishLayout(); });
    seats.observe(scroller, { childList: true });
    // The flow mounts below the seat's level, and streaming mutates it token by
    // token: watch the subtree only until it has been found once.
    const panes = new MutationObserver(() => { if (!flowObserved) observePanes(); });
    panes.observe(scroller, { childList: true, subtree: true });
    return () => {
      panes.disconnect();
      scroller.removeEventListener("scroll", trackParked);
      for (const driven of ["wheel", "touchmove", "pointerdown", "keydown"]) {
        scroller.removeEventListener(driven, markDriven);
      }
      observer.disconnect();
      seats.disconnect();
      scroller.style.removeProperty("--oh-story-scroll-height");
      scroller.style.removeProperty("--oh-story-composer-height");
      delete scroller.dataset.ohStoryLayout;
      delete scroller.dataset.ohStoryWorkbench;
      delete scroller.dataset.ohStudioPane;
    };
  }, [gamePane, open, target, videoPane, workbench]);
  return <>
    <span ref={marker} className="oh-story-bridge-marker" aria-hidden />
    {target === undefined || (workspace !== undefined && !draftsReady) ? null : createPortal(<CreativeWorkbench
      key={sessionId}
      sessionId={sessionId}
      runningCalls={runningCalls}
      partial={partial}
      settledMutation={settledMutation}
      sessionRunning={sessionRunning}
      productionQueue={productionQueue}
      productionIntents={productionIntents}
      workspace={workspace}
      error={error}
      workspaceLoading={workspaceLoading}
      reload={reload}
      open={open}
      retryDraftBackup={retryDraftBackup}
      sendProductionPrompt={sendProductionPrompt}
      cancelProduction={cancelProduction}
      removeQueuedProduction={removeQueuedProduction}
      useStore={useStore}
      useInput={useInput}
      inputActions={inputActions}
      actions={actions}
    />, target)}
  </>;
}

interface WorkbenchWelcomeActions {
  readonly openWorkbench: (mode: WorkbenchMode) => Promise<void>;
}

type WorkbenchSeatProps = PropsRuntime<"shell.overlay"> & PropsRenderSlots<"oh-story.workspace"> & WorkbenchWelcomeActions;

/** The session-scoped workbench cannot mount on a fresh DSH home page. */
function WorkbenchWelcome({ openWorkbench }: WorkbenchWelcomeActions) {
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement>();
  const [opening, setOpening] = useState<WorkbenchMode>();
  const [failure, setFailure] = useState<string>();
  const busy = useRef(false);
  const launch = async (mode: WorkbenchMode): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setOpening(mode);
    setFailure(undefined);
    try { await openWorkbench(mode); }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      busy.current = false;
      setOpening(undefined);
    }
  };
  useLayoutEffect(() => {
    const document = marker.current?.ownerDocument;
    if (document === undefined) return;
    const locate = (): void => {
      const anchor = document.querySelector<HTMLElement>("[data-conversation-scroll]")
        ?? document.querySelector<HTMLElement>("[data-slot='conversation']");
      setTarget((current) => current === anchor ? current : anchor ?? undefined);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, []);
  return <>
    <style>{styles}</style>
    <span ref={marker} className="oh-story-bridge-marker" aria-hidden />
    {target === undefined ? null : createPortal(<section className="oh-story-welcome" aria-label="Oh Story 创作工作台">
      <h2>Oh Story</h2>
      <nav className="oh-story-entry-modes" aria-label="创作工作台">
        {WORKBENCH_MODES.map((mode) => <button key={mode} type="button" disabled={opening !== undefined} aria-busy={opening === mode} onClick={() => { void launch(mode); }}>
          {workbenchLabel(mode)}
        </button>)}
      </nav>
      {opening !== undefined && <p role="status">正在打开{workbenchLabel(opening)}工作台…</p>}
      {failure !== undefined && <p role="alert" className="oh-story-entry-error">{failure}</p>}
    </section>, target)}
  </>;
}

function WorkbenchSeat({ SessionProvider, renderSlot, openWorkbench }: WorkbenchSeatProps) {
  return <SessionProvider empty={() => <WorkbenchWelcome openWorkbench={openWorkbench} />}>{renderSlot("oh-story.workspace", {})}</SessionProvider>;
}

function argsOf(block: ToolCallViewProps["block"]): Record<string, unknown> {
  const raw = ("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "{}";
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function resultOf(block: ToolCallViewProps["block"]): string | undefined {
  if (!("kind" in block)) return undefined;
  return block.content.map((item) => item.type === "text" ? item.text : JSON.stringify(item, null, 2)).join("\n");
}

function RoleToolView({ block, inspect }: ToolCallViewProps) {
  const args = argsOf(block);
  const role = typeof args.role === "string" ? args.role : "story-role";
  const output = resultOf(block);
  const state = !("kind" in block) ? "running" : block.isError ? "error" : "done";
  return <details className="oh-story-role" data-state={state}>
    <style>{styles}</style>
    <summary><span>✦ Role</span><strong>{role}</strong><em>{state === "running" ? "运行中" : state === "error" ? "失败" : "完成"}</em></summary>
    {output !== undefined && <pre>{output}</pre>}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}

function ProductionToolView({ block, inspect }: ToolCallViewProps) {
  const args = argsOf(block);
  const action = typeof args.action === "string" ? args.action : "production";
  const episode = typeof args.episode === "string" ? args.episode : "短剧";
  const state = !("kind" in block) ? "running" : block.isError ? "error" : "done";
  return <details className="oh-story-role" data-state={state}>
    <style>{styles}</style>
    <summary><span>▦ 生产</span><strong>{episode} · {action}</strong><em>{state === "running" ? "执行中" : state === "error" ? "失败" : "已应用"}</em></summary>
    {resultOf(block) !== undefined && <pre>{resultOf(block)}</pre>}
    {inspect !== undefined && <button type="button" onClick={inspect}>在轨迹中检查</button>}
  </details>;
}

/** Register only official DSH surfaces; the split bridge never replaces Chat. */
export function apply(context: ClientContext): void {
  const entryRequest = createSnapshotStore<WorkbenchEntryRequest | undefined>(undefined);
  const openWorkbench = async (mode: WorkbenchMode): Promise<void> => {
    const navigation = context.get("uiWorkspace") as unknown as Pick<WorkbenchEntryHost, "pickDirectory" | "connectWorkspace"> | undefined;
    const workspaces = context.get("workspaces") as unknown as { create: WorkbenchEntryHost["createWorkspace"] } | undefined;
    if (navigation === undefined || workspaces === undefined) throw new Error("工作区尚未连接，请稍后重试。");
    const sessions = context.sessions as unknown as ISessions;
    await enterWorkbench({
      pickDirectory: () => navigation.pickDirectory(),
      createWorkspace: (input) => workspaces.create(input),
      connectWorkspace: (workspaceId) => navigation.connectWorkspace(workspaceId),
      openSession: (sessionId) => { sessions.open(sessionId as Parameters<ISessions["open"]>[0]); }
    }, mode, (request) => { entryRequest.set(request); });
  };
  context.slots.inject("shell.overlay", () => {
    const disposeSeat = context.slots.register({
      name: "shell.overlay",
      id: "oh-story-workspace",
      order: -100,
      inject: () => ({ openWorkbench }),
      children: { "oh-story.workspace": { kind: "single", scope: "session" } }
    }, WorkbenchSeat);
    const disposeWorkbench = context.slots.register({
      name: "oh-story.workspace",
      store: createWorkbenchStore,
      inject: (sessionId) => {
        const binding = (context.sessions as unknown as ISessions).binding(sessionId);
        const conversation = binding?.ctx.get("conversation");
        if (binding === undefined || conversation === undefined) {
          return {
            entryRequest,
            sendProductionPrompt: () => Promise.reject(new Error("DSH 会话当前不可用。")),
            cancelProduction: () => Promise.reject(new Error("DSH 会话当前不可用。")),
            removeQueuedProduction: () => Promise.reject(new Error("DSH 会话当前不可用。"))
          };
        }
        return {
          entryRequest,
          sendProductionPrompt: (prompt: string) => conversation.send(prompt),
          cancelProduction: () => conversation.cancel(),
          removeQueuedProduction: (itemId: string) => conversation.updateQueue(itemId as Parameters<IConversation["updateQueue"]>[0], { kind: "remove" })
        };
      }
    }, CreativeSplitBridge);
    return [disposeSeat, disposeWorkbench];
  });
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: "oh_story_role"
  }, RoleToolView));
  context.slots.inject("tool.call.toolview", () => context.slots.register({
    name: "tool.call.toolview",
    key: OH_STORY_PRODUCTION_TOOL_NAME
  }, ProductionToolView));
}

export default { name, inject, apply };
