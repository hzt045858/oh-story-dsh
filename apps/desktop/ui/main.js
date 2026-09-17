"use strict";

const title = document.getElementById("title");
const message = document.getElementById("message");
const actions = document.getElementById("actions");
const spinner = document.getElementById("spinner");
const actionError = document.getElementById("action-error");

async function invoke(command) {
  if (!window.__TAURI__?.core?.invoke) throw new Error("桌面连接不可用，请重新打开 Oh Story。");
  return window.__TAURI__.core.invoke(command);
}

async function refresh() {
  try {
    const status = await invoke("desktop_status");
    const failed = status.state === "error";
    title.textContent = failed ? "工作台未能启动" : "正在启动创作工作台";
    message.textContent = status.message || "";
    spinner.hidden = failed;
    actions.hidden = !failed;
  } catch (error) {
    title.textContent = "桌面连接不可用";
    message.textContent = String(error);
    spinner.hidden = true;
  }
}

for (const [id, command] of [["retry", "desktop_retry"], ["logs", "desktop_open_logs"], ["data", "desktop_open_data"]]) {
  document.getElementById(id).addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    actionError.textContent = "";
    try {
      await invoke(command);
      if (id === "retry") await refresh();
    } catch (error) {
      actionError.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}

void refresh();
setInterval(refresh, 700);
