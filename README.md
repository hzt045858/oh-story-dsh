<div align="center">

# oh-story-dsh

**小说、短剧、互动游戏、视频解说与公众号创作工作台**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Oh Story](https://github.com/zenstory-ai/oh-story-claudecode) · [Drama Skills](https://github.com/zenstory-ai/drama-skills) · [NovelToGame](https://github.com/zenstory-ai/novel-to-game) · [video-recap-skills](https://github.com/zenstory-ai/video-recap-skills) · [MIT](LICENSE)

</div>

`oh-story-dsh` 是基于 DeepSeek Harness（DSH）构建的社区插件，把小说、短剧、互动游戏、视频解说与公众号五类创作带进 DSH。DSH 管理 Agent、会话、模型、权限和 Chat；插件提供创作 Skills、专业 Roles、项目协议与对应工作台。

> 本项目与 DeepSeek 官方无隶属、合作或背书关系；DeepSeek Harness 名称与品牌素材归其权利人所有。

## 小说工作台

![小说工作台](docs/images/story-workbench-demo.gif)

文件树、编辑器、Chat 三栏。覆盖长篇、短篇、选题、扫榜、拆文、导入、审稿、去 AI 味与封面流程，13 个 Oh Story Skills 与 7 个专业 Roles 按固定上游版本随插件交付。

## 短剧工作台

![短剧工作台](docs/images/drama-workbench-demo.gif)

每集按请求维护最多五份可读 Markdown：`剧本.md`、`视觉设定.md`、`分镜.md`、`图片提示词.md`、`视频提示词.md`。「生产」视图把这些文档投影为镜头板、素材板、任务/版本、成片顺序和关系画布，并就地提示重复 ID、悬空引用与格式错误。生产交付走 DSH 原生会话、当前 Preset 工具与权限确认。

## 游戏工作台

![游戏工作台](docs/images/game-workbench-demo.gif)

左侧实时试玩、右侧 DSH Chat 的两列布局。`/novel-to-game quick` 的生成物写入 `game-adaptations/<project>/`，`build/app/index.html` 就绪后自动进入项目列表，可刷新、全屏、切换项目。内置《金瓶梅 · 风月总账》完整可玩构建，开箱即可验证输入、核心循环、结局与重开。

## 视频工作台

![视频工作台](docs/images/video-workbench-demo.gif)

同样是预览左、Chat 右。项目放在 `video-recaps/<project>/`：原片在 `sources/`，上游工作产物在 `work/`，交付在 `outputs/`。工作台提供原片/剪后片/成片切换、阶段提示、运行清单与质检产物查看，视频经 HTTP Range 流式预览。在 Chat 里直接描述目标即可：

```text
给 /path/to/video.mp4 做一个 3 分钟中文解说成片，保留关键原声，字幕烧进画面。
把 /path/to/english.mp4 翻译成中文配音，保留原说话人的声音。
```

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
资料扫描/检索使用 Python 3.10+ 标准库；排版、字卡、发布另需安装
`packages/knowledge/wechat/skills/wechat-article/scripts/requirements.txt`。
生图可以复用已打包的图片 provider adapter，需在实际执行环境配置 `OPENAI_API_KEY`，
或使用当前 Preset 可见的图片工具。没有生图能力时会保留提示词并明确待生成状态。
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
- **安全编辑**：支持源码编辑与快捷保存；人工未保存内容不会被并发 Agent 修改覆盖。小说/短剧编辑器的未保存草稿自动备份到当前浏览器，刷新或重启 DSH 后，在相同地址打开同一工作区的原会话即可恢复；写入作品文件仍需手动保存。清除站点数据、换浏览器或更换地址（包括端口）后无法共享原备份。
- **稳定长对话**：消息区独立滚动，官方 Composer 固定在 Chat 栏底部。
- **不占用其他场景**：只有当前 workspace 存在小说、短剧、游戏或视频项目时，工作台才接管会话布局；随时可收起，收起后会话回到 DSH 原生形态，选择按 workspace 记住。

各工作台的能力边界与协议约束见[架构说明](docs/ARCHITECTURE.md)。

## 能力目录

| 工作台 | 上游能力 | 主要入口 |
| --- | --- | --- |
| 小说 | [Oh Story 0.7.9](https://github.com/zenstory-ai/oh-story-claudecode/releases/tag/v0.7.9) · 13 Skills · 7 Roles | `/story`、`/story-long-write`、`/story-review` |
| 短剧 | [Drama Skills 0.6.5](https://github.com/zenstory-ai/drama-skills/releases/tag/v0.6.5) · 10 Skills | `/short-drama`、`/short-drama-write`、`/short-drama-storyboard` |
| 游戏 | [NovelToGame 0.3.0](https://github.com/zenstory-ai/novel-to-game) · 7 Skills · 《金瓶梅》可玩示例 | `/novel-to-game quick`、`/game-build`、`/game-qa` |
| 视频 | [video-recap-skills 0.4.0](https://github.com/zenstory-ai/video-recap-skills) · 6 Skills | `/video-recap`、`/video-script` |

## Windows 桌面版

新增 Tauri 2 桌面入口，沿用小说、短剧、游戏、视频、公众号五个工作台，并随包携带 Node.js 24、DSH 和本项目插件。
桌面程序自动启动本地 DSH，支持托盘驻留，使用独立的数据目录保存会话、配置和草稿。

源码启动使用 `pnpm desktop`，生成完整便携版使用 `pnpm desktop:portable`，生成安装包使用 `pnpm desktop:build`。
构建需要 Windows x64、Node.js 24、Rust、Visual Studio C++ Build Tools 和 WebView2。
便携版必须保留 EXE 旁边的 `runtime` 目录；模型凭据、Python 和 ffmpeg 等制作依赖仍需配置。
现有浏览器里的未保存草稿不会自动转入桌面版，请先保存到作品文件。
完整启动、数据位置、打包和测试说明见 [桌面版说明](docs/DESKTOP.md)。

## 安装

安装命令会临时提供 pnpm；只安装 Node.js 的机器也能执行。DSH 的 `plugin add` 内部需要 pnpm，单独运行 `npx @deepseek-ai/dsh ... plugin add` 不会自动补上它。

需要 Node.js 24+。视频工作台的流水线还需要宿主机安装 Python 3.10+ 与带 libass `subtitles` 滤镜的 ffmpeg/ffprobe（macOS `brew install ffmpeg`，Debian/Ubuntu `sudo apt install ffmpeg`）。

**1. 安装插件并启动 DSH Web**

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.2-rc.1 dsh plugin --profile web add @oh-story/dsh@0.1.8 &&
npx -y @deepseek-ai/dsh@0.1.2-rc.1 web
```

也可以直接安装 GitHub Release 中经过同一套测试的预构建包：

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.2-rc.1 dsh plugin --profile web add https://github.com/zenstory-ai/oh-story-dsh/releases/download/v0.1.8/oh-story-dsh-0.1.8.tgz &&
npx -y @deepseek-ai/dsh@0.1.2-rc.1 web
```

保持终端运行，浏览器默认自动打开。如果没有自动打开，请复制终端打印的完整 `http://127.0.0.1:3080/?token=...` 链接访问；首次认证需要链接里的 token。关闭终端会停止服务。

**2. 配置模型**

开始 AI 创作前需要在 DSH 的「设置 → 模型」中添加 Provider 并填入 API Key；也可以在启动前设置环境变量 `DEEPSEEK_API_KEY`。如果只查看已有作品，可在首次引导中选择「稍后配置 / Configure later」。模型、凭据与权限均由 DSH 管理，本插件不接触。

**3. 配置媒体生成 API（短剧生产需要）**

DeepSeek 只负责写剧本、分镜和提示词，本身不会生图、生视频或生音乐。短剧的「生产」把这些提示词交给 `short-drama-produce` Skill，由它调用下面的供应商 API 生成媒体。Key 不在界面里填，而是在启动 DSH 之前写入宿主机环境变量：

| 能力 | 供应商 | 必需环境变量 | 可选 |
| --- | --- | --- | --- |
| 图片 | GPT Image 2 | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| 视频 | Seedance（火山方舟） | `ARK_API_KEY`、`SEEDANCE_MODEL` | `SEEDANCE_BASE_URL`、`SEEDANCE_ALLOWED_RATIOS`、`SEEDANCE_MIN_DURATION`/`SEEDANCE_MAX_DURATION` |
| 视频 | MiniMax H3 | `MINIMAX_API_KEY`、`MINIMAX_VIDEO_MODEL`、`MINIMAX_VIDEO_RESOLUTIONS` | `MINIMAX_VIDEO_BASE_URL`、`MINIMAX_VIDEO_RATIOS`、`MINIMAX_VIDEO_MIN_DURATION`/`MINIMAX_VIDEO_MAX_DURATION` |
| 音乐 | MiniMax Music | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` |

```bash
export OPENAI_API_KEY=...            # 图片
export ARK_API_KEY=... SEEDANCE_MODEL=...   # 视频，模型/Endpoint ID 以账号开通的为准
npx -y @deepseek-ai/dsh@0.1.2-rc.1 web
```

只配置用得到的那几个即可：没有视频 Key 仍然可以写分镜、生成关键帧图片。短剧工作台的「生产」视图顶部会显示每个供应商是否已配置、缺哪个变量；插件只报告变量是否存在，从不读取或展示 Key 的值。插件启动时会把这四个内置 adapter 登记到一份不含凭据的配置文件（默认在系统临时目录下仅当前用户可读写的 `oh-story-dsh-<uid>/` 里，「生成环境」条会显示完整路径），Agent 运行 `production_tool.py run` 时直接引用它；自己写 adapter 或改超时，就把文件路径写进 `OH_STORY_DRAMA_ADAPTER_CONFIG`。每个供应商的参数、分辨率与时长约束见随包的 `short-drama-produce/references/providers/`。

视频解说工作台另用 `MIMO_API_KEY`（Fish Audio TTS 另需 `FISH_API_KEY`），小说封面则使用当前 Preset 里可见的图片生成工具。

**4. 开始创作**

首次进入首页即可看到「小说 / 短剧 / 游戏 / 视频 / 公众号」五个入口。点击左侧 Workspaces 旁的 **＋（添加工作区 / Add workspace）**，选择存放作品的文件夹，再打开对应会话；也可以直接点击首页工作台入口选择目录。

空目录也能打开五个工作台。小说、短剧和公众号的「开始创作」会在当前 Chat 输入框准备相应指令，由用户发送；已有未发送内容会保留。查看已有作品不需要 API Key。收起后可点击会话区的分类入口重新打开。

## 没看到界面时

- **安装报 `pnpm not found on PATH`**：重新执行上面带 `--package pnpm@11.7.0` 的完整安装命令，确认安装成功后再启动。
- **浏览器未打开或要求认证**：打开终端打印的完整带 `?token=...` 链接；端口被占用时用 `web --port 3081`，并访问新打印的链接。
- **没有五个创作标签**：确认已更新插件或完整绿色版，重启 DSH 并刷新页面。已有作品仍不显示时，确认当前会话打开了作品所在目录；公众号默认选择包含 `公众号/` 子目录的工作区。
- **独立 `story` profile 没有网页服务**：按下节补上 `@deepseek-ai/dsh-web-app`，仅安装创作插件不会给新 profile 添加 Web 界面。

## 按需加载

插件装进哪个 profile，那个 profile 的每个 Session 就都会加载创作 Skills；工作台只在有创作项目时显示。想让原版 `web` 保持干净、只在创作时打开工作台，就把插件装进独立 profile。

**1. 装进独立 profile**

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.2-rc.1 dsh plugin --profile story add @oh-story/dsh@0.1.8
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
npx -y @deepseek-ai/dsh@0.1.2-rc.1 web                          # 原版 DSH
npx -y @deepseek-ai/dsh@0.1.2-rc.1 --profile story --port 3081  # 创作工作台
```

两个 profile 用不同端口可以同时运行。模型、凭据、workspace 与历史会话由 DSH 统一保存，切换 profile 不会丢。安装与启动请使用同一个 dsh 版本，混用会报 `unknown option '--no-open'` 一类的错。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：提供原生插件运行时、Agent、会话、权限审批与 Web 工作台基础。
- [LINUX DO](https://linux.do/)：感谢社区的交流、反馈与开源支持。

[更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [架构说明](docs/ARCHITECTURE.md) · [安全策略](SECURITY.md)
