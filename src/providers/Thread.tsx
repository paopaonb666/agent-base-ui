import {
  createContext,
  useContext,
  ReactNode,
  useCallback,
  useEffect,
  useState,
  Dispatch,
  SetStateAction,
} from "react";
import { toast } from "sonner";

// Conversation history stored in localStorage.
//
// Storage layout (two layers, one write never touches the other):
//   agent-base-ui:threads        — index: small metadata records, NO messages.
//   agent-base-ui:thread:<id>    — the rendered transcript of one thread.
// Splitting them keeps a per-thread save from rewriting (and clobbering)
// unrelated threads, and keeps the index write small even for long chats.
// Records written by the legacy single-key format (messages embedded in the
// index) are read transparently and migrated on the next save.

const STORAGE_KEY = "agent-base-ui:threads";
const THREAD_KEY_PREFIX = "agent-base-ui:thread:";
const MAX_THREADS = 50;

// Rendered transcript for one conversation. agent-base has no thread-list
// endpoint (thin base), so the UI persists the transcript it already renders
// and replays it when a past thread is reopened. The backend checkpointer
// independently restores *context* for follow-up turns.
// 引用来源（web_search 等工具经 sources 事件发布；附着在回复旁渲染）。
export interface SourceRef {
  title: string;
  url?: string;
}

export type ThreadMessage =
  | { id: string; role: "human"; content: string }
  | { id: string; role: "assistant"; content: string }
  | {
      id: string;
      role: "tool";
      name: string;
      status: "running" | "completed" | "error";
      detail?: string;
      result?: string;
      /** 工具调用记录（M5）：与流式 tool_call 事件/后端历史配对的字段。 */
      call_id?: string;
      args?: Record<string, unknown>;
      duration_ms?: number;
      error?: string;
    }
  | { id: string; role: "sources"; sources: SourceRef[] };

// 会话级状态（参考 chat-agent 的步骤/工具状态色板，提升到会话维度）：
//   streaming  — 正在对话（流进行中的运行时状态）
//   ended      — 对话结束（正常完成）
//   terminated — 对话终止（用户停止、页面刷新/关闭打断）
//   error      — 对话异常（请求失败、后端返回错误事件）
export type ThreadStatus = "streaming" | "ended" | "terminated" | "error";

export interface RecentThread {
  threadId: string;
  title: string;
  module: string;
  updatedAt: number;
  messages?: ThreadMessage[];
  /** 来自后端 checkpointer 的线程（本地无 transcript，点击走历史恢复）。 */
  remote?: boolean;
  /**
   * 最近一轮对话的收尾状态。streaming 只存在于流进行中的内存态——从存储
   * 读到 streaming 一律降级为 terminated（没有流能活过一次页面刷新）。
   * 缺省（旧记录、纯云端线程）视为 ended。
   */
  status?: ThreadStatus;
}

interface ThreadContextType {
  threads: RecentThread[];
  setThreads: Dispatch<SetStateAction<RecentThread[]>>;
  threadsLoading: boolean;
  setThreadsLoading: Dispatch<SetStateAction<boolean>>;
  saveThread: (t: RecentThread) => void;
  removeThread: (threadId: string) => void;
  refresh: () => void;
  getThreadMessages: (threadId: string) => ThreadMessage[] | undefined;
  getThread: (threadId: string) => RecentThread | undefined;
}

const ThreadContext = createContext<ThreadContextType | undefined>(undefined);

// ---- sanitizing ------------------------------------------------------------
//
// localStorage is untrusted input: an old buggy build could persist a human
// message whose content is an object (rendered as "[object Object]") or a
// tool step stuck at "running" (no stream survives a page reload). Anything
// read back from storage goes through here.

// 只接受合法枚举；残留的 "streaming" 说明上次会话在流进行中被刷新/关闭
// 打断（与 sanitizeMessages 把残留 running 步骤改成 error 是同一个道理）。
function sanitizeStatus(raw: unknown): ThreadStatus | undefined {
  if (raw === "ended" || raw === "terminated" || raw === "error") return raw;
  if (raw === "streaming") return "terminated";
  return undefined;
}

function sanitizeMessages(messages: unknown): ThreadMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ThreadMessage[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : "";
    const role = m.role;
    if (!id) continue;
    if (role === "human" || role === "assistant") {
      // 修复历史遗留的 "[object Object]"：非字符串内容一律丢弃该消息，
      // 而不是把 String(obj) 渲染给用户。
      if (typeof m.content !== "string" || !m.content) continue;
      out.push({ id, role, content: m.content });
    } else if (role === "tool") {
      const status =
        m.status === "completed" || m.status === "error" ? m.status : "error";
      const rawArgs: unknown = m.args;
      out.push({
        id,
        role: "tool",
        name: typeof m.name === "string" ? m.name : "",
        // "running" 不可能属于已结束的会话——页面刷新即流中断。
        status,
        ...(typeof m.detail === "string" && m.detail
          ? { detail: m.detail }
          : status === "error" && m.status === "running"
            ? { detail: "已中断（页面刷新或关闭）" }
            : {}),
        ...(typeof m.result === "string" && m.result ? { result: m.result } : {}),
        ...(typeof m.call_id === "string" && m.call_id ? { call_id: m.call_id } : {}),
        ...(typeof rawArgs === "object" && rawArgs !== null
          ? { args: rawArgs as Record<string, unknown> }
          : {}),
        ...(typeof m.duration_ms === "number" ? { duration_ms: m.duration_ms } : {}),
        ...(typeof m.error === "string" && m.error ? { error: m.error } : {}),
      });
    } else if (role === "sources") {
      // sources 事件：只保留带非空 title 的引用，上限 20 条防存储膨胀。
      const rawSources = Array.isArray(m.sources) ? m.sources : [];
      const sources = rawSources
        .filter(
          (s: unknown): s is Record<string, unknown> =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as Record<string, unknown>).title === "string" &&
            ((s as Record<string, unknown>).title as string).trim().length > 0,
        )
        .slice(0, 20)
        .map((s: Record<string, unknown>) => ({
          title: String(s.title),
          ...(typeof s.url === "string" && s.url ? { url: s.url } : {}),
        }));
      if (sources.length > 0) {
        out.push({ id, role: "sources", sources });
      }
    }
  }
  return out;
}

function sanitizeThread(raw: unknown): RecentThread | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.threadId !== "string" || !t.threadId) return null;
  const status = sanitizeStatus(t.status);
  return {
    threadId: t.threadId,
    title: typeof t.title === "string" ? t.title : t.threadId,
    module: typeof t.module === "string" ? t.module : "chat",
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : 0,
    ...(Array.isArray(t.messages) && t.messages.length > 0
      ? { messages: sanitizeMessages(t.messages) }
      : {}),
    ...(t.remote === true ? { remote: true } : {}),
    ...(status ? { status } : {}),
  };
}

function readThreads(): RecentThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeThread)
      .filter((t): t is RecentThread => t !== null);
  } catch {
    return [];
  }
}

// Session-level dedup: a full quota would fail on *every* save — warn once
// instead of toasting on each turn.
let storageWarned = false;

function writeStorageQuotaGuarded(write: () => void): void {
  try {
    write();
  } catch {
    // storage full / unavailable — degrade, but make it visible (once).
    if (!storageWarned) {
      storageWarned = true;
      toast.error("对话历史保存失败", {
        description:
          "浏览器存储空间已满或不可用，历史记录将停止更新。删除部分旧对话后可恢复。",
        duration: 10000,
        richColors: true,
        closeButton: true,
      });
    }
  }
}

function writeThreads(threads: RecentThread[]): void {
  writeStorageQuotaGuarded(() => {
    // 索引永远不携带 messages：转写只存在于各自的 per-thread key 里。
    const index = threads.map(({ messages: _messages, ...meta }) => meta);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
  });
}

function threadStorageKey(threadId: string): string {
  // thread id 是本应用自己生成的短随机串或后端回显 id；固定前缀 + 原 id。
  return `${THREAD_KEY_PREFIX}${threadId}`;
}

function readThreadMessages(threadId: string): ThreadMessage[] | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(threadStorageKey(threadId));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return sanitizeMessages((parsed as { messages?: unknown }).messages);
      }
      return undefined;
    }
  } catch {
    return undefined;
  }
  // 旧格式迁移：转写还嵌在索引记录里。
  const legacy = readThreads().find((t) => t.threadId === threadId)?.messages;
  return legacy ? sanitizeMessages(legacy) : undefined;
}

// Read a full thread record (threadId, module, …) from localStorage. Used to
// recover the module of a thread when its transcript must be fetched from the
// backend checkpointer.
function readThread(threadId: string): RecentThread | undefined {
  return readThreads().find((t) => t.threadId === threadId);
}

export function ThreadProvider({ children }: { children: ReactNode }) {
  const [threads, setThreads] = useState<RecentThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  // Hydrate the thread list from localStorage once on the client (guarded
  // against SSR, where `window` is unavailable).
  useEffect(() => {
    setThreads(readThreads());
  }, []);

  const refresh = useCallback(() => {
    setThreads(readThreads());
  }, []);

  const saveThread = useCallback((t: RecentThread) => {
    setThreads((prev) => {
      const without = prev.filter((x) => x.threadId !== t.threadId);
      const next = [t, ...without].slice(0, MAX_THREADS);
      writeThreads(next);
      if (t.messages) {
        writeStorageQuotaGuarded(() => {
          window.localStorage.setItem(
            threadStorageKey(t.threadId),
            JSON.stringify({ messages: t.messages }),
          );
        });
      }
      return next;
    });
  }, []);

  const removeThread = useCallback((threadId: string) => {
    setThreads((prev) => {
      const next = prev.filter((x) => x.threadId !== threadId);
      writeThreads(next);
      return next;
    });
    writeStorageQuotaGuarded(() => {
      window.localStorage.removeItem(threadStorageKey(threadId));
    });
  }, []);

  const getThreadMessages = useCallback(
    (threadId: string) => readThreadMessages(threadId),
    [],
  );

  const getThread = useCallback((threadId: string) => readThread(threadId), []);

  const value: ThreadContextType = {
    threads,
    setThreads,
    threadsLoading,
    setThreadsLoading,
    saveThread,
    removeThread,
    refresh,
    getThreadMessages,
    getThread,
  };

  return (
    <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>
  );
}

export function useThreads(): ThreadContextType {
  const context = useContext(ThreadContext);
  if (context === undefined) {
    throw new Error("useThreads must be used within a ThreadProvider");
  }
  return context;
}
