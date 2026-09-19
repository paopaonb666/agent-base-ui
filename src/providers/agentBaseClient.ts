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
  /** 附件对话（M4b）：本条消息引用的上传文件 id。 */
  attachments?: string[];
  requestId?: string;
  signal?: AbortSignal;
}

export interface ThreadHistoryAttachment {
  file_id: string;
  filename: string;
  format: string;
  pages?: number | null;
  text_len: number;
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
  /** 仅 human：本条消息引用的上传附件元数据。 */
  attachments?: ThreadHistoryAttachment[];
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
  warning?: string | null;
}

/**
 * 上传并解析文档（M4a 解析层的 HTTP 入口）。后端按扩展名推断格式，
 * 解析失败以 400 返回可读原因；文本经 DOC_PARSE_MAX_OUTPUT_CHARS 截断。
 */
export function uploadDocument(args: {
  apiUrl: string;
  module: string;
  file: File;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<UploadedFile> {
  // fetch 不支持上传进度：用 XHR 拿 determinate 百分比。
  const { apiUrl, module, file, onProgress, signal } = args;
  const form = new FormData();
  form.append("file", file);
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as UploadedFile);
        return;
      }
      const body = xhr.response as { detail?: unknown } | null;
      const detail = typeof body?.detail === "string" ? body.detail : `上传失败（${xhr.status}）`;
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("网络错误，上传失败"));
    xhr.onabort = () => reject(new Error("上传已取消"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
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
    attachments,
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
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
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

// ── 文档预览与切片可视化（M7） ─────────────────────────────────────

/** GET …/files/{id}/preview 的返回：元信息 + 提取正文（与注入模型的内容同源）。 */
export interface FilePreview {
  file_id: string;
  filename: string;
  format: string;
  pages: number | null;
  text_len: number;
  truncated: boolean;
  warning?: string | null;
  extracted_text: string;
}

/** 一个切片的原文区间（段落打包块是多区间；旧数据为 null）。 */
export type ChunkOffsets = [number, number][];

/** GET …/files/{id}/chunks 返回的一个切片。 */
export interface FileChunkView {
  chunk_id: string;
  ordinal: number;
  text: string;
  offsets: ChunkOffsets | null;
  char_len: number;
  has_embedding: boolean;
  embedding_dim: number | null;
}

/** 拉取文档预览（元信息 + 提取正文）。 */
export async function fetchFilePreview(args: {
  apiUrl: string;
  module: string;
  fileId: string;
  /** 记忆身份（X-User-Id），与后端属主校验配套。 */
  userId?: string;
  signal?: AbortSignal;
}): Promise<FilePreview> {
  const { apiUrl, module, fileId, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files/${encodeURIComponent(fileId)}/preview`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  return (await response.json()) as FilePreview;
}

/** 拉取文档的切片存储视图（序号/原文区间/向量化状态）。 */
export async function fetchFileChunks(args: {
  apiUrl: string;
  module: string;
  fileId: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<FileChunkView[]> {
  const { apiUrl, module, fileId, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files/${encodeURIComponent(fileId)}/chunks`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { chunks?: unknown };
  if (!Array.isArray(body.chunks)) return [];
  // 防御性收窄：形态不完整的条目直接丢弃（与 listThreads 同语义）。
  return body.chunks.filter(
    (c: unknown): c is FileChunkView =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as FileChunkView).chunk_id === "string" &&
      typeof (c as FileChunkView).text === "string" &&
      typeof (c as FileChunkView).ordinal === "number",
  );
}

/**
 * 拉取原始文件字节并转成 objectURL（图片预览 <img src> / 原文下载链接）。
 * 走 fetch 而非直接 <img src> 是为了带上 X-User-Id 头做属主校验——
 * 身份不进 URL。调用方负责在不需要时 URL.revokeObjectURL。
 */
export async function fetchFileRawObjectUrl(args: {
  apiUrl: string;
  module: string;
  fileId: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { apiUrl, module, fileId, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files/${encodeURIComponent(fileId)}/raw`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// ── 独立知识库页面 / 长期记忆可视化（M8） ──────────────────────────

/** GET /v1/knowledge/files 返回的一条文件摘要（含切片数）。 */
export interface KnowledgeFile {
  file_id: string;
  filename: string;
  format: string;
  pages: number | null;
  text_len: number;
  truncated: boolean;
  user_id: string;
  warning?: string | null;
  chunks: number;
  created_at: number;
}

/** 列出当前用户的全部知识库文件（用户级视图，跨模块）。 */
export async function listKnowledgeFiles(args: {
  apiUrl: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<KnowledgeFile[]> {
  const { apiUrl, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/knowledge/files`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) return [];
  return body.files.filter(
    (f: unknown): f is KnowledgeFile =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as KnowledgeFile).file_id === "string" &&
      typeof (f as KnowledgeFile).filename === "string",
  );
}

/** 撤销一份知识库文件（原始行 + 切片级联删除）。 */
export async function revokeFile(args: {
  apiUrl: string;
  module: string;
  fileId: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { apiUrl, module, fileId, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(module)}/files/${encodeURIComponent(fileId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
}

/** 长期记忆的类型（LangMem 分类法）。 */
export type MemoryKind = "semantic" | "episodic" | "procedural";

/** GET /v1/memory（或 q 检索）返回的一条记忆。 */
export interface MemoryItem {
  memory_id: string;
  agent_id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  salience: number;
  status: string;
  access_count: number;
  has_embedding: boolean;
  created_at: number;
  updated_at: number;
  /** 仅 q 检索模式携带：混合相关度得分。 */
  score?: number;
}

/** 浏览/检索长期记忆（q 存在→混合检索，否则按更新时间浏览）。 */
export async function fetchMemories(args: {
  apiUrl: string;
  query?: string;
  kind?: MemoryKind;
  limit?: number;
  userId?: string;
  signal?: AbortSignal;
}): Promise<MemoryItem[]> {
  const { apiUrl, query, kind, limit, userId, signal } = args;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (kind) params.set("kind", kind);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/memory${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { memories?: unknown };
  if (!Array.isArray(body.memories)) return [];
  return body.memories.filter(
    (m: unknown): m is MemoryItem =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as MemoryItem).memory_id === "string" &&
      typeof (m as MemoryItem).content === "string",
  );
}

/** 删除一条长期记忆。 */
export async function deleteMemory(args: {
  apiUrl: string;
  memoryId: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { apiUrl, memoryId, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/memory/${encodeURIComponent(memoryId)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
}

/** GET /v1/memory/profile 返回的用户画像（分节名 → 条目列表）。 */
export type UserProfile = Record<string, string[]>;

/** 读取当前用户的结构化画像（随对话管线自动演化）。 */
export async function fetchProfile(args: {
  apiUrl: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<UserProfile | null> {
  const { apiUrl, userId, signal } = args;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/memory/profile`;
  const response = await fetch(url, {
    headers: userId ? { "X-User-Id": userId } : undefined,
    signal,
  });
  if (!response.ok) throw new Error(await extractErrorDetail(response));
  const body = (await response.json()) as { profile?: unknown };
  if (typeof body.profile !== "object" || body.profile === null) return null;
  const entries = Object.entries(body.profile as Record<string, unknown>).filter(
    (pair): pair is [string, string[]] => Array.isArray(pair[1]),
  );
  return Object.fromEntries(entries);
}
