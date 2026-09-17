# 图片正文的风格分析与调用

用于图片承担主要正文的账号；纯装饰配图、二维码、水印、广告不作为正文或可迁移风格。
保留 V5.0 的全量索引、代表样本、先主题后全局、证据、身份过滤与原创边界。
增加图片观察维度，不要求对每张图片写同等深度的长篇分析。

## 全量识别与视觉阅读

按文章记录正文图片的真实顺序、来源、文件 SHA256、尺寸和角色，区分封面、正文卡片、截图和平台模板。
同图按哈希去重观察，但保留每次正文引用及所在文章；同一篇文章的图片不另算多篇文章。
根据全部文章的实际内容判断主要形式为 `text`、`mixed` 或 `image-led`，记录篇数、时间差异和判断依据。
旧文章文字型、近期漫画卡片型时保留两种模式，说明账号默认采用哪种，不把单篇载体冒充跨时间恒定特征。

OCR 只辅助识别图片中的标题、解释和台词。保存原文与提取副本的对应关系、低置信文字和校对状态。
自动提取入口为 `article_library.py ingest`，来源、每图顺序/哈希、OCR 低置信行和提取视图见图文提取 manifest。
脚本不会自动把视觉、文字复核置为完成；必须阅读实际图片后更新对应文章标注。
图片文字用于判断语言与排版风格，不自动扩写成散文。必须同时查看实际画面，不能只凭 OCR 文本或
“漫画由 AI 生成”的声明判断画风。可用带 ID 的联系表批量观察，细节看不清时打开原图。
无法下载、打开或视觉读取的项分别记为待处理；OCR 完成不等于视觉分析完成。
可用 --visual-only 直接准备原图和动画的完整有界帧序列，不强制 OCR 依赖。packet 的 frame_views 保留每帧哈希和时间。
动画对应 unit 必须有逐帧 frame_reviews（index/frame_sha256/observation）；含横幅等排除项也要看完全部帧后再判断角色。
没有看完所有帧不能填满模板声称完成。默认限制 200 帧、累计 8000 万像素，超限需另做有界媒体审阅。

全量文章卡片增补：主要形式、图片顺序、每图文字功能、画面内容、图文关系、系列结构及视觉读取状态。
代表样本覆盖主题、时间、画风、卡片布局和整组结构；在已有代表样本基础上补齐视觉维度，不重建有效文字规则。

## 保存可独立调用的规则

### 先整篇联合观察，再提炼模型

分析单位是完整图文文章，不是孤立 OCR 段落或孤立配色报告。执行：

```text
python "{skill}/scripts/article_joint.py" packet --account "{account}" --id ART-001
```

阅读返回的整篇 packet：图外正文保留原顺序，每个图片槽位对应原图文件和哈希。使用当前 Agent
的可见看图工具依次查看全部图片；联系表看不清的打开单图。OCR 文件只是辅助核字，不能替代画面。
识别标题、解释、对白/内心话分别属于谁，人物动作与表情、道具、空间关系提供了什么额外信息。
判断图文是在相互说明、补充、对比、反讽还是因果演示，并说明拿掉画面会丢失什么。
不能把“口语化文字 + 淡彩漫画”当成联合分析结论，也不能把内心话误判为说出口的对话。

保存 `作者风格系统/02_文章卡片/图文联合分析/<文章ID>-<版本>.json`：

- 顶层：`schema_version: 1`、`workflow: "joint-article-v1"`、`status: "draft"/"reviewed"`、
  `article_id/source_sha256/analysis_input_sha256`、`observation_method`、`unresolved`。
- `units` 覆盖所有图片引用且保留顺序：`order/image_sha256/role`。正文 role 为 `body`，记录
  `text_evidence/visual_evidence/text_image_relation/joint_meaning/without_image_loss/reading_path/article_function/uncertainties`。
  `reading_path` 是含文字和画面关注点的数组。无图中文字时明确写没有文字，并结合图外正文分析。
  其他 role 为 `identity/advertisement/decoration`，保留 `visual_evidence/excluded_reason`，不得静默漏图。
- `sequence`：`body_orders`，`organization/opening/development/ending/outside_text_role`，以及相邻正文图之间的
  `transitions: [{from_order,to_order,relation}]`。并列清单不强行解释为时间推进；没有结尾总结卡就明确记录。
- `transfer_rules`：每条有 `id/rule/evidence_orders/how_to_apply/boundaries`；证据只能引用已分析正文图，
  不能将账号横幅、广告或水印作为可迁移风格。视觉不能证明的时间、身份、心理动机必须与图中文字的说法区分。

上述证据可以分维度记录，但 `joint_meaning` 和整篇 `sequence` 必须给出联合结论。
完成实际复核、关键疑点处理后才能设 `reviewed`；再执行：

```text
python "{skill}/scripts/article_joint.py" check --account "{account}" --record "作者风格系统/02_文章卡片/图文联合分析/ART-001-v1.json"
```

将返回的 `joint_analysis_file/joint_analysis_sha256` 写入该篇文章标注，再运行 index。
原图、提取版本或联合记录变化会使审核失效；仅有 `content_reviewed/visual_reviewed` 两个标记不能通过。
脚本只检查证据结构、完整顺序和来源绑定，不判断分析内容真假，返回 `semantic_quality_verified_by_script: false`。
不可用自动填充的模板通过质量验收。多个主题的完整文章交叉验证后，才更新下面的持久化模型。
有限篇数的试验模型保持 `draft` 和真实覆盖范围，不将两篇验证等同于全库风格已完成。

此要求用于建库/更新/追溯阶段。日常新选题仍只读取已保存模型，不因此重新读原文或原图。

输出 `作者风格系统/04_作者稳定风格/图文风格模型.md` 和 `.json`；主题差异补入对应主题模型。
模型必须包含以下维度，并区分已观察、推断与待核实：

- 内容形式：默认交付形式、正文图片与外置文字各承担什么内容、是否有独立封面和结尾卡。
- 图片文字：标题、观点、解释、台词的语气与长度；编号、句式、情绪、标题与解释的关系。
- 文字视觉：字体类别与粗细、字号层级、对齐、行距、留白、文字区域和气泡。无法确认具体字体名时只描述可见特征。
- 画面：漫画/照片/图表等类型、线条、上色、光影、人物比例与表情、动作、场景和道具。
- 布局：画幅比例、文字与画面位置及面积、背景、配色、边距、视觉焦点。只有实际测量才能给精确统计。
- 图文关系：文字提出判断、人物演示动作、台词揭示矛盾等；不是一句“加办公室插画”。
- 多图结构：开场、分点推进、编号、每图信息量、转折、结尾与全篇节奏。
- 主题适配、变化范围、禁用身份/水印/广告及不能迁移的具体内容。

模型 JSON 使用 `schema_version: 1`、`status`（`draft`/`ready`）、`default_content_mode`、`scope`、
`coverage`、`rules`。规则保存 `id/dimension/rule/evidence/stability/how_to_apply/boundaries`。
视觉证据保存文章 ID、正文图片序号、图片 SHA256 和 `observation`；文字逐字证据另保存
`evidence_type: "verbatim"`、`quote` 与校对状态；转述用 `summary`，不能伪造引句。
图片序号按文章引用顺序，不能从导出文件名后缀推测。

`coverage` 分别记录全文内容分析数量、视觉阅读文章/图片数量、代表样本和未解决项。
只有全量范围已核对、主要规则有跨样本图片证据、关键视觉问题已解决，才将完整模型标为 `ready`。
有限样本模型可保存为 `draft` 并在用户接受范围后供样张探索，但不得声称已完成全库图文风格分析。
新创作还需 workflow-control.md 的模型验收记录，模型内部 ready 字段本身不构成发布/创作门禁。
模型须包含完整执行规则，不能以“照某张原图”代替描述。日常创作只加载模型，不重读原图；
人物一致性等需附加参考图时使用独立保存的、已授权的风格资产并记录用途，不默默回读原文。

## 新选题的图片正文

用户明确指定形式时优先；否则沿用模型的 `default_content_mode`，账号配置记录形式及模型路径。
`image-led` 默认任务包含实际生成正文图片，用户说“写文章”不需要再次指定“配图”。
只有分析、推荐选题、查看模型或明确只要文案时，不触发生图。
模型缺少视觉维度时返回分析补足阶段，不能把纯文字结果称为符合图片型作者风格。

先确定原创观点和全篇推进，再按已保存的图文规则拆成图：每张包含精确文字、文字角色与位置、
人物动作、场景道具、构图配色、图文关系及衔接。数量、篇幅与画幅按账号模型和选题决定，
不把所有选题硬塞成四图，也不强制先写一篇千字散文再机械压缩。
图片文字总量、单图信息量和外置正文长度分别按实际样本统计；用户明确字数仍优先。

保存 `图文计划.json`（新任务 `schema_version: 2`，完整契约见 [workflow-control.md](workflow-control.md)）：

```json
{
  "schema_version": 2,
  "content_mode": "image-led",
  "title": "本篇实际标题",
  "style_rule_ids": ["global/G-01"],
  "opening": "",
  "closing": "",
  "cards": [
    {
      "id": "card-01",
      "order": 1,
      "role": "body",
      "text": {"title": "本图观点", "body": "精确解释文字", "dialogue": []},
      "scene": "具体人物、动作、场景与道具",
      "layout": "文字层级、位置、画面区域与配色",
      "text_image_relation": "画面怎样表达或补充本图文字",
      "style_rule_ids": ["visual/V-01"],
      "alt": "实际图意的简短描述",
      "requirements": {"aspect_ratio": [2, 3], "text_rendering": "model"},
      "parameters": {"size": "1024x1536"},
      "references": [],
      "output": "images/card-01-v1.png"
    }
  ]
}
```

计划中的规则 ID 对应实际模型，创作记录包含文字和图文模型文件哈希、采用规则与形式。
精确文案保存在 `article.md`；审核后由 article_workflow.py compile 确定性生成 prompts/ 和单图任务，不放进对外正文。
上述比例仅是结构示例；所有实际尺寸和画幅均由账号规则、本题与服务能力确定，不能固定套用于所有文章。
执行与图片校验按 [images-and-layout.md](images-and-layout.md)。漫画型需要真实插画；
程序纯文字卡不能替代其画面。可用实际生成的无字插画底图叠加精确文字，须保持模型规定的布局并检查合成结果。

## 完成条件

实际图片均生成并审核后，用 article_workflow.py assemble 在 `article-illustrated.md` 按顺序组成正文，外置文字只承担模型规定的功能。
不要同时粘贴一份千字散文造成重复阅读。图片替代文本可概述图中信息，保持可访问性。
逐图检查文字准确、字形、边界、画面与观点对应、整组一致性及身份过滤；记录于 `图文检查.json`：
新任务 `图文检查.json` 使用 schema_version=2，cards 每项包含 id/input_signature/output_sha256、实际 observed_text、
审稿者与时间，以及 text/scene/joint_meaning/style/identity 的逐项 passed/evidence，具体见 workflow-control.md。
旧版 text_checked/visual_checked/style_checked 仅供旧文件检查，不能自动迁移为新审核依据。
OCR 可以辅助错字检查，不能代替视觉检查；检查文件不是自证质量，须留下审稿说明。

执行 `scripts/check_image_article.py <文章目录>` 检查文件、计划、哈希和检查记录；
它不理解画面，也不验证图片文字，不能替代 Agent 审稿。
尚无实际图片或检查未通过时，状态为 `images_pending` 或 `review_pending`，即使已有文字稿或 HTML 也不能记为图文完成。
没有可用生图能力时保存计划和提示词，清楚报告待生成及缺少的能力，不能默认降为纯文字交付。
