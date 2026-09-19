import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Locator, type Page, type Request, type Response, type Route } from "@playwright/test";
import { assertCustomModelReasoning } from "./native-desktop-models-smoke.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = join(repositoryRoot, "apps", "desktop", "src-tauri", "target", "debug", "oh-story-desktop.exe");
const evidenceDirectory = join(repositoryRoot, "test-results", "desktop");
const tabNames = ["\u5c0f\u8bf4", "\u77ed\u5267", "\u6e38\u620f", "\u89c6\u9891", "\u516c\u4f17\u53f7"];
const workspaceTabsLabel = "\u521b\u4f5c\u5de5\u4f5c\u53f0";
const storyFilesLabel = "\u5c0f\u8bf4\u9879\u76ee\u6587\u4ef6";
const draftReadyText = "\u8349\u7a3f\u5df2\u5907\u4efd \u00b7 \u6587\u4ef6\u672a\u4fdd\u5b58";
const pause = (milliseconds: number): Promise<void> => new Promise((accept) => setTimeout(accept, milliseconds));

function redact(text: string): string {
  return text
    .replace(/([?&]token=)[^\s"'&]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|authorization|cookie|password|secret)\s*[:=]\s*)[^\r\n]+/giu, "$1[redacted]");
}

async function runPnpm(args: readonly string[]): Promise<void> {
  const command = process.env.ComSpec ?? "cmd.exe";
  const child = spawn(command, ["/d", "/s", "/c", "pnpm", ...args], {
    cwd: repositoryRoot, windowsHide: true, stdio: "inherit"
  });
  await new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`Desktop build failed (exit ${String(code)}).`)));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  if (address === null || typeof address === "string") throw new Error("Could not allocate a native test port.");
  return address.port;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((accept) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean): void => { socket.destroy(); accept(listening); };
    socket.setTimeout(500);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
    socket.once("timeout", () => { finish(false); });
  });
}

function isolatedEnvironment(dataDirectory: string, cdpPort: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/iu.test(key) || /^(?:DSH_|OH_STORY_)/u.test(key)) delete env[key];
  }
  return {
    ...env,
    OH_STORY_DESKTOP_DATA_DIR: dataDirectory,
    OH_STORY_DESKTOP_CDP_PORT: String(cdpPort),
    DSH_TELEMETRY_DISABLED: "1",
    WEBVIEW2_USER_DATA_FOLDER: join(dataDirectory, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${String(cdpPort)} --remote-debugging-address=127.0.0.1`
  };
}

interface NativeApp {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly exit: Promise<number | null>;
}

function startDesktop(env: NodeJS.ProcessEnv): NativeApp {
  const output: string[] = [];
  const child = spawn(executable, [], { cwd: dirname(executable), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      if (output.length > 100) output.shift();
    });
  }
  const exit = new Promise<number | null>((accept) => {
    child.once("error", (error) => { output.push(error.message); accept(-1); });
    child.once("exit", accept);
  });
  return { child, output, exit };
}

async function stopDesktop(app: NativeApp): Promise<void> {
  if (app.child.exitCode === null && app.child.signalCode === null && app.child.pid !== undefined) app.child.kill("SIGKILL");
  await Promise.race([
    app.exit,
    pause(10_000).then(() => { throw new Error("The owned desktop process did not exit."); })
  ]);
}

async function connectWebview(app: NativeApp, cdpPort: number, origin: string): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + 45_000;
  const cdpOrigin = `http://127.0.0.1:${String(cdpPort)}`;
  let cdpReady = false;
  while (Date.now() < deadline) {
    if (app.child.pid === undefined || app.child.exitCode !== null || app.child.signalCode !== null) throw new Error("Desktop exited before its WebView became ready.");
    try {
      const response = await fetch(`${cdpOrigin}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { cdpReady = true; break; }
    } catch { /* WebView2 initializes after the native process starts. */ }
    await pause(250);
  }
  if (!cdpReady) throw new Error("The native WebView did not expose its isolated debugging port within 45 seconds.");
  const browser = await chromium.connectOverCDP(cdpOrigin, { timeout: 10_000 });
  try {
    let page: Page | undefined;
    await expect.poll(async () => {
      const pages = browser.contexts().flatMap((context) => context.pages());
      page = pages.find((candidate) => candidate.url().startsWith(origin));
      if (page !== undefined) return true;
      if (app.child.exitCode !== null || app.child.signalCode !== null) throw new Error("Desktop exited before its local service became ready.");
      const startup = pages.find((candidate) => /^(?:http:\/\/tauri\.localhost|tauri:\/\/localhost)\//u.test(candidate.url()));
      const status = await startup?.evaluate(async () => {
        const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
        return internals?.invoke("desktop_status");
      }).catch(() => undefined);
      if (typeof status === "object" && status !== null && "state" in status && status.state === "error") {
        const message = "message" in status && typeof status.message === "string" ? status.message : "Unknown startup error.";
        throw new Error(`Desktop startup failed: ${redact(message)}`);
      }
      return page !== undefined;
    }, { timeout: 120_000, message: "The native shell must navigate to its authenticated local DSH service." }).toBe(true);
    if (page === undefined) throw new Error("Native DSH WebView was not found.");
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.waitForLoadState("domcontentloaded");
    return { browser, page };
  } catch (error) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const observed = pages.map((page) => page.url());
    await pages[0]?.screenshot({ path: join(evidenceDirectory, "startup-failure.png"), fullPage: true, timeout: 5_000 }).catch(() => undefined);
    await browser.close();
    // The timeout says the shell never reached the service, but not whether the WebView was
    // missing, blank, or sitting on the startup page — and those three need different fixes.
    // Nothing else on a runner can see into the process, so report what the debugger saw.
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nWebView pages at failure: ${observed.length === 0 ? "none" : observed.join(", ")}`, { cause: error });
  }
}

async function successfulRpcValue<T>(response: Response): Promise<T> {
  expect(response.ok(), "The real DSH creation request must succeed.").toBe(true);
  const request = response.request().postDataJSON() as { readonly rpcId: string };
  const envelope = await response.json() as {
    readonly rpcId: string;
    readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string } };
  };
  if (envelope.rpcId !== request.rpcId || !envelope.result.ok) throw new Error("The real DSH creation request did not return a successful RPC result.");
  return envelope.result.value;
}

async function assertFirstNewSession(page: Page, origin: string, workspacePath: string): Promise<{ readonly workspaceTitle: string; readonly sessionId: string }> {
  const pickerUrl = `${origin}/api/directoryPicker/pick`;
  const workspaceUrl = `${origin}/api/workspace/create`;
  const sessionUrl = `${origin}/api/session/create`;
  const newSession = page.getByRole("button", { name: /^(?:New Session|\u65b0\u5efa\u4f1a\u8bdd)$/iu }).last();
  const composer = page.locator("[data-composer-input]");
  const submissionUrl = /\/api\/(?:session\/prompt|subagents\/prompt|commands\/execute)$/u;
  const unexpectedSubmissions: string[] = [];
  const submissionRoute = async (route: Route): Promise<void> => {
    unexpectedSubmissions.push(new URL(route.request().url()).pathname);
    await route.abort("blockedbyclient");
  };
  const creations = { workspaces: 0, sessions: 0 };
  const observeCreation = (request: Request): void => {
    if (request.url() === workspaceUrl) creations.workspaces += 1;
    if (request.url() === sessionUrl) creations.sessions += 1;
  };
  let pickerCalls = 0;
  let releaseCancellation: (() => void) | undefined;
  const cancellation = new Promise<void>((accept) => { releaseCancellation = accept; });
  const pickerFailure = "Desktop test directory picker failure";
  const pickerRoute = async (route: Route): Promise<void> => {
    pickerCalls += 1;
    const attempt = pickerCalls;
    const request = route.request().postDataJSON() as { readonly rpcId: string };
    if (attempt === 1) await cancellation;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        type: "server-response",
        rpcId: request.rpcId,
        result: attempt === 2
          ? { ok: false, error: { code: "directory-picker/unavailable", message: pickerFailure, details: { capability: "native" } } }
          : { ok: true, value: attempt === 1 ? null : workspacePath }
      }
    });
  };
  page.on("request", observeCreation);
  await page.route(pickerUrl, pickerRoute);
  await page.route(submissionUrl, submissionRoute);
  try {
    await expect(page.getByRole("treeitem")).toHaveCount(0);
    await page.getByRole("button", { name: /^(?:Collapse sidebar|\u6536\u8d77\u4fa7\u8fb9\u680f)$/u }).click();
    await expect(page.getByRole("button", { name: /^(?:Open sidebar|\u6253\u5f00\u4fa7\u8fb9\u680f)$/u })).toBeVisible();
    await newSession.click();
    await expect.poll(() => pickerCalls, {
      timeout: 5_000,
      message: "New Session in an empty desktop profile must open the directory picker."
    }).toBe(1);
    await expect(page.getByRole("button", { name: /^(?:Collapse sidebar|\u6536\u8d77\u4fa7\u8fb9\u680f)$/u })).toBeVisible();
    await newSession.click();
    await newSession.click();
    await pause(250);
    expect(pickerCalls, "Repeated clicks while choosing a directory must share one picker.").toBe(1);
    const cancelled = page.waitForResponse(pickerUrl);
    releaseCancellation?.();
    await (await cancelled).finished();
    await pause(250);
    expect(pickerCalls, "Clicks during a pending picker must not reopen it after cancellation.").toBe(1);
    expect(creations, "Cancelling the directory picker must not create a workspace or session.").toEqual({ workspaces: 0, sessions: 0 });
    await expect(page.getByRole("treeitem")).toHaveCount(0);

    await newSession.click();
    const failure = page.getByRole("dialog").filter({ has: page.getByRole("alert").filter({ hasText: pickerFailure }) });
    await expect(failure).toBeVisible();
    expect(pickerCalls).toBe(2);
    expect(creations, "A failed directory picker must not create a workspace or session.").toEqual({ workspaces: 0, sessions: 0 });
    await expect(page.getByRole("treeitem")).toHaveCount(0);

    // Only the native picker is stubbed; both entities must be created by the UI through the real host.
    const workspaceCreated = page.waitForResponse(workspaceUrl);
    const sessionCreated = page.waitForResponse(sessionUrl);
    await failure.getByRole("button", { name: /^(?:Choose again|\u91cd\u65b0\u9009\u62e9)$/u }).click();
    const [workspace, session] = await Promise.all([
      workspaceCreated.then((response) => successfulRpcValue<{ readonly workspace: { readonly title: string; readonly path: string } }>(response)),
      sessionCreated.then((response) => successfulRpcValue<{ readonly sessionId: string }>(response))
    ]);
    expect(workspace.workspace.path).toBe(workspacePath);
    await expect(failure).toBeHidden();
    await expect(page.getByRole("treeitem").filter({ hasText: workspace.workspace.title }).first()).toBeVisible();
    const sessionRows = page.getByRole("treeitem").filter({ hasText: /^\s*(?:New Session|\u65b0\u4f1a\u8bdd)\s*$/iu });
    await expect(sessionRows).toHaveCount(1);
    expect(creations).toEqual({ workspaces: 1, sessions: 1 });
    expect(pickerCalls).toBe(3);
    const firstComposerDraft = await assertEmptyWorkspaceEntries(page, session.sessionId);

    const freshSessionCreated = page.waitForResponse(sessionUrl);
    const freshWorkspaceLoaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === origin && url.pathname === "/oh-story/workspace" && url.searchParams.get("sessionId") !== session.sessionId;
    });
    await newSession.click();
    const freshSession = await successfulRpcValue<{ readonly sessionId: string }>(await freshSessionCreated);
    expect(freshSession.sessionId, "New Session must create a new session even when the current one is empty.").not.toBe(session.sessionId);
    expect(new URL((await freshWorkspaceLoaded).url()).searchParams.get("sessionId"), "The newly created session must become the active workbench session.").toBe(freshSession.sessionId);
    await expect(page.locator(".oh-story-split-surface[data-open='true'][data-workbench='story']")).toBeVisible();
    await expect(composer, "A newly created session must not inherit another session's prepared prompt.").toHaveText("");
    await expect(sessionRows).toHaveCount(2);
    await expect(sessionRows.and(page.getByRole("treeitem", { selected: true }))).toHaveCount(1);
    for (const expectedSessionId of [session.sessionId, freshSession.sessionId]) {
      const selectedWorkspace = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === "/oh-story/workspace" && url.searchParams.get("sessionId") === expectedSessionId;
      });
      await sessionRows.and(page.getByRole("treeitem", { selected: false })).click();
      expect((await selectedWorkspace).ok(), "Each visible session row must open its own real workspace binding.").toBe(true);
      await expect(sessionRows.and(page.getByRole("treeitem", { selected: true }))).toHaveCount(1);
      await expect(composer, "Composer drafts must stay bound to their original session.").toHaveText(expectedSessionId === session.sessionId ? firstComposerDraft : "");
    }
    expect(creations, "New Session in the same workspace must create exactly one additional session.").toEqual({ workspaces: 1, sessions: 2 });
    expect(pickerCalls, "An existing workspace must not reopen the directory picker.").toBe(3);
    expect(unexpectedSubmissions, "Empty-state creation actions must prepare a draft without submitting a command or model prompt.").toEqual([]);
    await page.screenshot({ path: join(evidenceDirectory, "new-session-created.png"), fullPage: true });
    return { workspaceTitle: workspace.workspace.title, sessionId: freshSession.sessionId };
  } finally {
    releaseCancellation?.();
    page.off("request", observeCreation);
    await page.unroute(pickerUrl, pickerRoute);
    await page.unroute(submissionUrl, submissionRoute);
  }
}

async function dismissFirstRun(page: Page): Promise<void> {
  const continueButton = page.getByRole("button", { name: /^(?:Continue|\u7ee7\u7eed)$/u });
  const consent = page.getByRole("dialog").filter({ has: continueButton });
  await continueButton.click({ timeout: 20_000 });
  await consent.waitFor({ state: "detached", timeout: 10_000 });
  const later = page.getByRole("button", { name: /^(?:Configure later|\u7a0d\u540e\u914d\u7f6e)$/u });
  await later.click({ timeout: 20_000 });
  await page.getByRole("dialog").filter({ has: later }).waitFor({ state: "detached", timeout: 10_000 });
  const welcome = page.getByRole("region", { name: `Oh Story ${workspaceTabsLabel}` });
  await expect(welcome).toBeVisible({ timeout: 20_000 });
  const entries = welcome.getByRole("navigation", { name: workspaceTabsLabel });
  await expect(entries.getByRole("button")).toHaveCount(tabNames.length);
  for (const name of tabNames) await expect(entries.getByRole("button", { name, exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidenceDirectory, "first-screen-workbenches.png"), fullPage: true });
}

async function settleResponsiveLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((accept) => { requestAnimationFrame(() => { requestAnimationFrame(() => { accept(); }); }); });
    await Promise.all(document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end === "number" && Number.isFinite(end);
    }).map((animation) => animation.finished.catch(() => undefined)));
    await new Promise<void>((accept) => { requestAnimationFrame(() => { requestAnimationFrame(() => { accept(); }); }); });
  });
}

/**
 * Explains why the collapse button could not be clicked. Playwright stops at the
 * first covering element, so its message names that element but not the layout that
 * put it there; the measurement does. The width sweep matters because the host
 * publishes `data-oh-story-layout` from a ResizeObserver and the toolbar only
 * overlaps at some widths, which is why this reproduces on a runner and not on a
 * developer machine.
 *
 * Three details are deliberate, and each one cost a previous CI round trip:
 *
 * * It measures the locator the click used rather than a class name. The game and
 *   video studios stay mounted behind `hidden` and keep their own copy of the
 *   button, so a `querySelector(".oh-workbench-collapse")` resolves to a
 *   `display: none` node and reports a zero box at (0, 0) whatever workbench is
 *   open — which is exactly what the first version of this diagnostic did.
 * * `elementsFromPoint` rather than `elementFromPoint`, because the covering pane
 *   is usually the second entry: the button's own ancestor subtree comes first.
 * * Compact single-line samples, because this text has to survive a 3000-character
 *   annotation budget that a pretty-printed dump fills on its own.
 */
async function describeWorkbenchState(page: Page, collapse: Locator): Promise<string> {
  const original = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const samples: string[] = [];
  const sample = async (): Promise<string> => {
    const resolved = await collapse.count();
    const visible = resolved > 0 && await collapse.first().isVisible().catch(() => false);
    const box = visible ? await collapse.first().boundingBox().catch(() => null) : null;
    const dom = await page.evaluate((point) => {
      // No named helpers in here: tsx compiles with esbuild's keepNames, which
      // rewrites `const rect = (node) => …` into `__name(rect, "rect")`, and
      // `__name` does not exist in the page context. Inline arrows are fine.
      const boxes: readonly (readonly [string, Element | null])[] = [
        ["surface", document.querySelector(".oh-story-split-surface[data-open='true']")],
        ["tree", document.querySelector(".oh-story-tree")],
        ["game", document.querySelector(".oh-game-studio")],
        ["video", document.querySelector(".oh-video-studio")],
        ["seat", document.querySelector("[data-composer-seat]")]
      ];
      const measured = boxes.map(([label, node]) => {
        if (node === null) return `${label} absent`;
        const rect = node.getBoundingClientRect();
        return `${label} ${String(Math.round(rect.x))},${String(Math.round(rect.y))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`;
      });
      const buttons = Array.from(document.querySelectorAll("button[aria-label='\u6536\u8d77\u521b\u4f5c\u5de5\u4f5c\u53f0']"), (button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return `${String(Math.round(rect.x))},${String(Math.round(rect.y))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))} ${style.display}/${style.visibility}/${style.pointerEvents}`;
      });
      const scroller = document.querySelector("[data-conversation-scroll]");
      const stack = point === null ? [] : document.elementsFromPoint(point[0], point[1]).slice(0, 4)
        .map((node) => `${node.tagName}.${typeof node.className === "string" ? node.className : ""}`.trim());
      return [
        `viewport ${String(innerWidth)}x${String(innerHeight)}`,
        `workbench ${scroller?.getAttribute("data-oh-story-workbench") ?? "none"}`,
        `layout ${scroller?.getAttribute("data-oh-story-layout") ?? "none"}`,
        `pane ${scroller?.getAttribute("data-oh-studio-pane") ?? "none"}`,
        ...measured,
        `buttons ${buttons.length === 0 ? "none" : buttons.join(" | ")}`,
        `stack ${stack.length === 0 ? "none" : stack.join(" < ")}`
      ].join("; ");
    }, box === null ? null : [box.x + box.width / 2, box.y + box.height / 2] as const);
    return `[${String(resolved)} match${resolved === 1 ? "" : "es"}, visible=${String(visible)}] ${dom}`;
  };
  try {
    // The first sample is the state the click actually failed in, so it is taken
    // before any viewport change.
    samples.push(await sample());
    for (const width of [...new Set([original.width, 1024, 1280, 1440])]) {
      if (width === original.width) continue;
      await page.setViewportSize({ width, height: original.height });
      await settleResponsiveLayout(page);
      samples.push(await sample());
    }
  } finally {
    await page.setViewportSize(original);
    await settleResponsiveLayout(page);
  }
  return samples.join("\n");
}

async function assertEmptyCreationLayout(page: Page, region: Locator, mode: string): Promise<void> {
  const originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  try {
    for (const viewport of [{ width: 1380, height: 900, name: "wide" }, { width: 880, height: 640, name: "compact" }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await settleResponsiveLayout(page);
      await region.scrollIntoViewIfNeeded();
      await expect(region).toBeVisible();
      const measurement = await region.evaluate((element) => {
        const boxes = [element, document.querySelector("[data-composer-seat]"), document.querySelector(".oh-story-brand-cluster"), document.querySelector(".oh-story-brand-actions")].map((node) => {
          if (node === null) return null;
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
        return {
          width: document.documentElement.clientWidth,
          overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth,
          region: boxes[0]!,
          composer: boxes[1] ?? null,
          cluster: boxes[2] ?? null,
          actions: boxes[3] ?? null,
          buttons: Array.from(element.querySelectorAll("button"), (button) => {
            const box = button.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, overflow: button.scrollWidth - button.clientWidth };
          }),
          tabs: Array.from(document.querySelectorAll(".oh-story-split-surface[data-open='true'] .oh-story-mode-tabs [role='tab']"), (tab) => {
            const box = tab.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(tab);
            const lines = new Set(Array.from(range.getClientRects()).filter((line) => line.width > 0 && line.height > 0).map((line) => Math.round(line.y)));
            return { x: box.x, y: box.y, width: box.width, height: box.height, overflow: tab.scrollWidth - tab.clientWidth, lines: lines.size };
          }),
        };
      });
      const overlaps = (left: { x: number; y: number; width: number; height: number }, right: typeof left): boolean =>
        Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x) > 1
        && Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y) > 1;
      expect(measurement.overflow, `${mode} ${viewport.name} must not overflow horizontally.`).toBeLessThanOrEqual(1);
      for (const box of [measurement.region, ...measurement.buttons, ...measurement.tabs]) {
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(measurement.width + 1);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
      }
      for (const button of measurement.buttons) expect(button.overflow, "Empty-state button text must fit inside its control.").toBeLessThanOrEqual(1);
      expect(measurement.tabs).toHaveLength(tabNames.length);
      for (const tab of measurement.tabs) {
        expect(tab.overflow, "Workbench category text must fit inside its tab.").toBeLessThanOrEqual(1);
        expect(tab.lines, "Each workbench category label must stay on one line.").toBe(1);
      }
      expect(new Set(measurement.tabs.map((tab) => Math.round(tab.y))).size, "Workbench categories must wrap into complete rows without splitting labels.").toBe(Math.ceil(tabNames.length / (viewport.name === "compact" ? 2 : 3)));
      if (measurement.composer !== null) expect(overlaps(measurement.region, measurement.composer), "The creation starting point must not overlap the official composer.").toBe(false);
      if (measurement.cluster !== null && measurement.actions !== null) expect(overlaps(measurement.cluster, measurement.actions), "The sidebar title and its tool buttons must not overlap.").toBe(false);
      await page.mouse.move(2, 2);
      await page.screenshot({ path: join(evidenceDirectory, `empty-${mode}-${viewport.name}.png`), fullPage: true, animations: "disabled" });
    }
  } finally {
    await page.setViewportSize(originalViewport);
    await settleResponsiveLayout(page);
  }
}

async function assertEmptyWorkspaceEntries(page: Page, sessionId: string): Promise<string> {
  const launcher = page.getByRole("navigation", { name: "\u6253\u5f00\u521b\u4f5c\u5de5\u4f5c\u53f0" });
  const composer = page.locator("[data-composer-input]");
  const modes = ["story", "drama", "game", "video", "wechat"];
  let retainedDraft = "";
  for (const [index, name] of tabNames.entries()) {
    await expect(launcher).toBeVisible({ timeout: 20_000 });
    await expect(launcher.getByRole("button")).toHaveCount(tabNames.length);
    await launcher.getByRole("button", { name, exact: true }).click();
    const surface = page.locator(`.oh-story-split-surface[data-open='true'][data-workbench='${modes[index]!}']`);
    await expect(surface).toBeVisible();
    const tabs = surface.getByRole("tablist", { name: workspaceTabsLabel });
    await expect(tabs.getByRole("tab")).toHaveCount(tabNames.length);
    await expect(tabs.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    if (index < 2 || modes[index] === "wechat") {
      const region = surface.getByRole("region", { name: `${name}\u521b\u4f5c\u8d77\u70b9`, exact: true });
      await expect(region).toBeVisible();
      if (modes[index] === "wechat") {
        const activeSurface = page.locator(".oh-story-split-surface[data-open='true']");
        const modeTabs = activeSurface.getByRole("tablist", { name: workspaceTabsLabel });
        await modeTabs.getByRole("tab", { name: tabNames[0]!, exact: true }).click();
        await composer.click();
        await composer.press("ControlOrMeta+A");
        await composer.press("Backspace");
        await expect(composer).toHaveText("");
        await activeSurface.getByRole("region", { name: `${tabNames[0]!}\u521b\u4f5c\u8d77\u70b9`, exact: true })
          .getByRole("button", { name: "\u5f00\u59cb\u521b\u4f5c", exact: true }).click();
        await expect.poll(() => composer.textContent()).toBe("/story-setup ");
        await modeTabs.getByRole("tab", { name, exact: true }).click();
        await expect(region).toBeVisible();
        await region.getByRole("button", { name: "\u5f00\u59cb\u521b\u4f5c", exact: true }).click();
        await expect.poll(() => composer.textContent()).toBe("/wechat-article ");
        await page.screenshot({ path: join(evidenceDirectory, "wechat-creation-command.png"), fullPage: true, animations: "disabled" });
        const authoredCommand = "/story-setup Keep my existing story request";
        await composer.fill(authoredCommand);
        await region.getByRole("button", { name: "\u7ee7\u7eed\u7f16\u8f91", exact: true }).click();
        await expect(composer).toHaveText(authoredCommand);
      }
      await composer.click();
      await composer.press("ControlOrMeta+A");
      await composer.press("Backspace");
      await expect(composer).toHaveText("");
      const start = region.getByRole("button", { name: "\u5f00\u59cb\u521b\u4f5c", exact: true });
      await expect(start).toBeVisible();
      await assertEmptyCreationLayout(page, region, modes[index]!);
      await start.click();
      const command = index === 4 ? "/wechat-article " : index === 0 ? "/story-setup " : "/short-drama ";
      await expect.poll(() => composer.textContent(), { message: "Starting creation must prepare the mode's command, including its argument separator." }).toBe(command);
      await expect(composer).toBeFocused();
      await expect.poll(() => page.evaluate((id) => {
        const stored = JSON.parse(localStorage.getItem(`dsh.conversation.${id}`) ?? "null") as { readonly draft?: string } | null;
        return stored?.draft;
      }, sessionId)).toBe(command);
      retainedDraft = `Keep my existing ${modes[index]!} draft intact.`;
      await composer.fill(retainedDraft);
      const resume = region.getByRole("button", { name: "\u7ee7\u7eed\u7f16\u8f91", exact: true });
      await expect(resume).toBeVisible();
      await resume.click();
      await expect(composer).toHaveText(retainedDraft);
      await expect(composer).toBeFocused();
    }
    const collapse = page.getByRole("button", { name: "\u6536\u8d77\u521b\u4f5c\u5de5\u4f5c\u53f0", exact: true });
    await collapse.click().catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${name} workbench collapse diagnostics:\n${await describeWorkbenchState(page, collapse)}`);
    });
  }
  await expect(launcher).toBeVisible();
  await page.screenshot({ path: join(evidenceDirectory, "empty-workspace-workbenches.png"), fullPage: true });
  await launcher.getByRole("button", { name: tabNames[0]!, exact: true }).click();
  await expect(page.locator(".oh-story-split-surface[data-open='true'][data-workbench='story']")).toBeVisible();
  await expect(composer).toHaveText(retainedDraft);
  return retainedDraft;
}

async function selectSession(page: Page, workspaceTitle: string): Promise<void> {
  await page.getByRole("button", { name: /^(?:Configure later|\u7a0d\u540e\u914d\u7f6e)$/u }).click({ timeout: 20_000 });
  const open = page.getByRole("button", { name: /^(?:Open sidebar|\u6253\u5f00\u4fa7\u8fb9\u680f)$/u }).first();
  if (await open.isVisible()) await open.click();
  const workspaceRow = page.getByRole("treeitem").filter({ hasText: workspaceTitle }).first();
  await expect(workspaceRow).toBeVisible({ timeout: 15_000 });
  if (await workspaceRow.getAttribute("aria-expanded") !== "true") await workspaceRow.click();
  await page.getByRole("treeitem").filter({ hasText: /^\s*(?:New Session|\u65b0\u4f1a\u8bdd)\s*$/iu }).first().click({ timeout: 15_000 });
  await expect(page.getByRole("navigation", { name: storyFilesLabel })).toBeVisible({ timeout: 20_000 });
}

async function assertFiveWorkbenches(page: Page): Promise<void> {
  const tabs = page.getByRole("tablist", { name: workspaceTabsLabel });
  await expect(tabs).toBeVisible({ timeout: 15_000 });
  await expect(tabs.getByRole("tab")).toHaveCount(tabNames.length);
  for (const name of tabNames) {
    const tab = tabs.getByRole("tab", { name, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await tabs.getByRole("tab", { name: tabNames[0]!, exact: true }).click();
}

async function assertWechatArticle(page: Page, workspaceDirectory: string, sessionId: string, origin: string): Promise<{ path: string; draft: string; saved: string }> {
  const account = "\u516c\u4f17\u53f7/demo";
  const articleRoot = `${account}/\u521b\u4f5c/article-001`;
  const path = `${articleRoot}/article.md`;
  const reference = `${account}/\u53c2\u8003\u6587\u7ae0/original.md`;
  const original = "# WeChat article\n\nOriginal body.\n\n![Local cover](images/cover.png)\n\n![External](https://preview-external.invalid/image.png)\n<script>parent.__wechatPreviewExecuted = true;</script>";
  await mkdir(join(workspaceDirectory, articleRoot, "images"), { recursive: true });
  await mkdir(dirname(join(workspaceDirectory, reference)), { recursive: true });
  await writeFile(join(workspaceDirectory, path), original, "utf8");
  await writeFile(join(workspaceDirectory, reference), "# Read-only original\n", "utf8");
  await writeFile(join(workspaceDirectory, articleRoot, "article.html"), '<h1>HTML article</h1><p style="color:rgb(22,132,91)">Typeset content</p><img src="images/cover.png"><iframe src="https://preview-external.invalid/frame"></iframe><script>parent.__wechatPreviewExecuted=true;</script>', "utf8");
  await cp(join(repositoryRoot, "scripts/demo-fixtures/media/shot-ep001-001-keyframe.png"), join(workspaceDirectory, articleRoot, "images/cover.png"));
  let externalRequests = 0;
  await page.route("https://preview-external.invalid/**", async (route) => { externalRequests += 1; await route.abort(); });
  await page.getByRole("tab", { name: tabNames[4]!, exact: true }).click();
  await page.getByRole("button", { name: "\u5237\u65b0\u9879\u76ee\u6587\u4ef6", exact: true }).click();
  await expect(page.locator(".oh-story-editor-path")).toHaveAttribute("title", path);
  const frame = page.frameLocator('iframe[title="\u516c\u4f17\u53f7\u6587\u7ae0\u9884\u89c8"]');
  await expect(frame.getByRole("heading", { name: "WeChat article", exact: true })).toBeVisible();
  await expect.poll(() => frame.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(frame.locator("script,iframe,form")).toHaveCount(0);
  for (const viewport of [{ width: 1380, height: 900 }, { width: 880, height: 640 }]) {
    await page.setViewportSize(viewport);
    await settleResponsiveLayout(page);
    const bounds = await page.locator(".oh-wechat-preview-stage iframe").boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(100);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: join(evidenceDirectory, `wechat-article-${String(viewport.width)}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1380, height: 900 });
  await settleResponsiveLayout(page);
  await page.getByRole("tab", { name: "\u6e90\u7801", exact: true }).click();
  const editor = page.locator(".oh-story-editor textarea");
  const saved = original.replace("Original body.", "Saved body.");
  await editor.fill(saved);
  await page.getByRole("button", { name: "\u4fdd\u5b58", exact: true }).click();
  await expect.poll(() => readFile(join(workspaceDirectory, path), "utf8")).toBe(saved);
  const draft = saved.replace("Saved body.", "Unsaved WeChat draft.");
  await editor.fill(draft);
  await expect(page.getByText(draftReadyText, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `${articleRoot}/article.html`, exact: true }).click();
  await page.getByRole("tab", { name: "\u9884\u89c8", exact: true }).click();
  await expect(frame.getByRole("heading", { name: "HTML article", exact: true })).toBeVisible();
  await expect.poll(() => frame.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(frame.locator("script,iframe,form")).toHaveCount(0);
  await expect(frame.getByText("Typeset content")).toHaveCSS("color", "rgb(22, 132, 91)");
  await page.getByRole("button", { name: "\u684c\u9762", exact: true }).click();
  await expect(page.locator(".oh-wechat-preview-stage")).toHaveAttribute("data-width", "desktop");
  await page.screenshot({ path: join(evidenceDirectory, "wechat-html-preview.png"), fullPage: true, animations: "disabled" });
  await page.locator(`.oh-story-tree summary[title='${account}/\u53c2\u8003\u6587\u7ae0']`).click();
  await page.getByRole("button", { name: reference, exact: true }).click();
  await page.getByRole("tab", { name: "\u6e90\u7801", exact: true }).click();
  await expect(editor).toHaveAttribute("readonly", "");
  const referenceUrl = new URL("/oh-story/file", origin);
  referenceUrl.searchParams.set("sessionId", sessionId);
  referenceUrl.searchParams.set("path", reference);
  const denied = await page.context().request.put(referenceUrl.toString(), { headers: { origin }, data: { content: "overwrite", baseVersion: "v1" } });
  expect(denied.status()).toBe(403);
  expect(await readFile(join(workspaceDirectory, reference), "utf8")).toBe("# Read-only original\n");
  expect(await page.evaluate(() => (window as unknown as { __wechatPreviewExecuted?: boolean }).__wechatPreviewExecuted)).toBeUndefined();
  expect(externalRequests, "Article previews must not load external resources.").toBe(0);
  await page.getByRole("tab", { name: tabNames[0]!, exact: true }).click();
  return { path, draft, saved };
}

async function assertNativeIpcDenied(page: Page): Promise<void> {
  // This read-only command is valid on the bundled startup page. Its rejection
  // proves local DSH content does not inherit the startup page's native grants.
  const denied = await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (internals === undefined) return true;
    try { await internals.invoke("desktop_status"); return false; }
    catch { return true; }
  });
  expect(denied, "The DSH page must not invoke native desktop commands.").toBe(true);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("The native desktop smoke currently requires Windows and WebView2.");
  const unsupported = process.argv.slice(2).filter((argument) => argument !== "--skip-build" && argument !== "--models-only");
  if (unsupported.length > 0) throw new Error("Supported arguments: --skip-build, --models-only.");
  if (!process.argv.includes("--skip-build")) {
    await runPnpm(["desktop:prepare"]);
    await runPnpm(["--filter", "@oh-story/desktop", "tauri", "build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.test.conf.json"]);
  }
  await access(executable);
  await mkdir(evidenceDirectory, { recursive: true });
  // `tmpdir()` can hand back a non-canonical path: on CI the runner's `TEMP` is the 8.3 short name
  // (`C:\Users\RUNNER~1\...`), while the desktop host canonicalizes the workspace path it stores and
  // returns (`runneradmin`). Comparing the two as strings fails, so canonicalize the fixture root
  // once here and let every derived path inherit it. `realpathSync.native()` is required — plain
  // `path.resolve()` does not expand 8.3 short names.
  const testDirectory = realpathSync.native(await mkdtemp(join(tmpdir(), "oh-story-desktop-smoke-")));
  const dataDirectory = join(testDirectory, "app-data");
  const workspaceDirectory = join(testDirectory, "desktop-story-fixture");
  const port = await freePort();
  let cdpPort = await freePort();
  while (cdpPort === port) cdpPort = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const env = isolatedEnvironment(dataDirectory, cdpPort);
  const apps: NativeApp[] = [];
  const browsers: Browser[] = [];
  let currentPage: Page | undefined;
  let completed = false;
  const onSignal = (): void => { for (const app of apps) app.child.kill("SIGKILL"); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, "desktop.json"), `${JSON.stringify({ schemaVersion: 1, port })}\n`, "utf8");
    const storyFixtures = join(repositoryRoot, "scripts", "demo-fixtures", "story");
    const fixtureName = (await readdir(storyFixtures, { withFileTypes: true })).find((entry) => entry.isDirectory())?.name;
    if (fixtureName === undefined) throw new Error("The bundled story fixture is missing.");
    const fixtureDirectory = join(storyFixtures, fixtureName);
    await mkdir(workspaceDirectory, { recursive: true });
    const chapterDirectory = "\u6b63\u6587";
    const chapterName = (await readdir(join(fixtureDirectory, chapterDirectory))).filter((name) => name.endsWith(".md")).sort()[0];
    if (chapterName === undefined) throw new Error("The story fixture has no chapter to edit.");
    const chapterPath = `${chapterDirectory}/${chapterName}`;
    const chapterAbsolutePath = join(workspaceDirectory, chapterDirectory, chapterName);
    const original = await readFile(join(fixtureDirectory, chapterDirectory, chapterName), "utf8");
    const draft = `${original}\n\nDesktop unsaved draft ${crypto.randomUUID()}\n`;

    const first = startDesktop(env);
    apps.push(first);
    const connected = await connectWebview(first, cdpPort, origin);
    browsers.push(connected.browser);
    currentPage = connected.page;
    await dismissFirstRun(currentPage);
    await assertNativeIpcDenied(currentPage);
    const initialSession = await assertFirstNewSession(currentPage, origin, workspaceDirectory);
    expect(await readdir(workspaceDirectory), "Opening workbenches must not write generated project files into an empty directory.").toEqual([]);
    await cp(fixtureDirectory, workspaceDirectory, { recursive: true });
    await currentPage.getByRole("button", { name: "\u5237\u65b0\u9879\u76ee\u6587\u4ef6", exact: true }).click();
    if (process.argv.includes("--models-only")) {
      let activeApp = first;
      let activeBrowser = connected.browser;
      const models = await assertCustomModelReasoning({
        page: currentPage,
        evidenceDirectory,
        restart: async () => {
          await stopDesktop(activeApp);
          await expect.poll(() => isListening(port), { timeout: 15_000 }).toBe(false);
          await expect.poll(() => isListening(cdpPort), { timeout: 15_000 }).toBe(false);
          await activeBrowser.close().catch(() => undefined);
          activeApp = startDesktop(env);
          apps.push(activeApp);
          const restored = await connectWebview(activeApp, cdpPort, origin);
          activeBrowser = restored.browser;
          browsers.push(activeBrowser);
          currentPage = restored.page;
          return currentPage;
        }
      });
      await stopDesktop(activeApp);
      await expect.poll(() => isListening(port), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => isListening(cdpPort), { timeout: 15_000 }).toBe(false);
      completed = true;
      process.stdout.write(`${JSON.stringify({ nativeWebview: true, ...models })}\n`);
      return;
    }
    await assertFiveWorkbenches(currentPage);
    const wechatArticle = await assertWechatArticle(currentPage, workspaceDirectory, initialSession.sessionId, origin);
    const fileButton = currentPage.locator(".oh-story-tree button[data-file-path]").filter({ hasText: chapterName }).first();
    if (!await fileButton.isVisible()) {
      const group = currentPage.locator(".oh-story-file-group > summary").filter({ hasText: chapterDirectory }).first();
      await group.click();
    }
    await fileButton.click();
    const source = currentPage.getByRole("tab", { name: "\u6e90\u7801", exact: true });
    if (await source.isVisible()) await source.click();
    const editor = currentPage.locator(".oh-story-editor textarea");
    await expect(editor).toHaveValue(original, { timeout: 15_000 });
    await editor.fill(draft);
    await expect(currentPage.getByText(draftReadyText, { exact: true })).toBeVisible({ timeout: 20_000 });
    const sessionId = await currentPage.evaluate((content) => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith("oh-story.draft-backup.v1.")) continue;
        const stored = JSON.parse(localStorage.getItem(key) ?? "null") as {
          readonly scope?: { readonly sessionId?: string };
          readonly buffers?: Readonly<Record<string, { readonly content?: string }>>;
        } | null;
        if (stored?.buffers !== undefined && Object.values(stored.buffers).some((buffer) => buffer.content === content)) return stored.scope?.sessionId;
      }
      return undefined;
    }, draft);
    if (sessionId === undefined) throw new Error("The native draft backup does not identify its original DSH session.");
    expect(sessionId, "Drafts must belong to the session created by the New Session button.").toBe(initialSession.sessionId);
    expect(await readFile(chapterAbsolutePath, "utf8"), "Draft backup must not save the source file.").toBe(original);
    await currentPage.screenshot({ path: join(evidenceDirectory, "draft-before-restart.png"), fullPage: true });

    const secondInstance = startDesktop(env);
    apps.push(secondInstance);
    const secondExit = await Promise.race([secondInstance.exit, pause(10_000).then(() => "timeout" as const)]);
    expect(secondExit, "A second desktop instance must exit without spawning another service.").toBe(0);
    expect(first.child.exitCode).toBeNull();
    expect(await isListening(port)).toBe(true);

    // Terminate only the owned GUI process: Windows Job Object cleanup must
    // close its runtime service even when ordinary exit handlers do not run.
    await stopDesktop(first);
    await expect.poll(() => isListening(port), { timeout: 15_000, message: "Desktop termination must close its owned DSH service." }).toBe(false);
    await expect.poll(() => isListening(cdpPort), { timeout: 15_000, message: "The old WebView must exit before the app data is reopened." }).toBe(false);
    await connected.browser.close().catch(() => undefined);

    const restarted = startDesktop(env);
    apps.push(restarted);
    const restored = await connectWebview(restarted, cdpPort, origin);
    browsers.push(restored.browser);
    currentPage = restored.page;
    await selectSession(currentPage, initialSession.workspaceTitle);
    await expect(currentPage.getByText("\u5df2\u6062\u590d 2 \u4efd\u672c\u5730\u8349\u7a3f", { exact: true })).toBeVisible({ timeout: 15_000 });
    const restoredSource = currentPage.getByRole("tab", { name: "\u6e90\u7801", exact: true });
    if (await restoredSource.isVisible()) await restoredSource.click();
    await expect(currentPage.locator(".oh-story-editor textarea")).toHaveValue(draft);
    const snapshot = await currentPage.context().request.get(`${origin}/oh-story/workspace?sessionId=${encodeURIComponent(sessionId)}`);
    expect(snapshot.ok(), "The original draft session must survive a full runtime restart.").toBe(true);
    await expect(currentPage.locator(".oh-story-editor-path")).toHaveAttribute("title", chapterPath);
    expect(await readFile(chapterAbsolutePath, "utf8")).toBe(original);
    await assertNativeIpcDenied(currentPage);
    await currentPage.screenshot({ path: join(evidenceDirectory, "draft-after-restart.png"), fullPage: true });
    await currentPage.getByRole("tab", { name: tabNames[4]!, exact: true }).click();
    await currentPage.getByRole("tab", { name: "\u6e90\u7801", exact: true }).click();
    await expect(currentPage.locator(".oh-story-editor textarea")).toHaveValue(wechatArticle.draft);
    expect(await readFile(join(workspaceDirectory, wechatArticle.path), "utf8")).toBe(wechatArticle.saved);
    await currentPage.screenshot({ path: join(evidenceDirectory, "wechat-draft-after-restart.png"), fullPage: true, animations: "disabled" });
    await stopDesktop(restarted);
    await expect.poll(() => isListening(port), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => isListening(cdpPort), { timeout: 15_000 }).toBe(false);
    completed = true;
    process.stdout.write(`${JSON.stringify({ nativeWebview: true, automaticAuthentication: true, firstNewSession: true, directoryPickerCancellation: true, directoryPickerRetry: true, duplicatePickerGuard: true, freshSessionCreation: true, welcomeWorkbenches: 5, emptyWorkspaceWorkbenches: 5, emptyCreationPrefill: true, existingComposerDraftPreserved: true, composerSessionIsolation: true, responsiveEmptyWorkbenches: true, automaticPromptSubmissions: 0, workbenches: 5, wechatPreview: true, wechatSave: true, wechatReferenceReadOnly: true, wechatDraftRecovery: true, singleInstance: true, draftRestartRecovery: true, ownedRuntimeCleanup: true, nativeIpcDenied: true, externalModelCalls: 0 })}\n`);
  } catch (error) {
    await currentPage?.screenshot({ path: join(evidenceDirectory, "failure.png"), fullPage: true, timeout: 5_000 }).catch(() => undefined);
    // The reporting step can only publish 3000 characters of the log's tail, and a
    // Playwright click error plus a geometry dump exceeds that on its own — which is how
    // the previous runs lost the sentence that said what actually went wrong. Handing the
    // message over in its own file lets that step publish both ends of it.
    await writeFile(join(evidenceDirectory, "failure-report.txt"), redact(error instanceof Error ? error.message : String(error)), "utf8").catch(() => undefined);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const app of apps) await stopDesktop(app).catch(() => undefined);
    for (const browser of browsers) await browser.close().catch(() => undefined);
    await writeFile(join(evidenceDirectory, "native-output.log"), redact(apps.map((app) => app.output.join("")).join("\n")), "utf8");
    for (const entry of await readdir(join(dataDirectory, "logs"), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const output = await readFile(join(dataDirectory, "logs", entry.name), "utf8");
      await writeFile(join(evidenceDirectory, `runtime-${entry.name}`), redact(output), "utf8");
    }
    try { await rm(testDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
    catch { process.stderr.write(`Temporary native test data remains at ${testDirectory}\n`); }
    if (!completed) process.stderr.write("Native desktop smoke failed; inspect test-results/desktop.\n");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
  process.exitCode = 1;
});
