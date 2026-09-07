import React, {
  createContext,
  useContext,
  ReactNode,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import { useThreads, type ThreadMessage } from "./Thread";
import {
  AgentBaseEvent,
  fetchThreadHistory,
  invokeAgent,
  requestId,
  type ThreadHistoryMessage,
} from "./agentBaseClient";
import { SetupScreen } from "@/components/thread/SetupScreen";

// UI message model — minimal by design:
// agent-base streams plain text deltas and node steps, nothing richer.
// The same shape is persisted per-thread in Thread.tsx so a past conversation
// can be reopened from the history sidebar.
export type UiMessage = ThreadMessage;

export interface StreamState {
  messages: UiMessage[];
  isLoading: boolean;
  error: string | null;
  threadId: string | null;
  module: string;
  apiUrl: string;
  setApiUrl: (value: string) => void;
  setModule: (value: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
  resetThread: () => void;
}

const StreamContext = createContext<StreamState | undefined>(undefined);

const DEFAULT_API_URL = "http://localhost:8000";
const DEFAULT_MODULE = "chat"; // chat | writer | supervisor

// Convert a backend history message into the UI message shape. Tool messages
// from persisted state are always "completed" (a checkpoint only contains
// finished tool calls).
function toUiMessage(message: ThreadHistoryMessage, index: number): UiMessage {
  if (message.role === "human") {
    return {
      id: `h-history-${index}`,
      role: "human",
      content: message.content ?? "",
    };
  }
  if (message.role === "assistant") {
    return {
      id: `a-history-${index}`,
      role: "assistant",
      content: message.content ?? "",
    };
  }
  return {
    id: `t-history-${index}`,
    role: "tool",
    name: message.name ?? "",
    status: "completed",
  };
}

export const StreamProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const envApiUrl: string | undefined = process.env.NEXT_PUBLIC_API_URL;
  const envModule: string | undefined = process.env.NEXT_PUBLIC_AGENT_MODULE;

  const [apiUrl, setApiUrl] = useQueryState("apiUrl", {
    defaultValue: envApiUrl || "",
  });
  const [module, setModule] = useQueryState("module", {
    defaultValue: envModule || "",
  });
  const [threadId, setThreadId] = useQueryState("threadId");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // apiUrl 的 localStorage 备份：URL 参数仍优先；用户手动输入的地址
  // 跨标签页/清参数后不丢。
  const API_URL_STORAGE_KEY = "agent-base-ui:apiUrl";
  useEffect(() => {
    if (apiUrl || typeof window === "undefined") return;
    const cached = window.localStorage.getItem(API_URL_STORAGE_KEY);
    if (cached) void setApiUrl(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const updateApiUrl = useCallback(
    (value: string) => {
      void setApiUrl(value);
      if (typeof window !== "undefined") {
        try {
          if (value) window.localStorage.setItem(API_URL_STORAGE_KEY, value);
          else window.localStorage.removeItem(API_URL_STORAGE_KEY);
        } catch {
          // 空间满/不可用：URL 参数仍可用，不阻塞配置。
        }
      }
    },
    [setApiUrl],
  );

  // In-flight turn's abort controller — the "stop generating" button and any
  // thread switch abort it, which propagates to the backend and cancels the
  // LLM call (client disconnect => cancellation).
  const abortRef = useRef<AbortController | null>(null);

  const { saveThread, getThreadMessages, getThread } = useThreads();

  const finalApiUrl = apiUrl || envApiUrl;
  const finalModule = module || envModule;

  // refs so async closures read the latest value without re-creating
  const threadIdRef = useRef(threadId);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  // Latest rendered transcript — used to seed a new turn so resuming a thread
  // keeps its previously-loaded history instead of replacing it.
  const messagesRef = useRef<UiMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Which thread the in-memory transcript currently belongs to. When the URL
  // threadId changes to a different value (history sidebar click / shared
  // link), we replay that thread's transcript. When it matches, we leave the
  // live transcript untouched — e.g. the `done` event assigning an id to the
  // fresh conversation currently on screen.
  const transcriptThread = useRef<string | null>(null);
  useEffect(() => {
    const target = threadId ?? null;
    if (target === transcriptThread.current) return;
    // 切换线程：进行中的流仍属于旧线程（会覆盖视图、无法停止）——
    // abort 它，同时触发后端的断连取消。
    abortRef.current?.abort();
    transcriptThread.current = target;
    setError(null);

    if (!target) {
      setMessages([]);
      return;
    }

    // Fast path: replay the locally-persisted transcript (instant).
    const stored = getThreadMessages(target);
    if (stored) {
      setMessages(stored);
      return;
    }

    // No local transcript — fetch the persisted history from the backend
    // checkpointer (threads created before transcript persistence, or on
    // another device). Fall back to an empty transcript if unavailable.
    const thread = getThread(target);
    const mod = thread?.module || finalModule;
    if (!finalApiUrl || !mod) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const history = await fetchThreadHistory({
          apiUrl: finalApiUrl,
          module: mod,
          threadId: target,
        });
        if (!cancelled) setMessages(history.messages.map(toUiMessage));
      } catch (err) {
        if (!cancelled) {
          // 拉取失败不能伪装成"空会话"——用户无从区分丢历史和没历史。
          setMessages([]);
          const message = err instanceof Error ? err.message : String(err);
          toast.error("拉取会话历史失败", {
            description: (
              <p>
                <strong>{message}</strong>
              </p>
            ),
            duration: 8000,
            richColors: true,
            closeButton: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, getThreadMessages, getThread, finalApiUrl, finalModule]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!finalApiUrl || !finalModule) return;
      if (isLoading || !text.trim()) return;

      const rid = requestId();
      const humanId = `h-${rid}`;
      const assistantId = `a-${rid}`;
      // thread id 前置生成（后端接受客户端提供的 id，并按
      // module:thread_id 划分命名空间）：本地生成而不是等 done 事件，
      // 断网/停止的对话也能落库恢复，不会悄悄丢失。
      const turnThreadId = threadIdRef.current ?? rid;
      // Local transcript is the single source of truth while streaming: the
      // same array is rendered (setMessages) and later persisted, so the saved
      // history always matches what the user saw. Seed from the messages
      // currently on screen (loaded history for a resumed thread, or [] for a
      // brand-new conversation) before appending the new human turn.
      let transcript: UiMessage[] = [
        ...messagesRef.current,
        { id: humanId, role: "human", content: text.trim() },
      ];
      setMessages(transcript);
      setIsLoading(true);
      setError(null);
      // The transcript on screen now belongs to this thread id, so the
      // threadId effect must not treat it as a switch and reload.
      transcriptThread.current = turnThreadId;
      setThreadId(turnThreadId);

      let firstDeltaSeen = false;
      // 同名步骤在同一轮里可以出现多次（agent → tools → agent），
      // 按 name 匹配会互相污染：记录 name -> 正在运行的那条消息 id，
      // 状态只更新匹配的 id，没有对应 running 的 completed 是 no-op。
      const runningSteps = new Map<string, string>();
      let stepSeq = 0;

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const events = invokeAgent({
          apiUrl: finalApiUrl,
          module: finalModule,
          message: text.trim(),
          threadId: turnThreadId,
          requestId: rid,
          signal: controller.signal,
        });
        for await (const event of events) {
          transcript = applyEvent(event, transcript);
          setMessages(transcript);
        }
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          toast.error("请求 agent-base 失败", {
            description: (
              <p>
                <strong>{message}</strong>
              </p>
            ),
            duration: 8000,
            richColors: true,
            closeButton: true,
          });
          if (!firstDeltaSeen) {
            // 断流兜底：一个 token 都没收到时回滚这条 human 消息，
            // 否则界面留下永远没有回复的孤儿消息，重发还会重复。
            transcript = transcript.filter((m) => m.id !== humanId);
            setMessages(transcript);
          }
        }
        // 用户主动停止（aborted）：保留已生成的部分内容，不当作错误。
      } finally {
        abortRef.current = null;
        setIsLoading(false);
        // Persist the thread (with its full transcript) so the history
        // sidebar can reopen it later. A fully rolled-back turn has nothing
        // worth persisting.
        if (transcript.length > 0) {
          saveThread({
            threadId: turnThreadId,
            title: text.trim().slice(0, 60),
            module: finalModule,
            updatedAt: Date.now(),
            messages: transcript,
          });
        }
      }

      function applyEvent(
        event: AgentBaseEvent,
        current: UiMessage[],
      ): UiMessage[] {
        switch (event.type) {
          case "ping":
            return current; // heartbeat — nothing to render
          case "step": {
            if (event.status === "running") {
              const stepId = `t-${rid}-${stepSeq++}`;
              runningSteps.set(event.name, stepId);
              return [
                ...current,
                {
                  id: stepId,
                  role: "tool",
                  name: event.name,
                  status: "running",
                  ...(event.detail ? { detail: event.detail } : {}),
                },
              ];
            }
            // completed / error 只落到该名字当前正在运行的那条上。
            const runningId = runningSteps.get(event.name);
            if (!runningId) return current;
            runningSteps.delete(event.name);
            return current.map((m) =>
              m.id === runningId ? { ...m, status: event.status } : m,
            );
          }
          case "delta":
            if (!firstDeltaSeen) {
              firstDeltaSeen = true;
              current = [
                ...current,
                { id: assistantId, role: "assistant", content: "" },
              ];
            }
            return current.map((m) =>
              m.id === assistantId && m.role === "assistant"
                ? { ...m, content: m.content + event.content }
                : m,
            );
          case "done":
            // thread id 已在本轮开始时前置生成并同步到 URL，后端回显的
            // thread_id 与之一致，这里无需再处理。
            return current;
          case "error":
            setError(event.message);
            toast.error("agent-base 返回错误", {
              description: (
                <p>
                  <strong>{event.message}</strong>
                </p>
              ),
              duration: 8000,
              richColors: true,
              closeButton: true,
            });
            return current;
        }
      }
    },
    [finalApiUrl, finalModule, isLoading, saveThread, setThreadId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetThread = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    transcriptThread.current = null;
    setThreadId(null);
  }, [setThreadId]);

  // 模块切换后 thread 命名空间不同：沿用旧 thread_id 会在新模块下命中
  // 另一个（多半为空的）会话，上下文静默错位——因此换模块必须重置线程。
  // 侧栏打开历史线程时也会先 setModule 再 setThreadId，重置不影响恢复。
  const switchModule = useCallback(
    (value: string) => {
      setModule(value);
      if (value !== module) {
        abortRef.current?.abort();
        setMessages([]);
        setError(null);
        transcriptThread.current = null;
        setThreadId(null);
      }
    },
    [module, setModule, setThreadId],
  );

  // Setup gate: require both a backend URL and a module before chatting.
  if (!finalApiUrl || !finalModule) {
    return (
      <SetupScreen
        defaultApiUrl={apiUrl || DEFAULT_API_URL}
        defaultModule={module || DEFAULT_MODULE}
        onSave={(c) => {
          setApiUrl(c.apiUrl);
          setModule(c.module);
        }}
      />
    );
  }

  const value: StreamState = {
    messages,
    isLoading,
    error,
    threadId,
    module: finalModule,
    apiUrl: finalApiUrl,
    setApiUrl: updateApiUrl,
    setModule: switchModule,
    sendMessage,
    stop,
    resetThread,
  };

  return (
    <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
  );
};

export function useStreamContext(): StreamState {
  const context = useContext(StreamContext);
  if (context === undefined) {
    throw new Error("useStreamContext must be used within a StreamProvider");
  }
  return context;
}

export default StreamContext;
