# WeChat 全流程可控契约

本文件是新建及明确迁移任务的执行入口，不是某一篇文章的风格模板。
系统固定的是账号隔离、证据、任务版本、执行一致性和验收；作者语言、画风、版式、人物、图数及篇幅来自账号模型和本次选题。
不得把测试账号的颜色、竖幅尺寸、六张图、职场主题等写成全模块默认。

当前 DSH Agent 负责实际阅读、原创判断与语义/视觉审稿，脚本负责确定性编译、来源/产物核验、状态和副作用边界。
脚本不会训练权重、自动理解图片或给风格相似度打可信分数。检查回执始终保留 `semantic_quality_verified_by_script: false`。
上述工作由 Agent 在已授权任务内连续完成，不把 JSON 填写工作交给用户，也不为常规步骤反复索取批准。
只有账号/目标确实无法判断、必须改变用户要求、接受有限学习范围、付费或远端动作超出原授权时才请求决定。

## 1. 功能、输入、产物与完成条件

| 功能 | 权威输入和输出 | 必须执行的控制 |
| --- | --- | --- |
| 账号绑定 | `账号.json`、用户指定参考根 | 稳定账号 ID；原件只读；不同作者、生成稿和发布副本不混库 |
| 全量导入 | ingest 清单、按序正文与图片、OCR 辅助 | 不漏计不可读项；OCR、视觉阅读、语义理解是不同状态 |
| 整篇联合分析 | 每篇完整原文、每次图片引用、联合记录 | 看实际图；解释文字与动作/关系/布局共同产生的意义及序列，不拼两份孤立报告 |
| 模型提炼 | 主题/全局/图文模型及证据 | 全量分析后归纳，代表样本深析；稳定/局部/时期差异、边界与禁用项分别保存 |
| 模型验收与更新 | `模型目录.json`、`模型审稿.json`、`模型验收.json` | `style_release.py audit/seal` 校验完整覆盖、来源和联合证据；有限范围不能变成全量 ready |
| 新选题路由 | 原始请求、受众、主类、表达任务、已保存模型 | 日常不读原文；存在对应主题模型必须使用；跨主题使用全局模型必须记录边界 |
| 原创方案 | `任务输入.json`、`article.md`、`图文计划.json` | 先独立内容后风格；至少两个独有元素；事实、推断、假设分开；文案/图文关系联合策划 |
| 方案审核 | `方案审稿.json` | 审核当前输入签名；每维度有实际证据，不接受一个 reviewed=true |
| 计划锁定 | `创作记录.json` 和不可覆盖的修订快照 | `article_workflow.py lock`；保留模型快照；修改必须审核下一版本 |
| 提示词与生成 | 编译提示词、单图任务、实际请求回执 | `compile` 后原样执行；验证当前卡片、规则、资产、提供商和参数；禁止自由改题 |
| 外部图片导入 | 当前计划与实际图片 | import 绑定当前图位；导入来源是声明，不冒充模型 API 执行证明；导入后仍待审 |
| 图文成稿 | 图片、逐图审核、按序组合正文、整篇审核 | 实际尺寸/文案/画面/联合意义/风格都检查；缺图、错误或旧审核不得晋级 |
| 排版与导出 | 审核正文、账号 theme、HTML、排版检查 | 正式导出有绑定回执；未审预览单独命名；实际检查手机/桌面效果 |
| 草稿/预览/发布 | 已审成稿、已审封面、账号注册表和发布计划 | 准备及发送前重验全部依赖；用户授权和真实回执分别管理 |
| 批量与恢复 | 各文章合同、单图回执、现有发布回执 | 按实际未完成项续跑；成功图不重做；未知付费/发送结果先 reconcile |

不同任务可以从对应已有阶段继续，不要求每次重复建库或重做所有图片。查看分析/方案不触发生成，排版不触发改写，上传草稿不隐含公开发布。

## 2. 建库和模型验收

首次账号运行 `style_release.py init-account --account "{account}"`，仅补稳定 ID/名称，保留已有配置和风格。
已有发布注册表时沿用相同账号 ID；不能给同一账号另造第二身份。
接着按 build-library.md 和 visual-style.md 完成 ingest、全部文章标注和整篇联合记录。
当前模型/工具能够直接看图时，使用 `article_library.py ingest ... --visual-only` 准备原图及有界逐帧视图，无需 OCR 依赖。
动态图最多处理 200 帧且累计不超过 8000 万像素；每一帧及其显示时长都保留，超限保持待处理，不把首帧算作全文。
随后实际阅读每个正文图及每帧，联合记录需有顺序一致的 frame_reviews，变更任何帧会使对应审核失效。
`style_release.py next --account "{account}" --limit 5` 返回下一批待分析项；图文项给出完整 packet，不把批次生成当作分析完成。
读取 packet 中的原图并撰写证据、index 后继续 next，直到纳入范围全部覆盖或明确列出未解决项。

账号内的 `作者风格系统/07_处理状态/模型目录.json` 格式：

```json
{"models":[
  {"key":"global","kind":"global","file":"作者风格系统/04_作者稳定风格/作者稳定风格模型.json"},
  {"key":"topic-career","kind":"topic","topic":"职场","file":"作者风格系统/03_主题风格模型/职场_风格模型.json"},
  {"key":"visual","kind":"visual","file":"作者风格系统/04_作者稳定风格/图文风格模型.json"}
]}
```

这是目录示例，真实主题、模型种类与文件来自账号，不要求所有账号都有“职场”。文字型可没有视觉模型。
每条规则有稳定 `id/rule/how_to_apply/boundaries/stability/evidence`。文字证据保存原件哈希，逐字引句可核对；
视觉证据保存文章 ID、正文图序号和图像哈希，必须追溯到完整联合分析，不能使用身份横幅当作风格证据。
多篇证据只证明存在证据；跨主题/时间的语义稳定性仍由 Agent 实际核对，不能以数量代替判断。

```text
python "{skill}/scripts/style_release.py" audit --account "{account}" --models "作者风格系统/07_处理状态/模型目录.json"
python "{skill}/scripts/style_release.py" seal --account "{account}" --models "作者风格系统/07_处理状态/模型目录.json" --review "作者风格系统/07_处理状态/模型审稿.json"
```

audit 返回 `input_signature`、覆盖数量、未解决文章、未覆盖主题和模型证据错误。
Agent 实际审稿后写审核记录（格式见下文），检查项为 `full_content/topic_coverage/joint_style/identity/transferability`。
只有审核绑定当前输入、无关键缺项才允许 seal 为 ready。范围不足且用户明确接受时，可用 `--limited-reason "真实授权与限制"` 保存 limited，
但错误/伪造证据不能通过 limited 绕过。每日写作还需任务内记录 `limited_model_acceptance`，不能将一次试验默认为永久接受。
模型验收保存本地 release、模型哈希和历史版本。日常 `check` 只检查保存模型，不扫描参考根；原件离线不影响已验收模型的使用。
新增/修改资料只在建库更新时重新审核相关证据；不删除人工规则，不自动把旧 ready 字段升级为新证书。

## 3. 单篇任务、可变风格与固定约束

每篇位于 `创作/<稳定文章ID>/`。Agent 创建 `任务输入.json`（schema_version=1）：

- 身份与意图：`account_id/article_id/user_request/topic/audience/goal/primary_category/expression_task`。
  `user_request` 保存用户当次原话；topic 等是本次路由结果，不能擅自替换为另一个主题。
- 形式与规则：`content_mode`、`selected_models`（模型目录 key 数组）、`constraints`、`forbidden_terms`。
  覆盖账号默认形式必须有 `form_override_reason`，来自用户明确要求。
  无对应主题模型时写 `transfer_reason`，只在模型边界内迁移，不假装有该主题专属经验。
- 原创与事实：`originality` 至少两个不同的本题元素；`facts` 是数组。
  每项 `kind` 为 fact/inference/hypothetical，并有 claim/basis；事实另有可核对的 source/verified=true。
  不需事实来源的原创假设场景应明确是示例，不能伪称真实经历或调查结果。
- 篇幅：用户或账号规定长度时填写 `length_budget`，basis 为 body/image_text/outside_text，min/max 为去空白字符界限；
  正文计数不含首行 H1，保留 Markdown 源标记。计数口径与目标必须明确，不用图片文字量冒充外置正文长度。
- 执行选择：`image_provider` 指定提供商 ID；未接 API 时可为 manual。没有密钥或不支持能力就保留 pending，不能改用别的模型。

`article.md` 是精确文案/正文源；`图文计划.json` 使用 schema_version=2，包含：

```json
{
  "schema_version":2,
  "content_mode":"mixed",
  "title":"本篇实际标题",
  "style_rule_ids":["global/G-01"],
  "opening":"",
  "closing":"",
  "cards":[{
    "id":"body-01","order":1,"role":"body",
    "text":{"title":"","body":"","dialogue":[],"labels":[]},
    "scene":"符合本篇内容的具体可见场景",
    "layout":"依据已保存账号规则确定的布局",
    "text_image_relation":"这幅图如何与对应正文共同表达本篇观点",
    "style_rule_ids":["visual/V-01"],
    "alt":"真实图意的简短替代文本",
    "anchor":"正文中唯一出现的插图锚点原句",
    "requirements":{"aspect_ratio":[3,2],"text_rendering":"none"},
    "parameters":{"size":"1536x1024"},
    "references":[],
    "output":"images/body-01-v1.png"
  }]
}
```

示例只说明字段，不是所有账号通用的风格模板：比例与服务尺寸需在实际任务中协调一致，尺寸能力不支持时先改方案或设计明确裁切流程，不能忽略要求。
真实角色、配色、字体、尺寸及张数必须来自本次选用模型，系统不提供一种画风覆盖全部账号。
`text` 允许全部为空，因此照片/无字插画并不被强制做成标题卡。图中文字中的道具标签也要进入 labels。
`role=cover` 表示仅封面，不插入正文；image-led 的每图精确文字必须在 article.md 中，mixed 使用唯一 anchor；纯文字任务 cards 可为空。
参考图必须是独立授权并保存于本文章 `assets/` 的素材，不静默回读参考文章目录。

## 4. 审核、锁定和提示词编译

```text
python "{skill}/scripts/article_workflow.py" inputs --account "{account}" --article "{article}"
python "{skill}/scripts/article_workflow.py" lock --account "{account}" --article "{article}" --revision 1
python "{skill}/scripts/article_workflow.py" compile --article "{article}" --card body-01
```

inputs 返回当前整篇输入签名。先实际审核当前方案再写 `方案审稿.json`，检查项为 `topic/style/originality/facts/identity/form`。
所有语义审核采用一致结构，示意如下；不得复制示意中的“证据”作为真实审稿：

```json
{
  "input_signature":"工具返回的当前签名",
  "reviewer":"实际审稿者或本次Agent会话标识",
  "reviewed_at":"带时区的实际审核时间",
  "unresolved":[],
  "checks":{
    "topic":{"passed":true,"evidence":"实际正文位置、判断依据及与原始需求的对应"}
  }
}
```

每个要求的检查项都必须写真实证据；不能把“通过、已核对”复制到所有维度，更不能用布尔值自动填充代替读内容。
lock 写入既有 `创作记录.json` 的 controlled-wechat-v1 版本，归档精确输入和选用模型。
compile 是确定性编译，不再让模型重新理解成另一个选题：写出每图提示词和 article_images.py 兼容任务。
调用前会重新从当前锁定计划计算提示词；改文案、改模型、改参数或手工换提示词，即使同步改一个哈希，也不能绕过检查。
聊天生图也必须执行相同编译提示词，不得先看到失败后又临时用泛化提示词发散；聊天环境不能传递完整约束时，不声称已经受控执行。

内容变更后审核并 lock 下一 revision。每个图位签名只包含它实际依赖的规则、内容、资产和参数；未改变图位继续复用已采用图及回执。
改变一张图时只为该图指定新 output 版本；旧文件不覆盖。改整体主题、共同角色要求或共同风格时，受影响图位全部重新审核。
模型文件变化需要先完成模型新版本验收。只改 HTML theme 不需要重写文章或重新生图，但必须重做排版审核。
旧 `style-model-v1` 创作记录需有完整输入和新审核后显式 `lock --migrate`；脚本保存原记录，绝不自动伪造历史审核。

## 5. 模型执行、替换与人工导入

默认已集成提供商保持原执行方式。其他模型的 Python adapter 可实现两个无网络预检函数：

```python
def describe_image_provider(name):
    return {"name": name, "required_env": ["MY_IMAGE_KEY"],
            "reference_images": True, "native_text": False,
            "sizes": ["1536x1024"]}

def compile_image_payload(name, payload):
    # 校验并返回将要发送给当前提供商的请求；不得忽略不支持的约束。
    return {"prompt": payload["prompt"], **payload["parameters"]}
```

CLI 仍接收 `python adapter.py <provider>`，从 stdin 读取 JSON，使用执行环境密钥（不写进返回值），
将单张图片保存到 payload.output_root 下，返回 `{"outputs":[{"target":"计划输出相对路径","source":"实际临时图片路径"}]}`。
adapter 必须将校验过的 prompt/references/parameters 原样传递；编译器返回值只用于预检与签名，不是外部实际执行的自动证明。
发布新 adapter 前，用模拟接口捕获请求并测试它发送的内容；需要服务 request_id 时返回脱敏 provider_job_id。
`requirements.text_rendering=model` 需要原生文字能力，none 禁止有计划文字，overlay 则使用无字底图加精确程序排字，最终合成图仍走同样审核。
不承诺模型随机输出一定相同；保证的是不合格结果不自动进入正式成稿、记录真实调用并只修复失败部分。

未接生图模型时，保存编译计划和提示词、等待实际图片。已有可访问文件时用 import_article_image.py 导入指定图位。
导入器不根据来源字符串伪造 provider 回执，不把聊天里显示过的图片当成本机已存在；仍需实际核对文案、布局、角色和意义。
付费请求在派发前建立独占回执。调用未知结果不会自动重试；成功结果按签名复用。能力缺失不能降级为不符合形式的纯文字。

## 6. 实际成稿、排版和发布

逐图审查后写 `图文检查.json`（schema_version=2、cards 数组）。每项包含 id、该图 input_signature、output_sha256、
reviewer/reviewed_at/unresolved、五个 IMAGE_CHECKS，以及 `observed_text` 精确列表。
observed_text 按 title/body/dialogue/labels 的顺序记录实际看到的文字；空文字图用 []，多余标语或凭空数据同样算不符。
当前脚本不 OCR 认证审稿，不会把“识别文字相同”当成“联合风格成立”。

```text
python "{skill}/scripts/article_workflow.py" assemble --article "{article}"
python "{skill}/scripts/article_workflow.py" review-target --article "{article}"
python "{skill}/scripts/article_workflow.py" check --article "{article}"
python "{skill}/scripts/render_article.py" "{article}/article-illustrated.md" --output "{article}/article.html" --theme "{account}/排版/theme.json"
```

assemble 按计划生成正文，不插入内部生图指令。需要替换旧组成稿时 `--replace` 先保存历史。
按 review-target 的当前签名，实际整篇审稿后写 `成稿审稿.json`，维度 topic/style/originality/facts/identity/sequence。
正式 HTML 仅从已审 article-illustrated.md 导出，输出绑定审核的 article.html.receipt.json。
未完成稿可 `render_article.py ... --draft --output "{article}/draft-preview.html"`，不能覆盖正式 article.html 或当作已验收。
查看实际窄屏/桌面 HTML 后，`排版检查.json` 绑定导出回执的规范 JSON SHA256，检查 mobile/desktop/images/typography。
可以用本脚本模块的 checksum 函数计算；审核仍由实际看过预览的 Agent 填写。

受控公众号任务的 publication prepare 和发送前 load_bundle 会重验：账号、终稿、原始请求/模型/计划、实际图片及审核、封面、HTML、排版和主题。
标题或主题不得在发布阶段静默改写；账号注册表 id 必须和账号.json 一致。
`reviewed=true` 只是发布计划中原有声明，不代替以上条件。单独的非项目手工 Markdown API 用例保留原行为，不得用它复制受控文章来规避审核。
远端动作、排期和回执继续遵守 publishing.md，未执行真实微信/付费接口不得称为 live 验收通过。

## 7. 恢复与验收范围

`article_workflow.py status --article "{article}"` 从真实依赖推导 blocked/images_pending/review_pending/reviewed，给出未完成图位及原因。
`style_release.py next` 用于建库待分析队列，现有 publication_plan/wechat_publish 负责多账号批次与定时条件。
不启动并行 Agent、隐藏轮询线程或新全局调度器。部署系统排期需要明确授权和真实部署验证。
发生中断先检查锁 PID、修订归档和外部回执，不删除整个任务目录、不清空未知回执来强行重做。

回归必须覆盖不同账号/风格、text/mixed/image-led、原文离线、单图修改、错误主题/模型/提示词、图片缺失/错字、假数据、审核失效、模型能力缺失和发布拦截。
模拟图片、模拟接口和合成审核记录只验证控制流程，不证明真实作者学习或实际成图质量。
完整账号验收需要真实全库联合分析、实际新文章图文成品及真实审核；公众号投递另做已授权 live 验收。
