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

// Conversation history stored in localStorage.
//
// agent-base deliberately has no thread-list endpoint (thin base); the UI
// keeps a local index of past conversations so the sidebar still works and
// a thread can be resumed with its id (the backend checkpointer restores
// the context). Persistence survives refreshes; the backend is untouched.

const STORAGE_KEY = "agent-base-ui:threads";
const MAX_THREADS = 50;

// Rendered transcript for one conversation. agent-base has no thread-list
// endpoint (thin base), so the UI persists the transcript it already renders
// and replays it when a past thread is reopened. The backend checkpointer
// independently restores *context* for follow-up turns.
export type ThreadMessage =
  | { id: string; role: "human"; content: string }
  | { id: string; role: "assistant"; content: string }
  | {
      id: string;
      role: "tool";
      name: string;
      status: "running" | "completed" | "error";
    };

export interface RecentThread {
  threadId: string;
  title: string;
  module: string;
  updatedAt: number;
  messages?: ThreadMessage[];
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

function readThreads(): RecentThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeThreads(threads: RecentThread[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
  } catch {
    // storage full / unavailable — best effort, history degrades silently
  }
}

// Read a thread's stored transcript directly from localStorage. Kept
// synchronous (and outside React state) so reopening a thread works even on
// the very first render, before the provider has hydrated its `threads` list.
function readThreadMessages(threadId: string): ThreadMessage[] | undefined {
  const found = readThreads().find((t) => t.threadId === threadId);
  return found?.messages;
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
      return next;
    });
  }, []);

  const removeThread = useCallback((threadId: string) => {
    setThreads((prev) => {
      const next = prev.filter((x) => x.threadId !== threadId);
      writeThreads(next);
      return next;
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