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
    return { id: `h-history-${index}`, role: "human", content: message.content ?? "" };
  }
  if (message.role === "assistant") {
    return { id: `a-history-${index}`, role: "assistant", content: message.content ?? "" };
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
      } catch {
        if (!cancelled) setMessages([]);
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

      let firstDeltaSeen = false;
      let savedThread = threadIdRef.current;

      try {
        const events = invokeAgent({
          apiUrl: finalApiUrl,
          module: finalModule,
          message: text.trim(),
          threadId: threadIdRef.current,
          requestId: rid,
        });
        for await (const event of events) {
          transcript = applyEvent(event, transcript);
          setMessages(transcript);
        }
      } catch (err) {
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
      } finally {
        setIsLoading(false);
        // Persist the thread (with its full transcript) once it has an id so
        // the history sidebar can reopen it later.
        if (savedThread) {
          saveThread({
            threadId: savedThread,
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
          case "step":
            if (event.status === "running") {
              return [
                ...current,
                {
                  id: `t-${rid}-${event.name}`,
                  role: "tool",
                  name: event.name,
                  status: "running",
                },
              ];
            }
            return current.map((m) =>
              m.role === "tool" && m.name === event.name
                ? { ...m, status: event.status }
                : m,
            );
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
            if (event.thread_id) {
              savedThread = event.thread_id;
              // The transcript on screen now belongs to this thread id, so the
              // threadId effect must not treat it as a switch and reload.
              transcriptThread.current = event.thread_id;
              setThreadId(event.thread_id);
            }
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

  const resetThread = useCallback(() => {
    setMessages([]);
    setError(null);
    transcriptThread.current = null;
    setThreadId(null);
  }, [setThreadId]);

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
    setApiUrl,
    setModule,
    sendMessage,
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
