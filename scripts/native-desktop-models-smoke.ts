import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

const testKey = "desktop-model-smoke-not-a-real-api-key";
const discoveredModel = "gpt6-test";
const manualModel = "gpt6-manual-test";
const responsesProvider = "desktop-responses-test";
const completionsProvider = "desktop-completions-test";
const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const labels = {
  settings: /^(?:Settings|\u8bbe\u7f6e)$/u,
  models: /^(?:Models|\u6a21\u578b)$/u,
  close: /^(?:Close|\u5173\u95ed)$/u,
  advanced: /^(?:Capacity|Advanced settings|\u5bb9\u91cf|\u9ad8\u7ea7\u8bbe\u7f6e) 1$/iu,
  reasoning: /^(?:Reasoning effort|Reasoning levels|\u63a8\u7406\u5f3a\u5ea6) 1$/iu,
  modelTrigger: /^(?:Select model|\u9009\u62e9\u6a21\u578b)/u,
  effortMenu: /^(?:Effort|Reasoning effort|\u63a8\u7406\u7b49\u7ea7)/iu
};

interface CapturedRequest {
  readonly path: string;
  readonly payload: Record<string, unknown>;
  readonly reply: string;
  readonly auxiliary: boolean;
}

interface MockOpenAi {
  readonly baseURL: string;
  readonly requests: CapturedRequest[];
  readonly discoveries: string[];
  readonly server: Server;
}

async function startMockOpenAi(): Promise<MockOpenAi> {
  const requests: CapturedRequest[] = [];
  const discoveries: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${testKey}`) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Only the isolated test key is accepted." } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      discoveries.push(request.url);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        object: "list", data: [{ id: discoveredModel, object: "model", created: 1, owned_by: "desktop-test" }]
      }));
      return;
    }
    if (request.method !== "POST" || !["/v1/responses", "/v1/chat/completions"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(body) as Record<string, unknown>; }
      catch { response.writeHead(400).end(); return; }
      const auxiliary = JSON.stringify(payload).includes("Create a concise title for an AI coding-assistant session");
      const reply = auxiliary ? "Desktop model test" : `DESKTOP_MODEL_MOCK_REPLY_${String(requests.length + 1)}`;
      requests.push({ path: request.url ?? "", payload, reply, auxiliary });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (request.url === "/v1/responses") {
        const id = `resp_desktop_${String(requests.length)}`;
        const item = { id: `${id}_message`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
        const events = [
          { type: "response.created", response: { id, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: reply },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
        ];
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } else {
        const events = [
          { id: "desktop-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
          { id: "desktop-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
        ];
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.write("data: [DONE]\n\n");
      }
      response.end();
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not start the isolated model endpoint.");
  return { baseURL: `http://127.0.0.1:${String(address.port)}/v1`, requests, discoveries, server };
}

async function openModels(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: labels.settings }).click();
  const dialog = page.getByRole("dialog", { name: labels.settings });
  await dialog.getByRole("button", { name: labels.models, exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^(?:Add (?:a )?custom provider|\u6dfb\u52a0\u81ea\u5b9a\u4e49\u63d0\u4f9b\u65b9)$/u })).toBeVisible();
  return dialog;
}

async function closeModels(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: labels.close, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function configureReasoning(dialog: Locator, mappedEffort: "high" | "medium", requestValue: string, allLevels: boolean): Promise<void> {
  await dialog.getByRole("button", { name: labels.advanced }).click();
  const reasoning = dialog.getByRole("combobox", { name: labels.reasoning });
  await expect(reasoning, "A custom OpenAI model must expose reasoning settings in its advanced controls.").toBeVisible({ timeout: 5_000 });
  await expect(reasoning).toHaveValue("inherit");
  await reasoning.selectOption("custom");
  if (allLevels) {
    for (const level of effortLevels) {
      await dialog.getByRole("checkbox", { name: new RegExp(`^(?:Enable effort|Enabled level|\u542f\u7528\u5f3a\u5ea6) ${level} 1$`, "iu") }).check();
    }
  }
  await dialog.getByRole("textbox", { name: new RegExp(`^(?:Request value|\u8bf7\u6c42\u503c) ${mappedEffort} 1$`, "iu") }).fill(requestValue);
}

async function createProvider(page: Page, mock: MockOpenAi, provider: string, protocol: string, discover: boolean): Promise<void> {
  const dialog = await openModels(page);
  await dialog.getByRole("button", { name: /^(?:Add (?:a )?custom provider|\u6dfb\u52a0\u81ea\u5b9a\u4e49\u63d0\u4f9b\u65b9)$/u }).click();
  await dialog.getByRole("textbox", { name: "Provider ID", exact: true }).fill(provider);
  await dialog.getByRole("textbox", { name: /^(?:API address|Base URL|API \u5730\u5740)$/iu }).fill(mock.baseURL);
  await dialog.getByRole("combobox", { name: /^(?:API protocol|API \u534f\u8bae)$/iu }).selectOption(protocol);
  await dialog.getByLabel(/^(?:API key|API \u5bc6\u94a5)$/iu).last().fill(testKey);
  if (discover) {
    await dialog.getByRole("button", { name: /^(?:Fetch available models|\u83b7\u53d6\u53ef\u7528\u6a21\u578b)$/u }).click();
    const picker = page.getByRole("dialog", { name: /^(?:Choose models to add|\u9009\u62e9\u8981\u6dfb\u52a0\u7684\u6a21\u578b)$/u });
    await expect(picker.getByRole("checkbox", { name: discoveredModel, exact: true })).toBeChecked();
    await picker.getByRole("button", { name: /^(?:Add selected|\u6dfb\u52a0\u6240\u9009)$/u }).click();
    await expect(dialog.getByRole("textbox", { name: /^(?:Model ID|\u6a21\u578b ID) 1$/iu })).toHaveValue(discoveredModel);
    expect(mock.discoveries.length).toBeGreaterThan(0);
  } else {
    await dialog.getByRole("button", { name: /^(?:Add model|\u6dfb\u52a0\u6a21\u578b)$/u }).click();
    await dialog.getByRole("textbox", { name: /^(?:Model ID|\u6a21\u578b ID) 1$/iu }).fill(manualModel);
  }
  await configureReasoning(dialog, discover ? "high" : "medium", discover ? "medium" : "low", discover);
  await dialog.getByRole("button", { name: /^(?:Create provider|\u521b\u5efa\u63d0\u4f9b\u65b9)$/u }).click();
  await expect(dialog.getByRole("button", { name: new RegExp(`^(?:Edit|\u7f16\u8f91) ${provider}$`, "u") })).toBeVisible();
  await closeModels(dialog);
}

async function selectModel(page: Page, model: string): Promise<void> {
  await page.getByRole("button", { name: labels.modelTrigger }).click();
  await page.getByRole("menuitem", { name: /^(?:Model|\u6a21\u578b)/u }).click();
  await page.getByRole("menuitemradio", { name: model, exact: true }).click();
  await expect(page.getByRole("button", { name: labels.modelTrigger })).toContainText(model);
}

async function selectEffort(page: Page, effort: string, expectAll: boolean): Promise<void> {
  await page.getByRole("button", { name: labels.modelTrigger }).click();
  await page.getByRole("menuitem", { name: labels.effortMenu }).click();
  if (expectAll) {
    for (const level of effortLevels) await expect(page.getByRole("menuitemradio", { name: new RegExp(`^${level}$`, "iu") })).toBeVisible();
  }
  await page.getByRole("menuitemradio", { name: new RegExp(`^${effort}$`, "iu") }).click();
  await expect(page.getByRole("button", { name: labels.modelTrigger })).toHaveAttribute("aria-label", new RegExp(effort, "iu"));
}

async function sendToMock(page: Page, mock: MockOpenAi, path: string, model: string): Promise<CapturedRequest> {
  const marker = `desktop-reasoning-${crypto.randomUUID()}`;
  const composer = page.locator("[data-composer-input]");
  await composer.fill(marker);
  await page.getByRole("button", { name: /^(?:Send message|\u53d1\u9001\u6d88\u606f)$/u }).click();
  await expect.poll(() => mock.requests.some((request) => !request.auxiliary && request.path === path && JSON.stringify(request.payload).includes(marker)), { timeout: 20_000 }).toBe(true);
  const captured = mock.requests.find((request) => !request.auxiliary && request.path === path && JSON.stringify(request.payload).includes(marker));
  if (captured === undefined) throw new Error("The local model endpoint did not capture the test prompt.");
  expect(captured.payload.model).toBe(model);
  await expect(page.getByText(captured.reply, { exact: true })).toBeVisible({ timeout: 20_000 });
  return captured;
}

interface ProviderEditor {
  readonly dialog: Locator;
  readonly editor: Locator;
}

async function editProvider(page: Page, provider: string): Promise<ProviderEditor> {
  const dialog = await openModels(page);
  const editName = new RegExp(`^(?:Edit|\u7f16\u8f91) ${provider}$`, "u");
  const edit = dialog.getByRole("button", { name: editName });
  const editor = dialog.getByRole("listitem").filter({ has: page.getByRole("button", { name: editName }) });
  await edit.click();
  const advanced = editor.getByRole("button", { name: labels.advanced });
  if (!await advanced.isVisible()) await editor.locator("summary").filter({ hasText: /^(?:Custom(?:ized)? settings|\u81ea\u5b9a\u4e49\u8bbe\u7f6e)$/iu }).click();
  await advanced.click();
  return { dialog, editor };
}

async function saveProvider(provider: ProviderEditor): Promise<void> {
  const save = provider.editor.getByRole("button", { name: /^(?:Save|Apply|\u4fdd\u5b58)$/u });
  await save.click();
  await expect(save).toHaveCount(0);
  await closeModels(provider.dialog);
}

export async function assertCustomModelReasoning(options: {
  readonly page: Page;
  readonly evidenceDirectory: string;
  readonly restart: () => Promise<Page>;
}): Promise<Record<string, boolean | number>> {
  const mock = await startMockOpenAi();
  let page = options.page;
  try {
    await page.getByRole("button", { name: "\u6536\u8d77\u521b\u4f5c\u5de5\u4f5c\u53f0", exact: true }).click();
    await createProvider(page, mock, responsesProvider, "openai-responses", true);
    await createProvider(page, mock, completionsProvider, "openai-completions", false);
    await selectModel(page, discoveredModel);
    await selectEffort(page, "high", true);
    const responses = await sendToMock(page, mock, "/v1/responses", discoveredModel);
    expect(responses.payload.reasoning).toMatchObject({ effort: "medium" });
    await selectModel(page, manualModel);
    await selectEffort(page, "medium", false);
    const completions = await sendToMock(page, mock, "/v1/chat/completions", manualModel);
    expect(completions.payload.reasoning_effort).toBe("low");

    page = await options.restart();
    const later = page.getByRole("button", { name: /^(?:Configure later|\u7a0d\u540e\u914d\u7f6e)$/u });
    await expect.poll(async () => await later.isVisible() || await page.getByRole("button", { name: labels.modelTrigger }).isVisible()).toBe(true);
    if (await later.isVisible()) await later.click();
    const persisted = await editProvider(page, responsesProvider);
    await expect(persisted.editor.getByRole("combobox", { name: labels.reasoning })).toHaveValue("custom");
    await expect(persisted.editor.getByRole("textbox", { name: /^(?:Request value|\u8bf7\u6c42\u503c) high 1$/iu })).toHaveValue("medium");
    for (const level of effortLevels) await expect(persisted.editor.getByRole("checkbox", { name: new RegExp(`^(?:Enable effort|Enabled level|\u542f\u7528\u5f3a\u5ea6) ${level} 1$`, "iu") })).toBeChecked();
    await persisted.editor.getByRole("checkbox", { name: /^(?:Enable effort|Enabled level|\u542f\u7528\u5f3a\u5ea6) max 1$/iu }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(options.evidenceDirectory, "model-reasoning-persisted.png"), fullPage: true });
    await persisted.editor.getByRole("button", { name: /^(?:Cancel|\u53d6\u6d88)$/u }).click();
    await closeModels(persisted.dialog);
    await selectModel(page, discoveredModel);
    await selectEffort(page, "max", true);

    const reduced = await editProvider(page, responsesProvider);
    await reduced.editor.getByRole("checkbox", { name: /^(?:Enable effort|Enabled level|\u542f\u7528\u5f3a\u5ea6) max 1$/iu }).uncheck();
    await saveProvider(reduced);
    await page.getByRole("button", { name: labels.modelTrigger }).click();
    await page.getByRole("menuitem", { name: labels.effortMenu }).click();
    await expect(page.getByRole("menuitemradio", { name: /^max$/iu })).toHaveCount(0);
    await page.getByRole("button", { name: labels.modelTrigger }).click();
    const reducedRequest = await sendToMock(page, mock, "/v1/responses", discoveredModel);
    expect((reducedRequest.payload.reasoning as { readonly effort?: string } | undefined)?.effort, "Removing a selected effort must clear that selection before sending.").not.toBe("max");

    const expanded = await editProvider(page, responsesProvider);
    await expanded.editor.getByRole("checkbox", { name: /^(?:Enable effort|Enabled level|\u542f\u7528\u5f3a\u5ea6) max 1$/iu }).check();
    await saveProvider(expanded);
    await selectEffort(page, "max", true);

    const disabled = await editProvider(page, responsesProvider);
    await disabled.editor.getByRole("combobox", { name: labels.reasoning }).selectOption("disabled");
    await saveProvider(disabled);
    await page.getByRole("button", { name: labels.modelTrigger }).click();
    await expect(page.getByRole("menu")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("menuitem", { name: labels.effortMenu })).toHaveCount(0);
    await page.screenshot({ path: join(options.evidenceDirectory, "model-reasoning-disabled.png"), fullPage: true });
    await page.keyboard.press("Escape");
    const withoutReasoning = await sendToMock(page, mock, "/v1/responses", discoveredModel);
    expect(withoutReasoning.payload.reasoning, "Disabling reasoning must clear any previously selected effort before sending.").toBeUndefined();
    expect(withoutReasoning.payload.reasoning_effort).toBeUndefined();
    const inherited = await editProvider(page, responsesProvider);
    await inherited.editor.getByRole("combobox", { name: labels.reasoning }).selectOption("inherit");
    await saveProvider(inherited);
    const inheritedAgain = await editProvider(page, responsesProvider);
    await expect(inheritedAgain.editor.getByRole("combobox", { name: labels.reasoning })).toHaveValue("inherit");
    await inheritedAgain.editor.getByRole("button", { name: /^(?:Cancel|\u53d6\u6d88)$/u }).click();
    await closeModels(inheritedAgain.dialog);
    return { modelDiscovery: true, manualModel: true, reasoningUi: true, reasoningMapping: true, reasoningRestartPersistence: true, removedReasoningLevel: true, reasoningDisabled: true, reasoningInheritance: true, responsesWire: true, completionsWire: true, localModelCalls: mock.requests.length, externalModelCalls: 0 };
  } finally {
    mock.server.closeAllConnections();
    await new Promise<void>((accept, reject) => mock.server.close((error) => error ? reject(error) : accept()));
  }
}
