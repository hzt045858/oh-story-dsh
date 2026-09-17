<p align="center">
  <img src="https://zenstory.ai/brand/zenstory-ai-mark.svg" alt="" width="76" height="76">
</p>

<h1 align="center">Oh Story DSH</h1>

<p align="center">
  <b>小说、短剧、互动游戏、视频解说与公众号创作工作台，装进 DeepSeek Harness。</b>
</p>

<p align="center">
  <a href="https://zenstory.ai/zh/dsh"><b>项目主页</b></a>
  &nbsp;·&nbsp;
  <a href="#安装"><b>安装</b></a>
  &nbsp;·&nbsp;
  <a href="#开始创作"><b>开始创作</b></a>
  &nbsp;·&nbsp;
  <a href="README_EN.md"><b>English</b></a>
</p>

<p align="center">
  <a href="https://github.com/zenstory-ai/oh-story-dsh/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/zenstory-ai/oh-story-dsh?style=flat-square&color=22D3EE&logo=github&logoColor=white&label=Stars"></a>
  <a href="https://github.com/zenstory-ai/oh-story-dsh/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/zenstory-ai/oh-story-dsh?style=flat-square&color=081431&label=Release"></a>
  <img alt="Workbenches 5" src="https://img.shields.io/badge/Workbenches-5-081431?style=flat-square">
  <a href="./LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/License-MIT-1F6FEB?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/zenstory-ai/oh-story-dsh/issues"><img alt="GitHub Issues" src="https://img.shields.io/badge/GitHub%20Issues-181717?style=for-the-badge&logo=github&logoColor=white"></a>
</p>

![小说工作台](docs/images/story-workbench-demo.gif)

`oh-story-dsh` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的社区插件，与 DeepSeek 无隶属关系。它把小说、短剧、互动游戏、视频解说与公众号五条创作流水线装进 DSH：DSH 负责 Agent、会话、模型、权限和 Chat，插件负责创作 Skills、专业 Roles、项目协议和对应的工作台。

- **小说**：文件树、编辑器、Chat 三栏，13 个 Oh Story Skills 与 7 个专业 Roles 随插件交付。
- **短剧**：每集维护剧本、视觉设定、分镜、图片与视频提示词，「生产」视图投影为镜头板与素材板，成片由 `/short-drama-edit` 装配。
- **游戏**：`/novel-to-game quick` 生成可玩构建，左侧实时试玩、右侧 Chat。
- **视频解说**：给本地视频做中文解说成片或配音翻译，原片、剪后片、成片就地预览。
- **公众号**：按 `公众号/<账号>/` 组织文章、风格模型与排版成果，`/wechat-article` 负责建库、写作、配图与草稿箱发布。

## 安装

需要 Node.js 24+。安装命令会临时提供 pnpm，只装了 Node.js 的机器也能执行：

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile web add @oh-story/dsh@0.1.9 &&
npx -y @deepseek-ai/dsh@0.1.5-rc.1 web
```

保持终端运行，浏览器默认自动打开。如果没有自动打开，请复制终端打印的完整 `http://127.0.0.1:3080/?token=...` 链接访问；首次认证需要链接里的 token。关闭终端会停止服务。

开始 AI 创作前，在 DSH 的「设置 → 模型」中添加 Provider 并填入 API Key，或在启动前设置环境变量 `DEEPSEEK_API_KEY`。只查看已有作品可在首次引导中选择「稍后配置 / Configure later」。

npm 上的 `@oh-story/dsh` 由上游仓库维护，内容等于上游的四条流水线。本仓库自研的**公众号工作台**与 **Windows 桌面版**不在其中：要拿到它们，请从本仓库 GitHub Release 安装预构建包（把下面命令里的仓库地址换成本仓库），桌面版见 [Windows 桌面版](#windows-桌面版)。

<details>
<summary>从 GitHub Release 安装预构建包</summary>

GitHub Release 中的预构建包经过同一套测试：

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile web add https://github.com/zenstory-ai/oh-story-dsh/releases/download/v0.1.9/oh-story-dsh-0.1.9.tgz &&
npx -y @deepseek-ai/dsh@0.1.5-rc.1 web
```

DSH 的 `plugin add` 内部需要 pnpm，命令里的 `--package pnpm@11.7.0` 就是为此准备的。

</details>

<details>
<summary>视频工作台的宿主机依赖</summary>

视频工作台的流水线还需要宿主机安装 Python 3.10+ 与带 libass `subtitles` 滤镜的 ffmpeg/ffprobe（macOS `brew install ffmpeg`，Debian/Ubuntu `sudo apt install ffmpeg`）。视频解说另用 `MIMO_API_KEY`（Fish Audio TTS 另需 `FISH_API_KEY`）。

插件按 `python3` → `python` 的顺序挑第一个满足 3.10 的解释器。要固定用某个解释器，把 `OH_STORY_PYTHON` 设成它的绝对路径——设了就优先，即使探测失败也如实报错，而不会悄悄改用别的解释器。

</details>

<details>
<summary>公众号工作台的宿主机依赖</summary>

资料扫描与检索只用 Python 3.10+ 标准库；排版、字卡与发布另需安装 `packages/knowledge/wechat/skills/wechat-article/scripts/requirements.txt`。生图可以复用已打包的图片 provider adapter（需配置 `OPENAI_API_KEY`），或使用当前 Preset 里可见的图片工具；没有生图能力时会保留提示词并明确待生成状态。

插件按 `python3` → `python` 的顺序挑第一个满足 3.10 的解释器。要固定用某个解释器，把 `OH_STORY_PYTHON` 设成它的绝对路径。

</details>

<details>
<summary>配置媒体生成 API（短剧生产需要）</summary>

DeepSeek 负责写剧本、分镜和提示词；生图、生视频、生音乐由短剧「生产」交给 `short-drama-produce` Skill，再调用下面的供应商 API 完成。Key 在启动 DSH 之前写入宿主机环境变量：

| 能力 | 供应商 | 必需环境变量 | 可选 |
| --- | --- | --- | --- |
| 图片 | GPT Image 2 | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| 视频 | Seedance（火山方舟） | `ARK_API_KEY`、`SEEDANCE_MODEL` | `SEEDANCE_BASE_URL`、`SEEDANCE_ALLOWED_RATIOS`、`SEEDANCE_MIN_DURATION`/`SEEDANCE_MAX_DURATION` |
| 视频 | MiniMax H3 | `MINIMAX_API_KEY`、`MINIMAX_VIDEO_MODEL`、`MINIMAX_VIDEO_RESOLUTIONS` | `MINIMAX_VIDEO_BASE_URL`、`MINIMAX_VIDEO_RATIOS`、`MINIMAX_VIDEO_MIN_DURATION`/`MINIMAX_VIDEO_MAX_DURATION` |
| 音乐 | MiniMax Music | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` |

```bash
export OPENAI_API_KEY=...            # 图片
export ARK_API_KEY=... SEEDANCE_MODEL=...   # 视频，模型/Endpoint ID 以账号开通的为准
npx -y @deepseek-ai/dsh@0.1.5-rc.1 web
```

只配置用得到的那几个即可：没有视频 Key 仍然可以写分镜、生成关键帧图片。短剧工作台的「生产」视图顶部会显示每个供应商是否已配置、缺哪个变量；插件只检查变量是否存在。插件启动时会把这四个内置 adapter 登记到一份不含凭据的配置文件（默认在系统临时目录下仅当前用户可读写的 `oh-story-dsh-<uid>/` 里，「生成环境」条会显示完整路径），Agent 运行 `production_tool.py run` 时直接引用它；自己写 adapter 或改超时，就把文件路径写进 `OH_STORY_DRAMA_ADAPTER_CONFIG`。每个供应商的参数、分辨率与时长约束见随包的 `short-drama-produce/references/providers/`。小说封面使用当前 Preset 里可见的图片生成工具。

</details>

## Windows 桌面版

新增 Tauri 2 桌面入口，沿用小说、短剧、游戏、视频、公众号五个工作台，并随包携带 Node.js 24、DSH 和本项目插件。
桌面程序自动启动本地 DSH，支持托盘驻留，使用独立的数据目录保存会话、配置和草稿。

源码启动使用 `pnpm desktop`，生成完整便携版使用 `pnpm desktop:portable`，生成安装包使用 `pnpm desktop:build`。
构建需要 Windows x64、Node.js 24、Rust、Visual Studio C++ Build Tools 和 WebView2。
便携版必须保留 EXE 旁边的 `runtime` 目录；模型凭据、Python 和 ffmpeg 等制作依赖仍需配置。
现有浏览器里的未保存草稿不会自动转入桌面版，请先保存到作品文件。
完整启动、数据位置、打包和测试说明见 [桌面版说明](docs/DESKTOP.md)。

## 开始创作

首次进入会先看到 DSH 首页。点击左侧 Workspaces 旁的 **＋（添加工作区 / Add workspace）**，选择存放作品的文件夹，再在下方 **选择工作区 / Choose workspace** 中选中该目录，DSH 会打开一个空白会话；也可以从左侧打开已有会话。目录里已有创作项目时，会显示「小说 / 短剧 / 游戏 / 视频 / 公众号」五个工作台标签。

空目录会保留 DSH 原生 Chat。配置好模型后，输入 `/story`、`/short-drama`、`/novel-to-game quick`、`/video-recap` 或 `/wechat-article` 开始创作；Agent 写出第一个创作文件后，工作台会自动出现。查看已有作品不需要 API Key。工作台收起后，可通过会话区的「创作工作台」按钮重新打开。

下面的请求复制改一改就能用，替换方括号内容后发送。

**视频解说**，在 Chat 里直接描述目标：

```text
给 /path/to/video.mp4 做一个 3 分钟中文解说成片，保留关键原声，字幕烧进画面。
把 /path/to/english.mp4 翻译成中文配音，保留原说话人的声音。
```

**已有稿件，第一轮只讨论续写方案**，先把方向谈清楚，再决定是否落到项目文件：

> 我想规划这部自有或已获授权小说的下一场戏。只阅读当前 workspace 中我点名的 [章节文件] 和 [设定文件]；[末尾片段] 尚未写完，不要把它算成完整章节。先列出与下一场戏有关的已知事实、视角人物目前知道的事，以及尚缺或冲突的信息。再给两个续写方向，分别说明人物要什么、阻力是什么、行动造成什么可见变化；不要提前揭示 [秘密]，停在 [场景边界]。本轮只在 Chat 回复，不创建、移动或改写任何文件，不生成正文或调用媒体服务；不清楚的地方列为问题，不补成既定事实。

选定方向后，再明确要求按随包流程导入或规划，并把“是否写文件、是否写正文、写到哪一章”说清楚；保留原稿备份。

## 没看到界面时

- **安装报 `pnpm not found on PATH`**：重新执行上面带 `--package pnpm@11.7.0` 的完整安装命令，确认安装成功后再启动。
- **浏览器未打开或要求认证**：打开终端打印的完整带 `?token=...` 链接；端口被占用时用 `web --port 3081`，并访问新打印的链接。
- **没有五个创作标签**：先添加作品目录并打开会话。空目录需要先在 Chat 中运行创作命令，生成创作文件后工作台才会出现；已收起的工作台可用会话区的「创作工作台」按钮恢复。已有作品仍不显示时，检查安装与启动是否使用同一个 profile，重启 DSH 并刷新页面。公众号默认选择包含 `公众号/` 子目录的工作区。
- **独立 `story` profile 没有网页服务**：按下方「按需加载」一节补上 `@deepseek-ai/dsh-web-app`，新 profile 需要单独添加 Web 界面。

## 小说工作台

文件树、编辑器、Chat 三栏（见顶部演示）。覆盖长篇、短篇、选题、扫榜、拆文、导入、审稿、去 AI 味与封面流程，13 个 Oh Story Skills 与 7 个专业 Roles 按固定上游版本随插件交付。

## 短剧工作台

![短剧工作台](docs/images/drama-workbench-demo.gif)

每集按请求维护最多五份可读 Markdown：`剧本.md`、`视觉设定.md`、`分镜.md`、`图片提示词.md`、`视频提示词.md`。「生产」视图把这些文档投影为镜头板、素材板、任务/版本、成片顺序和关系画布，并就地提示重复 ID、悬空引用与格式错误。成片装配交给 `/short-drama-edit`：它把排定的镜序写成《剪辑单.md》，再渲染到 `剧集/<EP>/制作成果/成片/`。生产交付走 DSH 原生会话、当前 Preset 工具与权限确认。

## 游戏工作台

![游戏工作台](docs/images/game-workbench-demo.gif)

左侧实时试玩、右侧 DSH Chat 的两列布局。`/novel-to-game quick` 的生成物写入 `game-adaptations/<project>/`，`build/app/index.html` 就绪后自动进入项目列表，可刷新、全屏、切换项目。内置《金瓶梅 · 风月总账》完整可玩构建，开箱即可验证输入、核心循环、结局与重开。

## 视频工作台

![视频工作台](docs/images/video-workbench-demo.gif)

同样是预览左、Chat 右。项目放在 `video-recaps/<project>/`：原片在 `sources/`，上游工作产物在 `work/`，交付在 `outputs/`。工作台提供原片/剪后片/成片切换、阶段提示、运行清单与质检产物查看，视频经 HTTP Range 流式预览。

## 公众号工作台

首页与会话工作台均提供独立的「公众号」入口，按 `公众号/<账号>/` 组织文章、风格文件与排版成果。
支持 Markdown/HTML 源码编辑、手机/桌面预览、本地配图、版本校验保存和未保存草稿恢复。
`参考文章/` 下的原文只读；文章预览禁用脚本和外部资源，不会自动上传或发布。

新增本项目维护的 `/wechat-article`，先全量阅读分析参考文章，建立文章索引、
分主题、全局与图文风格模型；后续按“新选题 + 已保存风格模型”写作，无需再次读取原文。图片型账号同时分析
图片文字、画面、图文关系与多图结构，OCR 仅辅助读字，默认生成实际图片正文。支持独立账号目录、
增量资料审计、断点续做、封面/正文配图、程序字卡与微信 HTML 排版。建库使用同一账号
全年全部参考文章，代表样本用于深入验证；新增资料或要求更新风格时才进入增量分析。
缺少实际正文图片或尚未完成图文审稿时保持待生成/待审状态，文字稿和提示词不算图片文章完成。

```text
/wechat-article 分析这个参考文章目录，为“职场号”建立风格库
/wechat-article 新选题：领导突然不再安排重要工作，写完整正文
/wechat-article 给这篇文章配封面和必要插图，再导出本地图文
/wechat-article 将本周审核完成的文章上传到职场号、生活号各自的草稿箱
/wechat-article 按发布计划公开发布职场号文章，群发生活号文章，并查询结果
```

通过现有 DSH Chat 使用。已内置账号注册、发布准备、封面/正文图片上传、草稿创建与更新、
指定接收者预览、公开发布、按标签/全体群发、状态查询和回执恢复。公开发布与群发分别处理，
提交任务不会被当作已完成。批次可设置带时区的最早发布时间；无人值守执行需接入实际调度器。
微信账号配置仅保存 AppID 与密钥环境变量名，各账号的素材、草稿与回执隔离；实际调用需具备
微信接口权限和 IP 白名单。配置及命令见 [发布流程](packages/knowledge/wechat/skills/wechat-article/references/publishing.md)。
六个参考项目已登记固定版本；MIT/Apache 参考资源与主题按许可随包分发，AGPL/受限项目的
对应功能自行实现，见 [集成说明](packages/knowledge/wechat/skills/wechat-article/references/integrated-references.md)。
方法来源、17 节要求映射与适配说明见
[来源说明](packages/knowledge/wechat/skills/wechat-article/references/sources.md)。

## 核心体验

- **实时文件跟随**：Agent 调用官方文件工具时，目标文件自动定位，编辑器同步呈现生成中的内容。
- **Chat 文件导航**：点击官方 Chat 中的作品文件名，文件树会定位并在编辑器打开对应文件。
- **创作文档预览**：Markdown 支持标题、表格、任务列表、引用和代码块；JSONL 以带行号、类型和状态的结构化记录呈现。
- **项目媒体库**：自动汇总当前 workspace 中各集和交付目录的真实图片/视频成果，支持搜索、类型筛选与跨集引用。
- **真实生成契约**：可选内置 GPT Image 2、Seedance 与 MiniMax Music adapter；账号、模型、凭据与可用性由 DSH 运行环境和项目外配置决定。
- **安全编辑**：支持源码编辑与快捷保存；人工未保存内容不会被并发 Agent 修改覆盖。
- **稳定长对话**：消息区独立滚动，官方 Composer 固定在 Chat 栏底部。
- **不占用其他场景**：只有当前 workspace 存在小说、短剧、游戏、视频或公众号项目时，工作台才接管会话布局；随时可收起，收起后会话回到 DSH 原生形态，选择按 workspace 记住。

各工作台的能力边界与协议约束见[架构说明](docs/ARCHITECTURE.md)。

## 能力目录

| 工作台 | 上游能力 | 主要入口 |
| --- | --- | --- |
| 小说 | [Oh Story 0.7.10](https://github.com/zenstory-ai/oh-story-claudecode/releases/tag/v0.7.10) · 13 Skills · 7 Roles | `/story`、`/story-long-write`、`/story-review` |
| 短剧 | [Drama Skills 0.7.0](https://github.com/zenstory-ai/drama-skills/releases/tag/v0.7.0) · 11 Skills | `/short-drama`、`/short-drama-write`、`/short-drama-storyboard`、`/short-drama-edit` |
| 游戏 | [NovelToGame 0.3.1](https://github.com/zenstory-ai/novel-to-game) · 7 Skills · 《金瓶梅》可玩示例 | `/novel-to-game quick`、`/game-build`、`/game-qa` |
| 视频 | [video-recap-skills 0.5.0](https://github.com/zenstory-ai/video-recap-skills) · 6 Skills | `/video-recap`、`/video-script` |
| 公众号 | 本项目自研 · 1 Skill · 6 个登记参考项目 | `/wechat-article` |

## 按需加载

插件装进哪个 profile，那个 profile 的每个 Session 就都会加载创作 Skills；工作台只在有创作项目时显示。想让原版 `web` 保持干净、只在创作时打开工作台，就把插件装进独立 profile。

**1. 装进独立 profile**

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile story add @oh-story/dsh@0.1.9
```

**2. 补上界面**

新 profile 默认没有界面。编辑 `~/.dsh/profiles/story/package.json`，把 `dsh.profile.bundles` 改成：

```jsonc
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@oh-story/dsh"
]
```

`@deepseek-ai/dsh-web-app` 是 DSH 自带的 Web 界面包，需要在创作插件之前加载。

**3. 按需启动**

```bash
npx -y @deepseek-ai/dsh@0.1.5-rc.1 web                          # 原版 DSH
npx -y @deepseek-ai/dsh@0.1.5-rc.1 --profile story --port 3081  # 创作工作台
```

两个 profile 用不同端口可以同时运行。模型、凭据、workspace 与历史会话由 DSH 统一保存，切换 profile 不会丢。安装与启动请使用同一个 dsh 版本，混用会报 `unknown option '--no-open'` 一类的错。

## 常见问题

**用 DeepSeek 写小说，一定要装插件吗？** 只讨论一个梗概或修改一段自带文本，用普通模型聊天就够，自己把结果放回稿件即可；要围绕本地作品目录持续创作、在工作台里看文件，再装 DSH 加本插件。想用账户化的网页项目，可选 [ZenStory 托管工作台](https://app.zenstory.ai)，具体区别见[写作环境对比](https://zenstory.ai/zh/compare/writing-workflows)。

**查看已有作品需要 API Key 吗？** 不需要。首次引导选择「稍后配置」，打开作品目录就能浏览文件；开始 AI 创作时再配置模型。

**分镜或游戏设计写好了，成片和可玩构建从哪来？** 短剧成片由 `/short-drama-edit` 按《剪辑单.md》渲染，需要先配置媒体生成 API；游戏构建由 `/game-build` 生成，就绪后自动进入游戏工作台的项目列表。

**公众号文章会自动发出去吗？** 不会。草稿创建、公开发布与群发是三个独立动作，提交任务不会被当作已完成；实际调用还需要微信接口权限与 IP 白名单。缺图或未完成图文审稿的文章会停在待生成/待审状态。

## 延伸阅读

- [DeepSeek 写小说指南](https://zenstory.ai/zh/dsh/deepseek-novel-writing)：选择作品目录、配置宿主模型，再给出题材、视角与本轮停靠点。
- [导入与续写](https://zenstory.ai/zh/oh-story/import-and-continue)：分清已完成章节、未完成片段、必须保留的设定和下一段范围。
- [短剧角色一致性](https://zenstory.ai/zh/drama-skills/character-consistency)：分清身份、造型与逐镜状态。
- [有后果的游戏选择](https://zenstory.ai/zh/novel-to-game/meaningful-choices)：明确行动代价、可见变化和后续承接。
- [原声与旁白分工](https://zenstory.ai/zh/video-recap/original-audio-and-narration)：先列出关键台词、画面依据和需要解说的空隙。
- [写作环境对比](https://zenstory.ai/zh/compare/writing-workflows)：普通聊天、DSH 插件与托管工作台各适合什么。
- [公众号建库与写作](packages/knowledge/wechat/skills/wechat-article/references/workflow-control.md)：受控契约、任务锁定与风格模型的验收方式。
- [公众号发布流程](packages/knowledge/wechat/skills/wechat-article/references/publishing.md)：账号配置、草稿箱、预览、发布与群发。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：提供原生插件运行时、Agent、会话、权限审批与 Web 工作台基础。
- [LINUX DO](https://linux.do/)：感谢社区的交流、反馈与开源支持。

[更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [架构说明](docs/ARCHITECTURE.md) · [安全策略](SECURITY.md)
