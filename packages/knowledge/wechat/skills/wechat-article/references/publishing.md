# 微信图文交付与多账号发布

新建及明确迁移的公众号文章受 [workflow-control.md](workflow-control.md) 约束。
prepare 与发送前 load_bundle 对账号模型、任务、成稿、图片、封面、语义审核和 HTML 排版审核重新校验；
reviewed=true 不再是受控任务的唯一放行条件。旧的独立手工 Markdown API 用例兼容保留，但不能用其绕过受控文章审稿。

本流程接在 V5.0 的全年文章建库、选题写作与审稿之后。`{skill}` 是 Skill 资源目录，
`{registry}` 通常为 `公众号/accounts.json`，`{plan}` 是当前批次计划 JSON。
脚本使用官方微信接口；不依赖第三方付费排版服务，不另起 Agent、浏览器进程或发布服务器。

## 1. 账号配置

以 [accounts.example.json](../assets/accounts.example.json) 建立注册表，替换示例 AppID。
每个账号的 root 相对于注册表目录，且不能互相包含；一个 AppID 只能注册一次。
root 对应已有的 V5 账号目录，保留其中的原始参考文章、模型和创作记录。
注册表 id 与该目录账号.json 的稳定 id 必须一致。

- `app_id` 是当前账号的公开应用标识；`secret_env` 只保存环境变量名称。
- 密钥由实际运行 Python 的环境读取，例如 `WECHAT_CAREER_APP_SECRET`。不写进项目、命令参数或对话。
- 不回退到其他账号或全局未区分账号的密钥。模型配置与微信凭据是两个独立配置。
- `author` 是用户提供的新署名，可空；`theme_preset` 支持 default、professional-clean、minimal、newspaper。
- `accounts` 只检查本地配置和环境变量是否存在，不证明微信接口权限或 IP 白名单已开通。

```text
python "{skill}/scripts/wechat_publish.py" accounts --registry "{registry}"
```

首次实际调用前，用该账号后台查看可用接口权限，将实际执行服务器 IP 配入白名单。
平台可能要求管理员确认、认证或受发布配额限制，以当前账号与接口返回为准。
无 API 权限时可使用当前 DSH 可见、已登录的浏览器人工流程；逐项核对账号和实际回执，
不要启动第三方 Skill 内的 Chrome/CDP 服务或复制其他账号登录状态。

## 2. 审稿、封面与排版

按 write-article.md 完成内容、风格、身份和差异化审稿，再准备图片。
按 images-and-layout.md 生成/选择真实图片；正文中只引用文章目录内的本地文件。
透明图片、大尺寸图片在发布准备阶段另存为适合上传的副本，原件不变；动画图需先选定静态版本。

可以直接使用已集成的 wewrite 主题颜色：

```text
python "{skill}/scripts/render_article.py" "文章目录/article-illustrated.md" --output "文章目录/article.html" --preset professional-clean
```

也可用账号 `排版/theme.json` 覆盖颜色、字号、行距和段距；`--theme` 与 `--preset` 可同时使用。
发布渲染移除 Markdown 首个 H1，标题进入微信标题字段；其余正文原样保留。
外部链接转为正文内编号与文末 URL，微信文章链接保留。样式全部内联，不执行原始 HTML。
微信正文使用上传接口返回的图片地址，本地预览中的 data URL 不用于草稿上传。

## 3. 批次计划与离线准备

参考 [publish-plan.example.json](../assets/publish-plan.example.json)。每个 job 对应一个账号的一份草稿，
包含 1～8 篇文章。不同账号即使引用同题文章，也要各自审稿、采用自己的模型、署名、主题和根目录。

article 项的 `article`、`cover`、可选 `theme` 都相对于所选账号 root。
可覆盖 `title`（默认首个 H1）、`author`、`digest`、`source_url`、`theme_preset`、
`need_open_comment`（0/1）、`only_fans_can_comment`（0/1）。实际审稿完成后才设 `reviewed: true`。
标题不超过 32 字，作者不超过 16 字，单图文摘要不超过 120 字；多图文不填写摘要。
对受控任务，title 只能与已锁定标题一致，theme 必须与已审 HTML 配置一致，cover 必须来自已计划并实际审核的图片。
正文使用 article-illustrated.md，不能把 image-led 的内部 article.md 文案当作完整图片文章上传。
如需封面裁切，在 article 中指定 `cover_crop: {"2.35_1": [x1,y1,x2,y2], "1_1": [...]}`，
坐标归一化到 [0,1]，依据实际画面确定；上传后在手机预览核对裁切。

delivery 的意义：

| 值 | 动作 | 是否推送关注者 |
| --- | --- | --- |
| publish | `/freepublish/submit` 公开发布草稿 | 否 |
| mass | `/message/mass/sendall` 群发草稿 | 是，按 audience |

mass 必须明确 `audience: {"all": true}` 或 `audience: {"tag_id": 42}`。
同一份草稿只能选择一种交付动作，成功后草稿会被平台消耗，不能再拿旧 media_id 做第二种动作。
job 可指定 `not_before: "2026-09-15T08:00:00+08:00"`；必须带时区。
该时间限制正式发布/群发，允许提前准备草稿。

```text
python "{skill}/scripts/wechat_publish.py" prepare --registry "{registry}" --plan "{plan}"
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action draft
```

prepare 无网络调用，生成 `账号/发布/<plan-id>/<job-id>/publication.json`、正文 HTML、
`preview-N.html` 与压缩后的 media 副本；记录原文、图片、参数、账号和产物哈希。
第二条不带 `--run`，只检查准备结果并列出目标。打开实际 preview 检查桌面与窄屏效果。
修改正文、图片或计划后使用新的 job 版本重新准备，保留旧回执；不要仅换 ID 绕过未核实的重复发布。

## 4. 草稿上传、回读与更新

当用户已要求上传草稿时，直接完成该范围内的图片上传、草稿创建和回读，不逐步重复询问。
仅要求生成文章、排版或准备发布方案时，不执行外部写入。

```text
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action draft --run
python "{skill}/scripts/wechat_publish.py" drafts --registry "{registry}" --account career --offset 0 --count 20
```

脚本依次上传正文图、上传永久封面素材、创建草稿并调用 draft/get。
媒体缓存与 media_id 按 AppID 隔离，成功步骤会复用；对比回读的标题、署名、正文、图片和封面。
一个账号失败不会重做已成功账号；结果写到计划旁的 `.results.json` 与 `.results.md`。

更新既有草稿：为修订内容建立新 job，在 job 中填 `draft_media_id`，再 prepare 并执行 action draft。
脚本要求文章数量相同，通过 draft/update 按序更新，保留更新前的远端副本。
数量变化时建立新草稿。修改后重新回读、预览并校验，不沿用旧版的发布结论。

只处理指定任务时加 `--jobs career-001,life-001`，按 ID 精确选择，不隐式匹配全部账号。

## 5. 预览、正式发布与群发

用户要求发送手机预览时，使用明确提供的接收者 OpenID：

```text
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action preview --jobs career-001 --openid "接收者OpenID" --run
```

“上传草稿”“发送预览”“公开发布”“群发”是不同范围。执行前确保本次用户请求已经涵盖
目标账号、当前终稿和对应动作；范围已经明确时继续执行，不增加逐步确认。
用户要求建设这些功能并不等于授权向真实账号上传或群发测试文章。

```text
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action publish --jobs career-001 --run
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action mass --jobs life-001 --run
python "{skill}/scripts/wechat_publish.py" run --registry "{registry}" --plan "{plan}" --action status --run
```

发布前再次检查本地版本与微信草稿是否改变。submit 返回 ID 仅记 `publish_submitted` 或 `mass_submitted`。
查询后才更新为 published、mass_sent、审核失败或其他真实状态。群发使用稳定 clientmsgid，
默认遇转载判断停止；不关闭微信账号自身的群发保护。管理员确认和配额以微信后台为准。
群发接口的 SEND_SUCCESS 说明群发任务成功，不保证每位关注者都收到，也不虚构送达人数。

## 6. 排期、续跑与异常核对

执行 run 时未到 not_before 的任务返回 scheduled；脚本本身不常驻，也不会唤醒已关闭的电脑。
如用户需要无人值守排期，由现有 DSH/系统调度器定时运行同一命令，再运行 status；
必须实际部署并验证调度器后才报告“定时任务已启用”。同一个 job 已提交时只查状态，不重复投递。

网络超时可能发生在微信已经接受操作之后。回执中的 unknown 不能作为“失败，可重发”的依据。
手机预览的 unknown 独立保留在回执和结果的 actions 中，不覆盖草稿、公开发布或群发的状态，
也不阻止查询正式投递结果；同一任务对同一接收者的未知预览仍不会自动重发。
先查看该账号草稿箱或发布记录，找到真实远端 ID 后核对：

```text
python "{skill}/scripts/wechat_publish.py" reconcile --registry "{registry}" --plan "{plan}" --job career-001 --kind draft --remote-id "已核实的media_id"
```

kind 还可为 publish 或 mass，分别传 publish_id、msg_id。草稿核对会验证全文；发布/群发查询
只证明任务属于当前账号且可查询，操作者还要在后台确认该 ID 对应本次文章，不能随便挑一个成功 ID。
草稿更新中断后，远端全部内容与准备结果一致时也可用 kind draft 核对；部分更新需先在后台检查并完成修订。
只有图片上传中断、且草稿/发布尚未提交时，可以执行
`wechat_publish.py retry-media --registry "{registry}" --plan "{plan}" --job career-001`，
再继续原 draft 命令。它保留历史，仅允许重试不确定的媒体上传，可能留下未使用的重复素材；
不会清除草稿和投递历史。不可通过删除整个发布目录来重新发送。
进程意外终止留下 `.publish.lock` 时，先核对其中 PID 确实已退出，再移除这一把锁，保留所有回执。

删除未发布草稿仅在用户明确要求时执行 action delete，引用当前 job；它不负责删除已发布文章。
发布失败后修订、换图或换账号，需要建立可审查的新任务版本。

## 官方接口依据

2026-09-09 核对的中文文档：

- https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken.html
- https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add
- https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_submit.html
- https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_get.html
- https://developers.weixin.qq.com/doc/subscription/api/notify/message/api_sendall.html
- https://developers.weixin.qq.com/doc/subscription/api/notify/message/api_massmsgget.html

第三方参考可能滞后，例如部分文档仍写摘要 128 字；这里采用官方最新的 120 字。
