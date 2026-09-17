# 参考项目集成方式

六个项目统一登记在 [upstreams.json](../../../upstreams.json)，记录仓库、固定提交、许可证与集成方式。
第三方文件的原始许可证随包保留，见 [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md)。

| 项目 | 当前接入点 | 文件集成 |
| --- | --- | --- |
| imraywang/wewrite | 写作后审稿、图片和排版分开、草稿回读；渲染器实际读取其三套主题颜色 | MIT 主题与审稿/发布参考快照 |
| JimLiu/baoyu-skills | 按信息类型组织插图提示词、账号选择和凭据隔离 | MIT 提示词构造与多账号参考快照 |
| aiworkskills/wechat-article-skills | 草稿上传、封面与正文图分别处理、发布状态和前置检查 | Apache-2.0 API 与发布检查参考快照 |
| isjiamu/gzh-design-skill | 内联 HTML、主题参数、排版检查与手机预览 | 保留来源；排版器自行实现，未分发 AGPL 主题 |
| op7418/guizang-social-card-skill | 固定尺寸封面字卡、正文信息卡、PNG 导出 | 保留来源；article_card.py 自行实现，未分发 AGPL 模板 |
| geekjourneyx/md2wechat-skill | CLI、账号配置、发布前检查与流水线 | 保留来源；使用自行实现的官方 API 脚本，未分发其受限源码/模板 |

这里集成的是可维护的参考资源和功能，不把六套原有 Agent 配置、确认策略和路径规则叠加到 DSH。
全年文章先全量阅读分析并保存风格模型，日常写作按新选题调用模型；参考项目中的范文检索流程
不能替代全量分析，也不能成为每次创作的前置要求。当前流程以本项目 SKILL.md 为准。

## 按需使用快照

- 审稿需要第二视角时参考 [wewrite 审稿资料](../../../third_party/wewrite/review.source.md)。
- 配图需要结构化构图提示时参考 [baoyu 插图提示词资料](../../../third_party/baoyu/illustration-prompts.source.md)。
- 维护发布实现时参考 [aiworkskills API 资料](../../../third_party/aiworkskills/api.source.md)，并与官方接口核对。
- [多账号参考](../../../third_party/baoyu/multi-account.source.md) 展示原项目设计；本项目使用环境变量名，
  不采用其内联 AppSecret、全局账号兜底或另起 Chrome profile 的方式。

这些快照是原始参考资料。里面的安装命令、平台工具名和子文档相对链接属于原仓库，
不直接作为当前操作命令；要查其未打包子文档时按 upstreams.json 中的仓库与提交定位。
当前操作以 SKILL.md 和 publishing.md 为准。

开发维护可执行 `pnpm exec tsx scripts/sync-wechat-references.ts --check` 离线校验。
更新快照需先审查许可证与接口差异、明确修改固定提交，再运行不带 --check 的同步命令。
