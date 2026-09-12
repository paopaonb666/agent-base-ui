import React, {
  createContext,
  useContext,
  ReactNode,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { toast } from "sonner";
import { useThreads, type ThreadMessage, type ThreadStatus } from "./Thread";
import {
  AgentBaseEvent,
  fetchThreadHistory,
  invokeAgent,
  requestId,
  type ThreadHistoryMessage,
} from "./agentBaseClient";
// UI message model — minimal by design:
// agent-base streams plain text deltas and node steps, nothing richer.
// The same shape is persisted per-thread in Thread.tsx so a past conversation
// can be reopened from the history sidebar.
export type UiMessage = ThreadMessage;

export interface SendMessageResult {
  ok: boolean;
  /** 调用方在失败时应把这份草稿放回输入框，避免用户长文本丢失。 */
  draft: string;
}

export interface StreamState {
  messages: UiMessage[];
  isLoading: boolean;
  error: string | null;
  threadId: string | null;
  module: string;
  apiUrl: string;
  setApiUrl: (value: string) => void;
  setModule: (value: string) => void;
  setThreadId: (value: string | null) => void;
  sendMessage: (text: string) => Promise<SendMessageResult>;
  stop: () => void;
  resetThread: () => void;
  /** 该线程是否正在流式对话（按线程追踪，与活跃视图无关）。渲染期调用，
   *  流开始/结束时由 streamingTrigger 触发重算（与 isLoading 同款机制）。 */
  isThreadStreaming: (threadId: string) => boolean;
}

const StreamContext = createContext<StreamState | undefined>(undefined);

// URL 参数与环境变量都缺省时的兜底配置，保证无配置也能直接进入聊天。
const DEFAULT_API_URL = "http://localhost:8000";
const DEFAULT_MODULE = "chat"; // chat | writer | supervisor

// 把后端历史按序重建为 UI 转写（M5 工具调用可观测）：AI 消息的
// tool_calls 生成带参数的调用条目，随后的 tool 消息按 tool_call_id
// 把结果/状态配对回去——参数与结果在 checkpointer 里各自持久化，靠
// id 合体。配不上的 tool 消息（异常兜底）降级为纯结果 chip。
function replayToUiMessages(messages: ThreadHistoryMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  const byCallId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "human") {
      out.push({ id: `h-history-${index}`, role: "human", content: message.content ?? "" });
      return;
    }
    if (message.role === "assistant") {
      for (const tc of message.tool_calls ?? []) {
        if (!tc.id) continue;
        byCallId.set(tc.id, out.length);
        out.push({
          id: `t-history-${tc.id}`,
          role: "tool",
          name: tc.name,
          status: "running", // 若后面的 tool 消息缺失，收尾净化会转成"已中断"
          ...(tc.args ? { args: tc.args } : {}),
        });
      }
      out.push({ id: `a-history-${index}`, role: "assistant", content: message.content ?? "" });
      return;
    }
    // tool 消息：按 tool_call_id 配对补上结果与状态。
    const callId = message.tool_call_id ?? "";
    const at = byCallId.get(callId);
    if (at !== undefined && out[at]?.role === "tool") {
      const entry = out[at] as Extract<UiMessage, { role: "tool" }>;
      out[at] = {
        ...entry,
        status: message.status === "error" ? "error" : "completed",
        result: message.content ?? "",
      };
      return;
    }
    out.push({
      id: `t-history-${index}`,
      role: "tool",
      name: message.name ?? "",
      status: message.status === "error" ? "error" : "completed",
      result: message.content ?? "",
    });
  });
  return out;
}

// localStorage keys：配置与"最后活跃会话"都不进 URL——后端地址和
// thread_id 出现在地址栏会随分享/浏览器历史泄露。
// 例外：?apiUrl= / ?module= 是 .env.example 明文支持的契约，优先级
// URL > 构建时 env > 用户保存的设置 > 内置默认；URL 参数不会落库。
const API_URL_STORAGE_KEY = "agent-base-ui:apiUrl";
const MODULE_STORAGE_KEY = "agent-base-ui:module";
const LAST_THREAD_KEY = "agent-base-ui:lastThread";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // 空间满/不可用：配置退化为进程内状态。
  }
}

/** .env.example 契约：?apiUrl= / ?module= URL 参数覆盖保存的设置（不落库）。 */
function readUrlOverride(key: "apiUrl" | "module"): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URLSearchParams(window.location.search).get(key);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export const StreamProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const envApiUrl: string | undefined = process.env.NEXT_PUBLIC_API_URL;
  const envModule: string | undefined = process.env.NEXT_PUBLIC_AGENT_MODULE;
  // 只在首次渲染求值一次，供 hydrate effect 判断优先级。
  const [urlApiUrl] = useState(() => readUrlOverride("apiUrl"));
  const [urlModule] = useState(() => readUrlOverride("module"));

  const [apiUrl, setApiUrl] = useState<string>(
    () =>
      readUrlOverride("apiUrl") ||
      envApiUrl ||
      readStorage(API_URL_STORAGE_KEY) ||
      DEFAULT_API_URL,
  );
  const [module, setModule] = useState<string>(
    () =>
      readUrlOverride("module") ||
      envModule ||
      readStorage(MODULE_STORAGE_KEY) ||
      DEFAULT_MODULE,
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  // 当前渲染的转写 —— 永远等于活跃线程的 transcriptsRef[activeThreadId]。
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 正在进行中的对话轮（按线程）：ref 供 sendMessage 守卫同步读取，
  // trigger 只用于在流开始/结束时触发重算 isLoading。
  const streamingRef = useRef<Set<string>>(new Set());
  const [streamingTrigger, setStreamingTrigger] = useState(0);

  const updateApiUrl = useCallback((value: string) => {
    setApiUrl(value);
    writeStorage(API_URL_STORAGE_KEY, value);
  }, []);

  const updateThreadId = useCallback((value: string | null) => {
    setThreadId(value);
    // 记住最后活跃会话：下次打开首页直接恢复（后端 checkpointer 回放）。
    writeStorage(LAST_THREAD_KEY, value);
  }, []);

  // In-flight turn's abort controller per thread —— “停止生成”只中止当前
  // 会话的流；切换会话不影响后台流（事件按线程路由，见 transcriptsRef）。
  const abortRefs = useRef<Map<string, AbortController>>(new Map());

  // 每个线程的权威转写（内存）。流事件永远写入这里；只有当该线程正是
  // 活跃线程时才同步到渲染状态。这是修复"切换/停止/刷新丢消息"的核心：
  // 流的生命周期与视图彻底解耦。
  const transcriptsRef = useRef<Map<string, UiMessage[]>>(new Map());
  // 活跃线程镜像（effect 里同步），供异步回调判断"该不该更新视图"。
  const activeThreadRef = useRef<string | null>(null);
  useEffect(() => {
    activeThreadRef.current = threadId;
  }, [threadId]);
  // sendMessage 的稳定闭包里读不到最新 threadId（它不在依赖数组里），
  // 必须走 ref：否则"新建对话"后发的第一轮会被路由进旧线程的转写。
  const threadIdRef = useRef<string | null>(null);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  // 当前渲染转写的镜像：sendMessage 以它兜底 seed，避免闭包过期。
  const messagesRef = useRef<UiMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setTranscript = useCallback(
    (id: string, next: UiMessage[]) => {
      // 刷新插入顺序，配合下方淘汰策略限制内存。
      transcriptsRef.current.delete(id);
      transcriptsRef.current.set(id, next);
      if (transcriptsRef.current.size > 50) {
        const oldest = transcriptsRef.current.keys().next().value;
        if (oldest !== undefined && oldest !== id) {
          transcriptsRef.current.delete(oldest);
        }
      }
      if (activeThreadRef.current === id) setMessages(next);
    },
    [],
  );

  const { saveThread, getThreadMessages, getThread } = useThreads();

  const finalApiUrl = apiUrl;
  const finalModule = module;

  // 打开首页即恢复最后活跃会话（localStorage 里只有无敏感的 thread id；
  // 对话内容本身由后端 checkpointer 持有，localStorage 没有就走历史
  // 恢复路径拉取）。注意不覆盖 URL 参数/构建时 env 的初始值——它们的
  // 优先级更高（见 .env.example 契约）。
  useEffect(() => {
    if (!urlModule) {
      const savedModule = readStorage(MODULE_STORAGE_KEY);
      if (savedModule) setModule(savedModule);
    }
    const saved = readStorage(LAST_THREAD_KEY);
    if (saved) setThreadId(saved);
  }, []);

  // 线程切换：把目标线程的转写渲染出来。绝不 abort 后台流——事件按
  // 线程路由（setTranscript），切走再切回来内容都在。effect 不再依赖
  // 任何跨执行的 ref 记号（旧实现的 transcriptThread 记号正是"切回上
  // 一个会话视图不动"的根源），StrictMode 双执行也天然安全。
  useEffect(() => {
    const target = threadId ?? null;
    setError(null);
    if (!target) {
      setMessages([]);
      return;
    }
    const live = transcriptsRef.current.get(target);
    if (live) {
      setMessages(live);
      return;
    }
    // 本地持久化的转写（即时显示），随后后台与后端对账（见下）。
    const stored = getThreadMessages(target);
    if (stored) setMessages(stored);

    const thread = getThread(target);
    const mod = thread?.module || finalModule;
    if (!finalApiUrl || !mod) {
      if (!stored) setMessages([]);
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
        if (cancelled) return;
        const remote = replayToUiMessages(history.messages);
        // 后端是该线程转写的权威来源，但只在"不少于本地"时覆盖：被停止
        // 的轮次后端可能只有更短的历史，不能拿旧快照抹掉用户刚看到的
        // 半截回复。
        if (remote.length > (stored?.length ?? 0)) {
          setTranscript(target, remote);
        }
      } catch (err) {
        if (!cancelled && !stored) {
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
  }, [threadId, getThreadMessages, getThread, finalApiUrl, finalModule, setTranscript]);

  const sendMessage = useCallback(
    async (text: string): Promise<SendMessageResult> => {
      if (!finalApiUrl || !finalModule) return { ok: false, draft: text };
      if (!text.trim()) return { ok: false, draft: text };

      const rid = requestId();
      const humanId = `h-${rid}`;
      const assistantId = `a-${rid}`;
      // thread id 前置生成（后端接受客户端提供的 id，并按
      // module:thread_id 划分命名空间）：本地生成而不是等 done 事件，
      // 断网/停止的对话也能落库恢复，不会悄悄丢失。
      const currentThreadId = threadIdRef.current;
      const turnThreadId = currentThreadId ?? rid;
      // 同一线程同时只允许一轮：并发写同一个 checkpointer 线程会竞态。
      if (streamingRef.current.has(turnThreadId)) {
        return { ok: false, draft: text };
      }
      streamingRef.current.add(turnThreadId);
      const turnModule = finalModule;

      // Seed from the thread's own transcript (live in memory, else what is
      // on screen, else locally persisted) before appending the new turn.
      const seed =
        transcriptsRef.current.get(turnThreadId) ??
        (activeThreadRef.current === turnThreadId ? messagesRef.current : undefined) ??
        getThreadMessages(turnThreadId) ??
        [];
      let transcript: UiMessage[] = [
        ...seed,
        { id: humanId, role: "human", content: text.trim() },
      ];
      setTranscript(turnThreadId, transcript);
      setError(null);
      updateThreadId(turnThreadId);
      // 立即持久化：流中刷新/崩溃至少保住用户已发出的消息和线程记录，
      // 而不是整轮凭空蒸发。status 标记"正在对话"：流正常收口会被终态
      // 覆盖；流中刷新则由 sanitizeStatus 把它降级为"对话终止"。
      if (transcript.length > 0) {
        const existingAtStart = getThread(turnThreadId);
        saveThread({
          threadId: turnThreadId,
          title: existingAtStart?.title ?? text.trim().slice(0, 60),
          module: turnModule,
          updatedAt: Date.now(),
          messages: transcript,
          status: "streaming",
        });
      }

      let firstDeltaSeen = false;
      // 同名步骤在同一轮里可以出现多次（agent → tools → agent），而且
      // 模型可以在一条消息里并行发多个同名工具调用（如两次 web_search），
      // 各自的 running/completed 事件按到达顺序交错。按 name 单槽匹配会
      // 互相覆盖：第二次 running 顶掉第一次的槽位，先完成的 completed
      // 配到后启动的条目上，先启动的条目永远留在 running——收口时被误标
      // "已中断"。因此每个 name 维护一个 FIFO 队列：running 入队，
      // completed 出队，与事件到达顺序天然配对；没有对应 running 的
      // completed 是 no-op。
      const runningSteps = new Map<string, string[]>();
      // 工具调用卡片（M5）：call_id -> 转写条目 id。tool_call 事件的
      // start/end 靠它精确配对，天然免疫并行同名调用。
      const toolCardsByCallId = new Map<string, string>();
      const toolCardIds = new Set<string>();
      let stepSeq = 0;

      const controller = new AbortController();
      abortRefs.current.set(turnThreadId, controller);
      let aborted = false;
      let failed = false;
      // 后端在流中返回 error 事件：本轮已废，但连接多半还会走到 done，
      // catch 抓不到——单独记号，收口时归入"对话异常"。
      let backendErrored = false;
      try {
        const events = invokeAgent({
          apiUrl: finalApiUrl,
          module: turnModule,
          message: text.trim(),
          threadId: turnThreadId,
          requestId: rid,
          signal: controller.signal,
        });
        for await (const event of events) {
          transcript = applyEvent(event, transcript);
          setTranscript(turnThreadId, transcript);
        }
      } catch (err) {
        aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          failed = true;
          const message = err instanceof Error ? err.message : String(err);
          if (activeThreadRef.current === turnThreadId) setError(message);
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
            setTranscript(turnThreadId, transcript);
          }
        }
        // 用户主动停止（aborted）：保留已生成的部分内容，不当作错误。
      } finally {
        abortRefs.current.delete(turnThreadId);
        streamingRef.current.delete(turnThreadId);
        setStreamingTrigger((n) => n + 1); // 触发 isLoading 重算
        // 收尾：把仍在 "running" 的步骤标记为终态。流结束后不允许任何
        // running 徽标存活（旧实现正是在这里留下永久"运行中"）。
        const stopped = aborted;
        transcript = transcript.map((m) =>
          m.role === "tool" && m.status === "running"
            ? {
                ...m,
                status: "error" as const,
                detail: stopped ? "已停止" : "已中断",
              }
            : m,
        );
        setTranscript(turnThreadId, transcript);

        // 会话收尾状态：用户停止 = 终止；请求失败或后端报错 = 异常；
        // 其余 = 正常结束（chat-agent 把这三类终态混在一个 finally 里
        // 不区分，这里显式区分开，供侧栏/顶栏的状态点展示）。
        const finalStatus: ThreadStatus = aborted
          ? "terminated"
          : failed || backendErrored
            ? "error"
            : "ended";

        // Persist the thread (with its full transcript) so the history
        // sidebar can reopen it later. A fully rolled-back turn has nothing
        // worth persisting. 标题只在会话首轮以首条用户消息命名（与后端
        // /threads 端点一致），后续轮次不改写。
        if (transcript.length > 0) {
          const existing = getThread(turnThreadId);
          saveThread({
            threadId: turnThreadId,
            title: existing?.title ?? text.trim().slice(0, 60),
            module: turnModule,
            updatedAt: Date.now(),
            messages: transcript,
            status: finalStatus,
          });
        } else if (finalStatus === "error") {
          // 全新线程整轮回滚（一个 token 都没收到）：转写没东西可存，
          // 但索引里已有开始时落下的 "streaming" 记录，必须收口成异常态，
          // 否则刷新后会被误降级为"对话终止"。
          const existing = getThread(turnThreadId);
          if (existing) {
            saveThread({
              threadId: turnThreadId,
              title: existing.title,
              module: existing.module,
              updatedAt: Date.now(),
              status: "error",
            });
          }
        }

        // 正常完成的轮次：以后端 checkpointer 为权威做一次对账，替换本地
        // 转写。这从根上治愈"本地视图与真实历史漂移"（停止/中断残留的
        // 半截内容、丢步骤等）。被用户停止的轮次不对账——后端可能没有
        // 本轮 checkpoint，对账会把用户刚看到的半截回复抹掉。
        if (!aborted) {
          void reconcileFromBackend(turnThreadId, turnModule);
        }
      }

      // 失败时调用方会把草稿放回输入框；停止/成功不回填。
      return { ok: !failed, draft: text };

      async function reconcileFromBackend(
        id: string,
        mod: string,
      ): Promise<void> {
        try {
          const history = await fetchThreadHistory({
            apiUrl: finalApiUrl,
            module: mod,
            threadId: id,
          });
          const remote = replayToUiMessages(history.messages);
          // 轮次已结束（同线程串行）。只在后端历史比本地更完整时才覆盖：
          // 本地转写带步骤徽标、所见即所得，比它短的后端快照没有理由
          // 抹掉它；比它长说明本地确实缺了内容（唯一要治的漂移）。
          // 若用户在对账返回前删掉了该线程，transcriptsRef 里没有它则跳过。
          if (
            remote.length > transcript.length &&
            transcriptsRef.current.has(id)
          ) {
            setTranscript(id, remote);
            const current = getThread(id);
            if (current) {
              // 重建一条干净的本地记录：不带 remote 标记（转写已在本地）。
              // status 保留收尾时写入的终态——对账只修内容，不改状态。
              saveThread({
                threadId: id,
                title: current.title,
                module: current.module,
                updatedAt: Date.now(),
                messages: remote,
                status: current.status ?? "ended",
              });
            }
          }
        } catch {
          // 对账失败不打扰用户：本地转写已经是完整所见即所得。
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
            // running：该名字已有工具调用卡片在跑时跳过——卡片带参数与
            // 结果（step 的信息超集），不生成重复 chip。
            if (event.status === "running") {
              const running = runningSteps.get(event.name);
              if (running && running.length > 0) return current;
              const stepId = `t-${rid}-${stepSeq++}`;
              const queue = runningSteps.get(event.name) ?? [];
              queue.push(stepId);
              runningSteps.set(event.name, queue);
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
            // completed / error 只落到该名字 FIFO 队列的队首：并行同名
            // 调用时按事件到达顺序配对；队列里若是工具调用卡片，其终态
            // 已由 tool_call end 事件写入（end 会把自己摘出队列），此处
            // 幂等；若 end 因异常路径缺失，此处兜底收尾。
            const queue = runningSteps.get(event.name);
            if (!queue || queue.length === 0) return current;
            const runningId = queue.shift()!;
            if (queue.length === 0) runningSteps.delete(event.name);
            return current.map((m) =>
              m.id === runningId
                ? {
                    ...m,
                    status: event.status,
                    ...(event.status === "completed" && event.detail
                      ? { result: event.detail }
                      : {}),
                  }
                : m,
            );
          }
          case "tool_call": {
            if (event.phase === "start") {
              const entryId = `tc-${rid}-${event.call_id}`;
              toolCardsByCallId.set(event.call_id, entryId);
              toolCardIds.add(entryId);
              const queue = runningSteps.get(event.name) ?? [];
              queue.push(entryId);
              runningSteps.set(event.name, queue);
              return [
                ...current,
                {
                  id: entryId,
                  role: "tool",
                  name: event.name,
                  status: "running" as const,
                  call_id: event.call_id,
                  ...(event.args ? { args: event.args } : {}),
                },
              ];
            }
            // end：按 call_id 精确回填终态（status/result/耗时/错误），
            // 并把该条目从 step 的 FIFO 队列摘除。
            const entryId = toolCardsByCallId.get(event.call_id);
            if (!entryId) return current;
            toolCardsByCallId.delete(event.call_id);
            toolCardIds.delete(entryId);
            const queue = runningSteps.get(event.name);
            if (queue) {
              const at = queue.indexOf(entryId);
              if (at >= 0) queue.splice(at, 1);
              if (queue.length === 0) runningSteps.delete(event.name);
            }
            const status = event.status === "ok" ? "completed" : "error";
            return current.map((m) =>
              m.id === entryId
                ? {
                    ...m,
                    status: status as "completed" | "error",
                    ...(event.result ? { result: event.result } : {}),
                    ...(event.duration_ms !== null ? { duration_ms: event.duration_ms } : {}),
                    ...(event.error ? { error: event.error } : {}),
                  }
                : m,
            );
          }
          case "sources": {
            // 工具发布的引用来源：作为独立转写条目渲染在回复旁。
            if (!event.sources || event.sources.length === 0) return current;
            return [
              ...current,
              {
                id: `s-${rid}-${stepSeq++}`,
                role: "sources" as const,
                sources: event.sources
                  .filter((s) => s.title)
                  .map((s) => ({ title: s.title, ...(s.url ? { url: s.url } : {}) })),
              },
            ];
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
            backendErrored = true;
            if (activeThreadRef.current === turnThreadId) {
              setError(event.message);
            }
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
    [
      finalApiUrl,
      finalModule,
      getThreadMessages,
      getThread,
      saveThread,
      setTranscript,
      updateThreadId,
    ],
  );

  const stop = useCallback(() => {
    const id = activeThreadRef.current;
    if (id === null) return;
    abortRefs.current.get(id)?.abort();
  }, []);

  const resetThread = useCallback(() => {
    // 后台流不中止：它属于它自己的线程，事件照常落账并持久化；
    // 用户想停可以点"停止"。这里只是把视图切到一张白纸。
    setMessages([]);
    setError(null);
    updateThreadId(null);
  }, [updateThreadId]);

  // 模块切换后 thread 命名空间不同：沿用旧 thread_id 会在新模块下命中
  // 另一个（多半为空的）会话，上下文静默错位——因此换模块必须重置线程。
  // 侧栏打开历史线程时也会先 setModule 再 setThreadId，重置不影响恢复。
  // 后台流照常继续（事件按线程路由，不属于当前视图）。
  const switchModule = useCallback(
    (value: string) => {
      setModule(value);
      writeStorage(MODULE_STORAGE_KEY, value);
      if (value !== module) {
        setMessages([]);
        setError(null);
        updateThreadId(null);
      }
    },
    [module, setModule, updateThreadId],
  );

  // trigger 变化令本次渲染重算 isLoading（流开始/结束都要刷新按钮态）。
  void streamingTrigger;
  const isLoading = threadId !== null && streamingRef.current.has(threadId);

  const isThreadStreaming = useCallback(
    (id: string) => streamingRef.current.has(id),
    [],
  );

  const value: StreamState = {
    messages,
    isLoading,
    error,
    threadId,
    module: finalModule,
    apiUrl: finalApiUrl,
    setApiUrl: updateApiUrl,
    setModule: switchModule,
    setThreadId: updateThreadId,
    sendMessage,
    stop,
    resetThread,
    isThreadStreaming,
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
