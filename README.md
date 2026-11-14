# agent-base-ui

<p>
  <a href="./README.md">简体中文</a> ·
  <a href="./README.en.md">English</a>
</p>

agent-base 的配套 Web 聊天界面（Next.js 16 + React 19 + TypeScript）。

由 [LangChain agent-chat-ui](https://github.com/langchain-ai/agent-chat-ui) 深度改造而来：完全对接
agent-base 的 SSE 事件契约，移除 LangGraph Server 协议与 langgraph-sdk 依赖，并整体改名为
**agent-base-ui**。

> 后端在独立仓库 `agent-base`（与本项目同级的独立仓库）。本前端只与 agent-base 通信，不依赖其他后端。

## 功能

- 与任意 agent-base 模块对话（chat / writer / supervisor …），免配置直连：默认
  `http://localhost:8000` + `chat`，打开首页即见对话框
- **流式输出**：SSE delta 逐字渲染，前端做打字机平滑揭示（慢速流逐字跟显，高速突发按恒定时滞补放，不会整段一次性砸出）；聊天区内容增长自动贴底滚动，用户上翻即暂停跟随、滚回底部恢复
- **会话状态徽章**：正在对话 / 对话结束 / 对话终止 / 对话异常 四态彩色状态点，显示在顶栏（当前会话）与侧栏每个会话项上；用户停止与页面刷新中断自动标记为「终止」，请求失败 / 后端报错标记为「异常」
- **工具调用步骤卡**：运行中 / 已完成 / 已停止 等步骤徽标（并行同名步骤精确配对），可视化工具参数、结果与耗时，历史会话回放时步骤与消息正确配对；工具发布的引用来源经 `sources` 事件渲染为可点击的来源卡片
- **附件上传**：输入框拖拽或点选上传，PDF / DOCX / TXT / MD 解析后直通对话，图片（png / jpg / webp / gif）走多模态通道直达 vision 模型；上传带进度条，消息内以元数据 chip 呈现
- **文档预览与切片可视化**：点击附件 chip 即可查看文档正文、切片边界与向量化状态，检索到底吃了哪几段一目了然
- **知识库页（/knowledge）**：文档知识库 / 长期记忆 / 用户画像 三页签的可视化管理——文档上传、删除与向量化状态；长期记忆人工复核（全状态筛选、过期标识、保留 / 停用 / 删除）；随对话自动演化的结构化用户画像
- **会话历史**：localStorage 本地索引 + 完整对话文本，侧栏按时间分组，合并显示后端 checkpointer
  已持久化的线程（本机没有的也能看到、可删除，删除同步云端）；正在流式输出的会话不可删除；点击回放历史消息，续聊凭 thread_id 由后端恢复上下文；打开首页自动恢复上次会话
- **可靠收尾**：流按线程路由（切走再切回、后台流照常落账）；发送即持久化（流中刷新至少保住已发消息）；「停止生成」断连即取消后端 LLM；断流兜底（45s 无事件判定断开）；正常结束后与 checkpointer
  对账，防止本地视图与真实历史漂移
- 设置面板（服务地址 / 模块下拉拉取已注册模块、保存前健康探活）；配置与会话标识不经过 URL，只存本机
  localStorage 或构建时环境变量

## 环境要求

- Node.js ≥ 22（开发用 v22 通过验证）
- pnpm ≥ 10

## 快速开始

```bash
# 1. 启动 agent-base 后端（默认 8000 端口）
cd ../agent-base    # 任意你的 agent-base 克隆位置
.venv\Scripts\activate            # 首次先按 agent-base/README.md 安装
uvicorn agent_base.entrypoints.server:app --reload

# 2. 启动本前端（另开终端）
cd agent-base-ui
pnpm install
pnpm dev                          # http://localhost:3000
```

打开 http://localhost:3000 即可直接对话：默认连接 `http://localhost:8000` 的 `chat` 模块（或 writer /
supervisor，需在 agent-base 的 `AGENT_MODULES` 中启用）。如需调整，用顶栏「设置」。
二次启动只需重复第 1、2 步（无需再 install）。

## 配置（.env）

复制 `.env.example` 为 `.env`（已 gitignore，不会入库）：

| 变量                       | 说明                                              |
| -------------------------- | ------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`      | agent-base 服务地址（默认 http://localhost:8000） |
| `NEXT_PUBLIC_AGENT_MODULE` | 默认模块（默认 chat）                             |

配置缺省时前端回退到内置默认值（`http://localhost:8000` / `chat`），也可用顶栏「设置」覆盖。后端地址 / 模块 / 会话 id 一律不出现在 URL——它们保存在浏览器 localStorage（仅本机）或构建时环境变量中，避免随链接分享或浏览器历史泄露。

## 常用命令

```bash
pnpm install       # 安装依赖（lockfile 更新时需 --no-frozen-lockfile）
pnpm dev           # 开发模式，http://localhost:3000
pnpm build         # 生产构建（TS 编译检查）
pnpm start         # 生产预览（需先 build）
pnpm lint          # ESLint 检查
pnpm test          # vitest 单元测试
```

## 与 agent-base 的衔接约定

| agent-base-ui                                                      | agent-base                                        |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| 请求 `POST /v1/agents/{module}/invoke`                             | 见 agent-base 的 `entrypoints/server.py` SSE 服务 |
| 消费事件 ping / step / delta / sources / done / error              | 事件契约见 agent-base 的 `extensions/events.py`   |
| 请求 `POST /v1/agents/{module}/files` 上传附件                     | 文档解析切片 + 图片多模态透传                     |
| 请求 `GET /v1/agents/{module}/files/{id}/preview · /chunks · /raw` | 文档预览 / 切片边界 / 向量化状态                  |
| 请求 `DELETE /v1/agents/{module}/files/{id}`                       | 删除知识文档                                      |
| 请求 `GET /v1/knowledge/files`                                     | 知识库文档列表（/knowledge 页签）                 |
| 请求 `GET /v1/memory`（kind / status 筛选）                        | 长期记忆列表（人工复核数据源）                    |
| 请求 `PATCH /v1/memory/{id}`、`DELETE /v1/memory/{id}`             | 记忆保留 / 停用 / 删除                            |
| 请求 `GET /v1/memory/profile`                                      | 结构化用户画像（随对话自动演化）                  |
| `threadId`（`done` 事件返回）继续对话                              | 后端 checkpointer 恢复上下文                      |
| 请求 `GET /v1/agents/{module}/threads/{id}`                        | 读取 checkpointer 里的历史消息，用于回放历史会话  |
| 请求 `GET /v1/agents/{module}/threads`                             | 列出该模块已持久化线程（侧栏「云端会话」来源）    |
| 请求 `DELETE /v1/agents/{module}/threads/{id}`                     | 删除会话（本地与后端 checkpointer 同步删除）      |
| 请求 `GET /health`                                                 | 设置面板保存前的服务健康探活                      |
| 请求 `POST …/threads/{id}/steer`（运行中插话）                      | Java wire 扩展 #7：下一个步骤边界注入 UserMessage  |
| 请求 `POST …/threads/{id}/approvals/{call_id}` + `POST …/resume`   | Java wire 扩展 #26/#62：审批门暂停后的决定与续跑   |
| 消费事件 `plan` / `done.termination` / `error.code`                 | Java wire 扩展 #96 计划卡 / #9 终态徽章 / #91 错误码 |

## 项目结构（本仓库）

```
agent-base-ui/
├── src/
│   ├── providers/
│   │   ├── agentBaseClient.ts  # API/SSE 客户端：事件解析 + 历史/线程/附件/知识库/记忆接口
│   │   ├── Stream.tsx          # 流式会话状态机（按线程路由 / 停止 / 对账 / 状态收口）
│   │   └── Thread.tsx          # localStorage 会话历史（索引 + 收尾状态）
│   ├── lib/thread-status.ts    # 会话状态判定（流式优先，落库终态兜底）
│   ├── components/thread/      # 聊天界面
│   │   ├── AgentChatApp.tsx    # 顶栏（含当前会话状态徽章）+ 侧栏 + 聊天区布局
│   │   ├── ThreadList.tsx      # 对话列表（本地 + 云端合并 / 时间分组 / 删除保护）
│   │   ├── ThreadStatusBadge.tsx # 会话状态点（正在对话/结束/终止/异常）
│   │   ├── ChatInterface.tsx   # 消息流 + 贴底滚动跟随 + 输入框（拖拽上传附件/图片）
│   │   ├── ChatMessage.tsx     # 用户气泡 / AI Markdown（平滑揭示）/ 工具步骤 / 附件与来源卡片
│   │   ├── FilePreviewDialog.tsx # 文档预览与切片可视化（正文/切片边界/向量化状态）
│   │   ├── use-smooth-text.ts  # 流式输出打字机平滑揭示（display-only）
│   │   ├── messages/tool-calls.tsx # 工具步骤卡（运行中/已完成/已停止，含参数/结果/耗时）
│   │   ├── ConfigDialog.tsx    # 设置弹窗（服务地址 / 模块 / 探活）
│   │   └── markdown-text.tsx   # Markdown 渲染（代码高亮 / KaTeX）
│   ├── components/knowledge/
│   │   └── KnowledgePage.tsx   # 知识库页（文档知识库 / 长期记忆 / 用户画像 三页签）
│   ├── components/ui/          # UI 原语（button / dialog / input …）
│   └── app/                    # Next.js 布局与页面（含 /knowledge 路由）
├── test/                       # vitest 单元测试（SSE 协议解析）
├── .env.example                # 配置模板
└── package.json                # 依赖与脚本（上游 langchain 依赖已移除）
```

## 说明与已知边界

- **消息树功能（分岔/重命名/星标/归档/删除子树/跳转/导出，ADR-013）当前隐藏**：其依赖的后端契约（6 个树端点 + invoke 锚点字段 + 历史 node_id）在 agent-base（Python 与 Java）中均未实现——代码与测试保留，待后端立项后以 `NEXT_PUBLIC_ENABLE_MESSAGE_TREE=1` 打开
- 会话状态由前端派生并保存在本地索引（后端不提供会话状态端点）：流进行中优先显示「正在对话」，否则取最近一轮的落库收尾状态；纯云端线程与旧记录缺省显示「对话结束」；后端审批门暂停的线程显示「等待审批」（后端持久态，刷新后仍可继续）
- 切换历史会话时先回放本地保存的对话文本；本地无记录时通过 `GET /v1/agents/{module}/threads/{id}`
  从后端 checkpointer 拉取历史，续聊仍由后端恢复上下文
- 正在流式输出的会话受删除保护，需等生成结束（或先停止）再删除
- 模型在调用工具期间没有文本 delta（界面以步骤卡反馈进度），属正常现象
- 许可证：MIT（沿用上游 agent-chat-ui）
