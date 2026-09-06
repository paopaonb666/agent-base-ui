# agent-base-ui

agent-base 的配套 Web 聊天界面（Next.js 16 + React 19 + TypeScript）。

由 [LangChain agent-chat-ui](https://github.com/langchain-ai/agent-chat-ui) 深度改造而来：完全对接 agent-base
的 SSE 事件契约，移除 LangGraph Server 协议与 langgraph-sdk 依赖，并整体改名为 **agent-base-ui**。

> 后端在独立仓库 `agent-base`（`e:\ai_study\agent-base`）。本前端只与 agent-base 通信，不依赖其他后端。

## 功能

- 与任意 agent-base 模块对话（chat / writer / supervisor …）
- SSE 流式输出（delta 逐字渲染）+ 工具调用步骤展示（step 事件）
- 会话历史（localStorage 本地索引 + 完整对话文本，点击即可切换并回放历史消息；续聊凭 thread_id 由后端 checkpointer 恢复上下文）
- URL 参数化：`?apiUrl=&module=&threadId=`，便于分享与恢复

## 环境要求

- Node.js ≥ 22（开发用 v22 通过验证）
- pnpm ≥ 10

## 快速开始

```bash
# 1. 启动 agent-base 后端（默认 8000 端口）
cd e:\ai_study\agent-base
.venv\Scripts\activate            # 首次先按 agent-base/README.md 安装
uvicorn agent_base.entrypoints.server:app --reload

# 2. 启动本前端（另开终端）
cd e:\ai_study\agent-base-ui
pnpm install
pnpm dev                          # http://localhost:3000
```

打开 http://localhost:3000，设置页填入：
- **agent-base server URL**：`http://localhost:8000`
- **Agent module**：`chat`（或 writer / supervisor，需在 agent-base 的 `AGENT_MODULES` 中启用）

即可开始对话。二次启动只需重复第 1、2 步（无需再 install）。

## 配置（.env）

复制 `.env.example` 为 `.env`（已 gitignore，不会入库）：

| 变量 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | agent-base 服务地址（默认 http://localhost:8000） |
| `NEXT_PUBLIC_AGENT_MODULE` | 默认模块（默认 chat） |

配置缺省时前端会显示设置表单，也可用 URL 参数（`?apiUrl=`、`?module=`、`?threadId=`）临时覆盖。

## 常用命令

```bash
pnpm install       # 安装依赖（lockfile 更新时需 --no-frozen-lockfile）
pnpm dev           # 开发模式，http://localhost:3000
pnpm build         # 生产构建（TS 编译检查）
pnpm start         # 生产预览（需先 build）
```

## 与 agent-base 的衔接约定

| agent-base-ui | agent-base |
| --- | --- |
| 请求 `POST /v1/agents/{module}/invoke` | 见 agent-base 的 `entrypoints/server.py` SSE 服务 |
| 消费事件 ping / step / delta / done / error | 事件契约见 agent-base 的 `extensions/events.py` |
| `threadId`（`done` 事件返回）继续对话 | 后端 checkpointer 恢复上下文 |
| 请求 `GET /v1/agents/{module}/threads/{id}` | 读取 checkpointer 里的历史消息，用于回放历史会话 |

## 项目结构（本仓库）

```
agent-base-ui/
├── src/
│   ├── providers/
│   │   ├── agentBaseClient.ts  # SSE 客户端：fetch + 事件解析 + 历史拉取
│   │   ├── Stream.tsx          # 流式会话状态机（sendMessage / threadId / 配置 / 错误）
│   │   └── Thread.tsx          # localStorage 会话历史
│   ├── components/thread/      # 聊天界面（参考 general-agent 的 Deep Agents UI）
│   │   ├── AgentChatApp.tsx    # 顶栏 + 侧栏 + 聊天区布局
│   │   ├── ThreadList.tsx      # 对话列表（按时间分组 / 删除）
│   │   ├── ChatInterface.tsx   # 消息流 + 底部输入框
│   │   ├── ChatMessage.tsx     # 用户气泡 / AI Markdown / 工具步骤
│   │   ├── ConfigDialog.tsx    # 设置弹窗
│   │   ├── SetupScreen.tsx     # 首次配置欢迎页
│   │   └── markdown-text.tsx   # Markdown 渲染（代码高亮 / KaTeX）
│   ├── components/ui/          # UI 原语（button / dialog / input …）
│   └── app/                    # Next.js 布局与页面
├── .env.example                # 配置模板
└── package.json                # 依赖与脚本（上游 langchain 依赖已移除）
```

## 说明与已知边界

- 本前端不做多模态/文件上传、artifact 面板、分支切换——agent-base 契约仅文本流 + 步骤事件
- 切换历史会话时先回放本地保存的对话文本；本地无记录时通过 `GET /v1/agents/{module}/threads/{id}` 从后端 checkpointer 拉取历史，续聊仍由后端恢复上下文
- ESLint 的 `pnpm lint` 脚本为上游 POSIX 写法，Windows 下请用 `npx eslint src`（开发者环境默认）
- 许可证：MIT（沿用上游 agent-chat-ui）