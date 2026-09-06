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

export type AgentBaseEvent =
  | { type: "ping" }
  | {
      type: "step";
      name: string;
      status: AgentBaseStepStatus;
      detail?: string | null;
    }
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

/** One message in a thread's persisted history, as served by the backend. */
export interface ThreadHistoryMessage {
  role: "human" | "assistant" | "tool";
  content?: string;
  name?: string;
}

export interface ThreadHistory {
  thread_id: string;
  module: string;
  messages: ThreadHistoryMessage[];
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
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(detail);
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

/** Parse one SSE frame ("event: x\ndata: {...}") into a typed event. */
function parseFrame(frame: string): AgentBaseEvent | null {
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
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error("agent-base responded without a body stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
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
  } finally {
    reader.releaseLock();
  }
}
