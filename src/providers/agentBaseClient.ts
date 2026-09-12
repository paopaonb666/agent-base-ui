// SSE client for the agent-base backend.
//
// agent-base exposes a custom event contract (not the LangGraph Server
// protocol): POST /v1/agents/{module}/invoke streams Server-Sent Events
// of type ping / step / delta / done / error. This module:
//   1. POSTs a turn to that endpoint and parses the SSE stream,
//   2. decodes each frame into a typed AgentBaseEvent,
//   3. surfaces non-2xx responses as actionable errors.
//
// The UI stays decoupled: providers consume AgentBaseEvent and own the
// message/thread state; this file only speaks the wire protocol.

export type AgentBaseStepStatus = "running" | "completed" | "error";

export interface AgentBaseSource {
  title: string;
  url?: string | null;
}

export type AgentBaseToolCallPhase = "start" | "end";
export type AgentBaseToolCallStatus = "ok" | "timeout" | "error";

export type AgentBaseEvent =
  | { type: "ping" }
  | {
      type: "step";
      name: string;
      status: AgentBaseStepStatus;
      detail?: string | null;
    }
  | {
      type: "tool_call";
      call_id: string;
      name: string;
      phase: AgentBaseToolCallPhase;
      args?: Record<string, unknown> | null;
      result?: string | null;
      status?: AgentBaseToolCallStatus | null;
      duration_ms?: number | null;
      error?: string | null;
    }
  | { type: "sources"; sources: AgentBaseSource[] }
  | { type: "delta"; content: string }
  | { type: "done"; thread_id?: string | null }
  | { type: "error"; message: string };

export interface InvokeAgentArgs {
  apiUrl: string;
  module: string;
  message: string;
  threadId?: string | null;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ThreadHistoryToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One message in a thread's persisted history, as served by the backend. */
export interface ThreadHistoryMessage {
  role: "human" | "assistant" | "tool";
  content?: string;
  name?: string;
  /** 仅 assistant：本条消息发起的工具调用（调用参数在此）。 */
  tool_calls?: ThreadHistoryToolCall[];
  /** 仅 tool：与发起方 AI 消息的 tool_calls[id] 配对。 */
  tool_call_id?: string;
  status?: "ok" | "error";
}

export interface ThreadHistory {
  thread_id: string;
  module: string;
  messages: ThreadHistoryMessage[];
}

export interface UploadedFile {
  file_id: string;
  filename: string;
  format: string;
  pages: number | null;
  paragraphs: number | null;
  truncated: boolean;
  text_len: number;
  text: string;
}

/**
 * 上传并解析文档（M4a 解析层的 HTTP 入口）。后端按扩展名推断格式，
 * 解析失败以 400 返回可读原因；文本经 DOC_PARSE_MAX_OUTPUT_CHARS 截断。
 */
export async function uploadDocument(args: {
  apiUrl: string;
  module: string;
  file: File;
  signal?: AbortSignal;
}): Promise<UploadedFile> {
  const { apiUrl, module, file, signal } = args;
  const form = new FormData();
  form.append("file", file);
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files`;
  const response = await fetch(url, { method: "POST", body: form, signal });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response));
  }
  return (await response.json()) as UploadedFile;
}

/**
 * Fetch a thread's persisted message history from the backend checkpointer.
 *
 * Used to restore the transcript of conversations that predate local
 * transcript persistence (or were created on another device). Returns an
 * empty list for an unknown thread (the backend reports 404, which callers
 * treat as "no history").
 */
export async function fetchThreadHistory(args: {
  apiUrl: string;
  module: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<ThreadHistory> {
  const { apiUrl, module, threadId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/threads/${encodeURIComponent(threadId)}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(await extractErrorDetail(response));
  }
  return (await response.json()) as ThreadHistory;
}

/** Short random id used for X-Request-ID and UI message ids. */
export function requestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

/** 单次 read 的最长等待。后端每 15s 发一个 ping；45s 内无任何事件
 * （含心跳）即判定为断流——否则代理层静默断开时 UI 会永远"运行中"。 */
const READ_TIMEOUT_MS = 45_000;

/** 提取后端错误响应里可读的 detail（FastAPI 风格 {"detail": ...}）。
 * 422 校验错误的 detail 是数组，逐条格式化成 "消息 (字段路径)"。 */
export async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      const lines = body.detail
        .map((item) => {
          if (typeof item !== "object" || item === null) return String(item);
          const { msg, loc } = item as { msg?: unknown; loc?: unknown };
          const where = Array.isArray(loc) ? loc.join(".") : "";
          return typeof msg === "string" && where
            ? `${msg}（${where}）`
            : typeof msg === "string"
              ? msg
              : String(item);
        })
        .filter(Boolean);
      if (lines.length > 0) return lines.join("；");
    }
  } catch {
    // non-JSON error body; keep the status text
  }
  return `HTTP ${response.status}`;
}

/** GET /health 的返回结构（分项健康，A4）。 */
export interface HealthStatus {
  status: string;
  components: Record<string, string>;
}

/** 探测 agent-base 服务可达性（配置面板保存前调用）。 */
export async function fetchHealth(args: {
  apiUrl: string;
  signal?: AbortSignal;
}): Promise<HealthStatus> {
  const url = `${args.apiUrl.replace(/\/+$/, "")}/health`;
  const response = await fetch(url, { signal: args.signal });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  return (await response.json()) as HealthStatus;
}

export interface ModuleInfo {
  name: string;
  description: string;
}

/** 列出后端已注册的模块（配置面板下拉，免试错模块名）。 */
export async function listModules(args: {
  apiUrl: string;
  signal?: AbortSignal;
}): Promise<ModuleInfo[]> {
  const url = `${args.apiUrl.replace(/\/+$/, "")}/v1/modules`;
  const response = await fetch(url, { signal: args.signal });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { modules?: ModuleInfo[] };
  return Array.isArray(body.modules) ? body.modules : [];
}

/** GET /v1/agents/{module}/threads 返回的一条线程摘要。 */
export interface RemoteThreadSummary {
  thread_id: string;
  module: string;
  title: string;
  updated_at: number;
}

/** 列出某模块在 checkpointer 里已持久化的线程（侧栏"云端会话"来源）。 */
export async function listThreads(args: {
  apiUrl: string;
  module: string;
  signal?: AbortSignal;
}): Promise<RemoteThreadSummary[]> {
  const url = `${args.apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(args.module)}/threads`;
  const response = await fetch(url, { signal: args.signal });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { threads?: RemoteThreadSummary[] };
  return Array.isArray(body.threads) ? body.threads : [];
}

/** 删除某模块命名空间下的一个已持久化线程（后端 checkpointer 同步删除）。 */
export async function deleteThread(args: {
  apiUrl: string;
  module: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const url = `${args.apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(args.module)}/threads/${encodeURIComponent(args.threadId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    signal: args.signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
}

/** Parse one SSE frame ("event: x\ndata: {...}") into a typed event.
 * Exported for unit tests; treat as internal API. */
export function parseFrame(frame: string): AgentBaseEvent | null {
  const lines = frame.split("\n");
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventName || dataLines.length === 0) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (eventName) {
    case "ping":
      return { type: "ping" };
    case "step":
      return {
        type: "step",
        name: String(data.name ?? ""),
        status: (data.status as AgentBaseStepStatus) ?? "running",
        detail: typeof data.detail === "string" ? data.detail : null,
      };
    case "sources": {
      // 工具发布的引用来源（如 web_search）：字段已由后端按契约模型
      // 校验过，这里只做防御性收窄。
      const raw = Array.isArray(data.sources) ? data.sources : [];
      const sources: AgentBaseSource[] = raw
        .filter(
          (s: unknown): s is Record<string, unknown> =>
            typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).title === "string",
        )
        .map((s: Record<string, unknown>) => ({
          title: String(s.title),
          url: typeof s.url === "string" ? s.url : null,
        }));
      return { type: "sources", sources };
    }
    case "tool_call": {
      // 工具调用记录（M5）：start 带 args，end 带 result/status/duration。
      const rawArgs: unknown = data.args;
      const args: Record<string, unknown> =
        typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
      const phase = data.phase === "end" ? "end" : "start";
      const status =
        data.status === "ok" || data.status === "timeout" || data.status === "error"
          ? data.status
          : null;
      return {
        type: "tool_call",
        call_id: String(data.call_id ?? ""),
        name: String(data.name ?? ""),
        phase,
        args,
        result: typeof data.result === "string" ? data.result : null,
        status,
        duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : null,
        error: typeof data.error === "string" ? data.error : null,
      };
    }
    case "delta":
      return { type: "delta", content: String(data.content ?? "") };
    case "done":
      return {
        type: "done",
        thread_id: typeof data.thread_id === "string" ? data.thread_id : null,
      };
    case "error":
      return {
        type: "error",
        message: String(data.message ?? "unknown error"),
      };
    default:
      return null; // ignore unknown events for forward compatibility
  }
}

/**
 * Invoke one agent turn and consume the SSE stream as an async sequence.
 *
 * Throws an Error with a readable message for non-2xx responses or network
 * failures. Cancellation is Cooperated via `signal` (the backend also
 * aborts its LLM call on client disconnect).
 */
export async function* invokeAgent(
  args: InvokeAgentArgs,
): AsyncGenerator<AgentBaseEvent> {
  const {
    apiUrl,
    module,
    message,
    threadId,
    requestId: rid = requestId(),
    signal,
  } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/invoke`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": rid,
    },
    body: JSON.stringify({
      message,
      ...(threadId ? { thread_id: threadId } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(await extractErrorDetail(response));
  }

  if (!response.body) {
    throw new Error("agent-base responded without a body stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout(
        reader,
        READ_TIMEOUT_MS,
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
  } catch (err) {
    // 读超时/网络错误：取消底层流，触发服务端的"断连 => 取消 LLM"路径。
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/** 带超时的单次 read；每个事件到达都会重置计时。 */
async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `读超时：${timeoutMs / 1000} 秒内没有收到任何事件（含心跳），连接可能已被代理断开`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
