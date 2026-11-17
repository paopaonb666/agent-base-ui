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
import {
  useThreads,
  type AttachmentMeta,
  type ThreadMessage,
  type ThreadStatus,
} from "./Thread";
import {
  AgentBaseEvent,
  fetchThreadHistory,
  fetchThreadPlan,
  invokeAgent,
  requestId,
  resumeAgent,
  steerThread as steerThreadApi,
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

export interface SendMessageOptions {
  /** 消息树分岔（ADR-013）：新消息挂在哪个节点之下；缺省=当前活跃叶子。 */
  parentNodeId?: string;
  /** 重新生成：不追加新 human 气泡，在 parentNodeId（既有 human 节点）
   * 下重跑一轮——本地转写先截断到该节点，新的 AI 回复作为兄弟分支。 */
  regenerate?: boolean;
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
  sendMessage: (
    text: string,
    attachments?: AttachmentMeta[],
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
  stop: () => void;
  resetThread: () => void;
  /** 强制从后端重载当前线程的转写（分支切换后由 Tree 层调用）：
   *  绕过内存/本地缓存短路，以后端活跃路径为准整体替换。 */
  reloadThread: () => void;
  /** 该线程是否正在流式对话（按线程追踪，与活跃视图无关）。渲染期调用，
   *  流开始/结束时由 streamingTrigger 触发重算（与 isLoading 同款机制）。 */
  isThreadStreaming: (threadId: string) => boolean;
  /** 当前活跃线程的待审批信息（审批门暂停）；null=无可审批项。
   *  决定落账走 postApproval 客户端函数，全部决定后调 resumeThread 续跑。 */
  pausedInfo: (PendingApproval & { threadId: string }) | null;
  /** 继续执行：对审批门暂停的活跃线程调 resume 端点重新开流（复用
   *  事件管线；非暂停态/流进行中为 no-op）。 */
  resumeThread: () => void;
  /** 运行中插话（steer）：仅在活跃线程流进行中有效；成功 toast，
   *  失败（404 无在途 run / 429 队列满）由错误 toast 带出。 */
  steer: (content: string) => Promise<void>;
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
    // 消息树锚点（ADR-013）：历史每条带 node_id（+ 可选的标签/星标），
    // 分岔/跳转/树面板定位都以它为键。
    const treeMeta = {
      ...(message.node_id ? { nodeId: message.node_id } : {}),
      ...(message.label ? { label: message.label } : {}),
      ...(message.starred ? { starred: true } : {}),
    };
    if (message.role === "human") {
      out.push({
        id: `h-history-${index}`,
        role: "human",
        content: message.content ?? "",
        ...treeMeta,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      });
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
          ...treeMeta,
          ...(tc.args ? { args: tc.args } : {}),
        });
      }
      out.push({
        id: `a-history-${index}`,
        role: "assistant",
        content: message.content ?? "",
        ...treeMeta,
      });
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
        ...(message.node_id ? { nodeId: message.node_id } : {}),
      };
      return;
    }
    out.push({
      id: `t-history-${index}`,
      role: "tool",
      name: message.name ?? "",
      status: message.status === "error" ? "error" : "completed",
      result: message.content ?? "",
      ...treeMeta,
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

/**
 * 请求失败的 toast 文案（GUI 验收二轮噪音 1）：fetch 的网络层失败以原始
 * TypeError（"Failed to fetch"/"network error"）冒出，全中文界面里夹一条
 * 裸英文串——翻译成行动指引；其余（throwApiError 组装的中文文案）原样。
 */
function friendlyRequestError(err: unknown): string {
  if (err instanceof TypeError) {
    return "无法连接 agent-base 服务，请检查服务地址与网络后重试";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把远端历史的树锚点（node_id/label/starred，ADR-013）按**角色序列对齐**
 * 回填到本地转写。本地转写可能比后端历史"长"（步骤徽标是本地独有的
 * 视觉条目）——不能按总长度判断：远端每条在本地序列里找同角色（tool
 * 另须 call_id 一致；本地独有的步骤徽标没有 call_id，被自然跳过）的
 * 条目，补上锚点。无变化返回 null。
 */
function mergeTreeAnchors(
  local: UiMessage[],
  remote: UiMessage[],
): UiMessage[] | null {
  let changed = false;
  let li = 0;
  const merged = local.map((m) => m);
  for (const r of remote) {
    // 远端（历史回放）不会有 sources/plan 条目，但类型上是同一联合——
    // 显式跳过让 r 收窄到带树锚点的三角色。
    if (r.role === "sources" || r.role === "plan") continue;
    while (
      li < local.length &&
      (local[li].role === "sources" ||
        local[li].role !== r.role ||
        (r.role === "tool" &&
          ((local[li] as { call_id?: string }).call_id ?? "") !==
            (r.call_id ?? "")))
    ) {
      li += 1; // 跳过本地独有的条目（步骤徽标 / sources 卡片）
    }
    if (li >= local.length) break;
    const m = local[li];
    if (m.role === "sources" || m.role === "plan") {
      // 本地独有的视觉条目（引用卡/计划卡）不参与锚点对齐。
      li += 1;
      continue;
    }
    if (!m.nodeId && r.nodeId) {
      merged[li] = {
        ...m,
        nodeId: r.nodeId,
        ...(r.label ? { label: r.label } : {}),
        ...(r.starred ? { starred: true } : {}),
      };
      changed = true;
    }
    li += 1;
  }
  return changed ? merged : null;
}

// ── 审批门暂停（Java wire 扩展 #26/#62） ──────────────────────────────

/** 审批门暂停时等待决定的一个调用（工具门=悬挂 tool_calls；计划门=保留键 "plan"）。 */
export interface PendingApprovalCall {
  callId: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** 一轮暂停的待审批信息：kind=tool 逐调用批准/拒绝；kind=plan 对整个计划
 * 一次决定。calls 为空（历史拉取失败）时 UI 退化为「直接继续/放弃」。 */
export interface PendingApproval {
  kind: "tool" | "plan";
  /** 审批 step 的 detail（pending_calls=N;tools=a|b 或 "plan"），兜底展示。 */
  detail?: string;
  calls: PendingApprovalCall[];
}

/** 一轮流式的可变状态：由 createEventApplier 就地更新、finally 收尾读取。 */
interface TurnState {
  firstDeltaSeen: boolean;
  backendErrored: boolean;
  /** done 事件 termination="paused"：本轮以审批暂停收尾。 */
  paused: boolean;
  /** 审批 step 的 detail（计划门="plan"；工具门=pending_calls=N;tools=…）。 */
  approvalDetail: string | null;
}

/**
 * 事件处理器工厂（按轮创建）：把 applyEvent 从 sendMessage 闭包提为可复用
 * 形态——invoke 轮与 resume 轮共用同一套事件→转写映射。running/completed
 * 的 FIFO 配对、tool_call 的 call_id 配对语义与旧实现逐字节一致。
 */
function createEventApplier(
  rid: string,
  state: TurnState,
  onError: (message: string) => void,
): (event: AgentBaseEvent, current: UiMessage[]) => UiMessage[] {
  // 同名步骤在同一轮里可以出现多次（agent → tools → agent），而且
  // 模型可以在一条消息里并行发多个同名工具调用（如两次 web_search），
  // 各自的 running/completed 事件按到达顺序交错。按 name 维护 FIFO 队列：
  // running 入队，completed 出队，与事件到达顺序天然配对；没有对应
  // running 的 completed 是 no-op。
  const runningSteps = new Map<string, string[]>();
  // 工具调用卡片（M5）：call_id -> 转写条目 id。tool_call 事件的
  // start/end 靠它精确配对，天然免疫并行同名调用。
  const toolCardsByCallId = new Map<string, string>();
  let stepSeq = 0;
  const assistantId = `a-${rid}`;
  return (event, current) => {
    switch (event.type) {
      case "ping":
        return current; // heartbeat — nothing to render
      case "step": {
        // 审批门暂停预告（#26/#62）：name="approval" 只有 running 形态，
        // 没有配对的 completed——不进 FIFO，建专属「等待审批」chip；
        // 随后跟随 done(termination="paused")。
        if (event.name === "approval") {
          state.approvalDetail = event.detail ?? state.approvalDetail;
          return [
            ...current,
            {
              id: `t-${rid}-${stepSeq++}`,
              role: "tool",
              name: "审批",
              status: "paused" as const,
              ...(event.detail ? { detail: event.detail } : {}),
            },
          ];
        }
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
          m.id === runningId && m.role === "tool"
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
        const queue = runningSteps.get(event.name);
        if (queue) {
          const at = queue.indexOf(entryId);
          if (at >= 0) queue.splice(at, 1);
          if (queue.length === 0) runningSteps.delete(event.name);
        }
        const status = event.status === "ok" ? "completed" : "error";
        return current.map((m) =>
          m.id === entryId && m.role === "tool"
            ? {
                ...m,
                status: status as "completed" | "error",
                ...(event.result ? { result: event.result } : {}),
                ...(event.duration_ms !== null
                  ? { duration_ms: event.duration_ms }
                  : {}),
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
              .map((s) => ({
                title: s.title,
                ...(s.url ? { url: s.url } : {}),
              })),
          },
        ];
      }
      case "delta":
        if (!state.firstDeltaSeen) {
          state.firstDeltaSeen = true;
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
      case "plan":
        // planner plan 事件：整表替换语义——单条卡片按轮 id 复用。
        {
          const entryId = `p-${rid}`;
          const entry: UiMessage = {
            id: entryId,
            role: "plan",
            status: event.status,
            tasks: event.plan,
            ...(event.detail ? { detail: event.detail } : {}),
          };
          const at = current.findIndex((m) => m.id === entryId);
          if (at >= 0) {
            const next = [...current];
            next[at] = entry;
            return next;
          }
          return [...current, entry];
        }
      case "done":
        // thread id 已在本轮开始时前置生成并同步到本地索引，后端回显的
        // thread_id 与之一致，这里无需再处理；termination 驱动收尾状态。
        if (event.termination === "paused") state.paused = true;
        return current;
      case "error":
        state.backendErrored = true;
        onError(event.message);
        return current;
    }
  };
}

/** 流收尾：把仍在 "running" 的步骤标记为终态。流结束后不允许任何
 * running 徽标存活；审批暂停轮的残留 running 是「等待审批」而非中断。 */
function finalizeToolCards(
  current: UiMessage[],
  opts: { stopped: boolean; paused: boolean },
): UiMessage[] {
  return current.map((m) =>
    m.role === "tool" && m.status === "running"
      ? {
          ...m,
          status: opts.paused ? ("paused" as const) : ("error" as const),
          detail: opts.paused ? "等待审批" : opts.stopped ? "已停止" : "已中断",
        }
      : m,
  );
}

/** 从历史尾部解析待审批调用：取消轮的悬挂 tool_calls 在服务端落盘前被
 * 剥除，因此历史尾部 assistant 的未配对发起方 = 审批门暂停（有意保留）。
 * 从尾部向首扫，tool 结果行跳过，命中 assistant 即取其 tool_calls。 */
function pendingCallsFromHistory(
  messages: ThreadHistoryMessage[],
): PendingApprovalCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      return (m.tool_calls ?? [])
        .filter((tc) => tc.id)
        .map((tc) => ({
          callId: tc.id,
          name: tc.name,
          ...(tc.args ? { args: tc.args } : {}),
        }));
    }
    break; // human：无悬挂
  }
  return [];
}

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

  // 审批门暂停登记（per thread）：暂停轮收尾时写入（待审批调用从历史尾
  // 悬挂 tool_calls 解析），resume 开跑时清除，线程切换时镜像到 pausedInfo。
  const pausedTurnsRef = useRef<Map<string, PendingApproval>>(new Map());
  const [pausedInfo, setPausedInfo] = useState<
    (PendingApproval & { threadId: string }) | null
  >(null);

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

  // pausedTurnsRef → 渲染态镜像：登记变化/线程切换时调用（活跃线程的
  // 待审批信息供审批卡渲染）。
  const syncPausedInfo = useCallback(() => {
    const id = activeThreadRef.current;
    const pending = id ? pausedTurnsRef.current.get(id) : undefined;
    setPausedInfo(pending ? { ...pending, threadId: id! } : null);
  }, []);
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

  // 分支切换后的受控重载（ADR-013）：清掉内存转写 + 强制标记，让线程
  // 切换 effect 绕过缓存短路，以后端活跃路径为准整体替换视图。
  const [reloadCounter, setReloadCounter] = useState(0);
  const forceReloadRef = useRef(false);
  const reloadThread = useCallback(() => {
    const id = threadIdRef.current;
    if (id) transcriptsRef.current.delete(id);
    forceReloadRef.current = true;
    setReloadCounter((n) => n + 1);
  }, []);

  const setTranscript = useCallback((id: string, next: UiMessage[]) => {
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
  }, []);

  const { saveThread, getThreadMessages, getThread } = useThreads();

  const finalApiUrl = apiUrl;
  const finalModule = module;

  // 收尾对账（原 sendMessage 内嵌函数提为 provider 级）：invoke 轮与
  // resume 轮共用。force（重新生成轮）时远端无条件接管；否则只在远端
  // 更完整时覆盖——本地转写带步骤徽标、所见即所得，被它短的后端快照
  // 没有理由抹掉它；其余情况做树锚点回填（ADR-013）。
  const reconcileFromBackend = useCallback(
    async (id: string, mod: string, opts?: { force?: boolean }) => {
      try {
        const history = await fetchThreadHistory({
          apiUrl: finalApiUrl,
          module: mod,
          threadId: id,
        });
        const remote = replayToUiMessages(history.messages);
        // 若用户在对账返回前删掉了该线程，transcriptsRef 里没有它则跳过。
        if (!transcriptsRef.current.has(id)) return;
        const current = transcriptsRef.current.get(id) ?? [];
        if (opts?.force || remote.length > current.length) {
          setTranscript(id, remote);
          const t = getThread(id);
          if (t) {
            saveThread({
              threadId: id,
              title: t.title,
              module: t.module,
              updatedAt: Date.now(),
              messages: remote,
              status: t.status ?? "ended",
            });
          }
          return;
        }
        const merged = mergeTreeAnchors(current, remote);
        if (merged) {
          setTranscript(id, merged);
          const t = getThread(id);
          if (t) {
            saveThread({
              threadId: id,
              title: t.title,
              module: t.module,
              updatedAt: Date.now(),
              messages: merged,
              status: t.status ?? "ended",
            });
          }
        }
      } catch {
        // 对账失败不打扰用户：本地转写已经是完整所见即所得。
      }
    },
    [finalApiUrl, getThread, saveThread, setTranscript],
  );

  // 暂停轮登记：计划门（审批 step detail="plan"）用保留键 "plan"；
  // 工具门优先读 GET plan 的 pending_kind/pending_calls（GUI 验收三轮
  // R3-D2——planner execute 子任务内的暂停，tool_calls 在子任务私有转写
  // 里、线程历史尾是 human，历史解析必然空 → 死卡三路死锁；后端随暂停
  // 标记落盘的 calls 明细经 plan 端点权威透出）；回落历史悬挂 tool_calls
  // 解析（chat 图暂停的既有形态，plan 端点 404/503 或无明细时）。404 掩
  // 蔽的非属主线程两条路都拿不到 → calls 空，UI 退化为直接继续/放弃。
  const registerPausedTurn = useCallback(
    async (id: string, mod: string, approvalDetail: string | null) => {
      let pending: PendingApproval;
      if (approvalDetail === "plan") {
        pending = {
          kind: "plan",
          detail: approvalDetail,
          calls: [{ callId: "plan" }],
        };
      } else {
        let calls: PendingApprovalCall[] = [];
        try {
          const plan = await fetchThreadPlan({
            apiUrl: finalApiUrl,
            module: mod,
            threadId: id,
          });
          if (plan?.pendingKind === "tool" && plan.pendingCalls?.length) {
            calls = plan.pendingCalls.map((c) => ({
              callId: String(c.id ?? ""),
              ...(c.name ? { name: String(c.name) } : {}),
            }));
          }
        } catch {
          // plan 端点失败：回落历史解析（尽力而为）。
        }
        if (calls.length === 0) {
          try {
            const history = await fetchThreadHistory({
              apiUrl: finalApiUrl,
              module: mod,
              threadId: id,
            });
            calls = pendingCallsFromHistory(history.messages);
          } catch {
            // 历史拉取失败：登记空 calls（detail 兜底展示），resume 仍可用。
          }
        }
        pending = {
          kind: "tool",
          ...(approvalDetail ? { detail: approvalDetail } : {}),
          calls,
        };
      }
      pausedTurnsRef.current.set(id, pending);
      syncPausedInfo();
    },
    [finalApiUrl, syncPausedInfo],
  );

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
    syncPausedInfo();
    if (!target) {
      setMessages([]);
      return;
    }
    // 分支切换的强制重载：绕过内存/本地缓存短路，视图整体让位给后端
    // 活跃路径（新路径可能比旧缓存短——长度比较不适用）。
    const forced = forceReloadRef.current;
    forceReloadRef.current = false;
    const live = forced ? undefined : transcriptsRef.current.get(target);
    if (live) {
      setMessages(live);
      return;
    }
    // 本地持久化的转写（即时显示），随后后台与后端对账（见下）。
    const stored = forced ? undefined : getThreadMessages(target);
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
        const rawRemote = replayToUiMessages(history.messages);
        // 云端/持久化的暂停线程探测（best-effort）：取消轮的悬挂 tool_calls
        // 在服务端落盘前剥除，因此历史尾部 assistant 的未配对发起方 =
        // 审批门暂停（快照有意保留）。把对应 running 卡转成「等待审批」
        // 并登记，供审批卡与 resume 使用；不计入对账语义。
        const dangling = pendingCallsFromHistory(history.messages);
        const remote =
          dangling.length > 0
            ? (rawRemote.map((m) =>
                m.role === "tool" && m.status === "running"
                  ? {
                      ...m,
                      status: "paused" as const,
                      ...(m.detail ? {} : { detail: "等待审批" }),
                    }
                  : m,
              ) as UiMessage[])
            : rawRemote;
        // 计划门待批信号：探测结果留给下方的暂停对账分支使用。
        let planPending = false;
        // 工具门待批信号（R3-D2）：execute 子任务内的暂停快照尾无悬挂
        // tool_calls，pending_calls 权威明细经 plan 端点透出。
        let toolGatePending = false;
        if (dangling.length > 0) {
          pausedTurnsRef.current.set(target, { kind: "tool", calls: dangling });
          syncPausedInfo();
        } else {
          // 计划门/工具门暂停的权威探测（GUI 验收缺陷 9 + 三轮 R3-D2）：
          // 工具门=历史尾悬挂 tool_calls 或 plan 端点 pending_kind=tool
          // （execute 子任务内暂停，明细 pending_calls）；计划门 marker 在
          // 快照 extras、历史消息不可见——status=paused 时查 GET plan 的
          // pending_approval / pending_kind（后端权威键），恢复视图由此
          // 获得审批卡（计划门）或逐调用审批卡（工具门）与「继续执行」入口。
          if (thread?.status === "paused") {
            try {
              const plan = await fetchThreadPlan({
                apiUrl: finalApiUrl,
                module: mod,
                threadId: target,
              });
              if (plan?.pendingApproval) {
                planPending = true;
                pausedTurnsRef.current.set(target, {
                  kind: "plan",
                  calls: [{ callId: "plan" }],
                });
                syncPausedInfo();
              } else if (plan?.pendingKind === "tool" && plan.pendingCalls?.length) {
                toolGatePending = true;
                pausedTurnsRef.current.set(target, {
                  kind: "tool",
                  calls: plan.pendingCalls.map((c) => ({
                    callId: String(c.id ?? ""),
                    ...(c.name ? { name: String(c.name) } : {}),
                  })),
                });
                syncPausedInfo();
              }
            } catch {
              // 探测失败不打扰（尽力而为；本地转写含审批 chip 时 resume
              // 仍可由后续轮次驱动）。
            }
          }
        }
        // 暂停态对账（GUI 验收二轮 D7）：本地仍停留在暂停快照（索引
        // status=paused 或转写含等待审批的工具卡）、而服务端已不在任何
        // 暂停态（工具门无悬挂 tool_calls 且计划门无 pending_approval）
        // → 后端历史无条件接管，并把索引里冻结的 paused 修正为 ended。
        // 长度比较在此失真：暂停转写含 UI 合成的审批卡等消息，完成态
        // 历史未必更长——沿用长度规则会让旁路完成（跨标签/跨设备 resume）
        // 的线程永远渲染死审批卡。仍处暂停态（工具门悬挂/计划门待批）
        // 时不接管，恢复语义不变。
        const storedLooksPaused =
          thread?.status === "paused" ||
          (stored ?? []).some((m) => m.role === "tool" && m.status === "paused");
        if (storedLooksPaused && dangling.length === 0 && !planPending && !toolGatePending) {
          setTranscript(target, remote);
          if (thread && thread.status === "paused") {
            saveThread({
              threadId: target,
              title: thread.title,
              module: thread.module,
              updatedAt: thread.updatedAt,
              messages: remote,
              status: "ended",
            });
          }
          return;
        }
        // 后端是该线程转写的权威来源，但只在"不少于本地"时覆盖：被停止
        // 的轮次后端可能只有更短的历史，不能拿旧快照抹掉用户刚看到的
        // 半截回复。强制重载（分支切换）例外——后端路径无条件接管。
        if (forced || remote.length > (stored?.length ?? 0)) {
          setTranscript(target, remote);
          return;
        }
        // 不覆盖时的树锚点对账：本地转写（含步骤徽标）回填 node_id 等
        // 元数据——刷新/切回的会话同样立刻获得树交互（ADR-013）。
        const base = stored ?? messagesRef.current;
        if (base.length === 0) return;
        const merged = mergeTreeAnchors(base, remote);
        if (merged) {
          setTranscript(target, merged);
          const current = getThread(target);
          if (current) {
            saveThread({
              threadId: target,
              title: current.title,
              module: current.module,
              updatedAt: Date.now(),
              messages: merged,
              status: current.status ?? "ended",
            });
          }
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
      // planner 模块的历史回放补渲染：拉当前计划卡（非 planner 模块 404/503
      // → null 静默跳过）。转写里已有 plan 卡（本会话流式产生的 p-{rid}）
      // 时不覆盖——流内卡比端点快照更新鲜。
      try {
        const plan = await fetchThreadPlan({
          apiUrl: finalApiUrl,
          module: mod,
          threadId: target,
        });
        if (cancelled || !plan || plan.tasks.length === 0) return;
        const cur = transcriptsRef.current.get(target);
        if (!cur || cur.some((m) => m.role === "plan")) return;
        const entry: UiMessage = {
          id: "p-history",
          role: "plan",
          status: "progress",
          tasks: plan.tasks,
          ...(plan.cursor > 0 || plan.replans > 0
            ? { detail: `cursor=${plan.cursor} · replans=${plan.replans}` }
            : {}),
        };
        setTranscript(target, [...cur, entry]);
      } catch {
        // 计划拉取失败不打扰用户（回放补渲染是尽力而为）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    threadId,
    getThreadMessages,
    getThread,
    saveThread,
    finalApiUrl,
    finalModule,
    setTranscript,
    reloadCounter,
    syncPausedInfo,
  ]);

  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: AttachmentMeta[],
      options?: SendMessageOptions,
    ): Promise<SendMessageResult> => {
      if (!finalApiUrl || !finalModule) return { ok: false, draft: text };
      if (!text.trim() && !options?.regenerate)
        return { ok: false, draft: text };

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
      const seedBase =
        transcriptsRef.current.get(turnThreadId) ??
        (activeThreadRef.current === turnThreadId
          ? messagesRef.current
          : undefined) ??
        getThreadMessages(turnThreadId) ??
        [];
      // 分岔 / 重新生成（ADR-013）：本地转写截断到挂载节点——新消息在树
      // 上不延续当前可见路径的末端。找不到锚点（本地转写缺 node_id）时
      // 保守保留全部；收尾对账会以后端权威路径覆盖。
      const regenerate = options?.regenerate === true;
      const parentNodeId = options?.parentNodeId;
      let seed = seedBase;
      if (parentNodeId) {
        const at = seed.findIndex(
          (m) => ("nodeId" in m ? m.nodeId : undefined) === parentNodeId,
        );
        if (at >= 0) seed = seed.slice(0, at + 1);
      }
      let transcript: UiMessage[] = regenerate
        ? [...seed]
        : [
            ...seed,
            {
              id: humanId,
              role: "human",
              content: text.trim(),
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            } satisfies UiMessage,
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

      // 本轮事件处理状态：工厂形态（invoke 轮与 resume 轮共用同一映射，
      // FIFO 配对/tool_call 配对语义见 createEventApplier）。
      const turnState: TurnState = {
        firstDeltaSeen: false,
        backendErrored: false,
        paused: false,
        approvalDetail: null,
      };
      const applyEvent = createEventApplier(rid, turnState, (message) => {
        if (activeThreadRef.current === turnThreadId) setError(message);
        toast.error("agent-base 返回错误", {
          description: (
            <p>
              <strong>{message}</strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      });

      const controller = new AbortController();
      abortRefs.current.set(turnThreadId, controller);
      let aborted = false;
      let failed = false;
      let gateRejected = false;
      // 重新生成（ADR-013）：收尾以远端新活跃路径整体覆盖本地——本地
      // 转写里还留着被替换出路径的旧回复，对齐合并的语义不适用。
      const usedRegenerate = regenerate;
      try {
        const events = invokeAgent({
          apiUrl: finalApiUrl,
          module: turnModule,
          message: text.trim(),
          threadId: turnThreadId,
          ...(parentNodeId ? { parentNodeNodeId: parentNodeId } : {}),
          ...(regenerate ? { regenerate: true } : {}),
          attachments: attachments?.map((a) => a.file_id),
          requestId: rid,
          signal: controller.signal,
        });
        for await (const event of events) {
          transcript = applyEvent(event, transcript);
          setTranscript(turnThreadId, transcript);
        }
      } catch (err) {
        aborted = err instanceof Error && err.name === "AbortError";
        // 门拒绝（409 忙 / 429 限流）：run 从未启动，线程的真实状态未被
        // 本轮触碰——沿用索引里的既有收尾状态，不污染为异常（GUI 验收
        // 二轮 D8：标签 B 撞 409 会把标签 A 正在对话的线程染成「对话异
        // 常」，双标签从此各自展示互相矛盾的状态点）。
        gateRejected =
          !aborted && (err as { status?: number }).status === 409 ||
          !aborted && (err as { status?: number }).status === 429;
        if (!aborted) {
          failed = !gateRejected;
          const message = friendlyRequestError(err);
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
          if (!turnState.firstDeltaSeen) {
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
        // running 徽标存活（旧实现正是在这里留下永久"运行中"）；审批
        // 暂停轮的残留 running 是「等待审批」而非中断。
        transcript = finalizeToolCards(transcript, {
          stopped: aborted,
          paused: turnState.paused,
        });
        setTranscript(turnThreadId, transcript);

        // 会话收尾状态：用户停止 = 终止；请求失败或后端报错 = 异常；
        // 审批门暂停 = 等待审批（后端持久态，刷新后可续跑）；门拒绝
        // （409/429，GUI 验收二轮 D8）= run 从未启动，沿用既有状态；
        // 其余 = 正常结束——显式区分开，供侧栏/顶栏的状态点展示。
        const finalStatus: ThreadStatus = aborted
          ? "terminated"
          : turnState.paused
            ? "paused"
            : gateRejected
              ? getThread(turnThreadId)?.status ?? "ended"
              : failed || turnState.backendErrored
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

        // 审批门暂停轮：登记待审批项（悬挂调用 id 从历史尾部解析），供
        // 审批卡与「继续执行」使用。不与后端对账——悬挂 tool_calls +
        // pending_approval 快照不适用长度对账语义。
        if (turnState.paused) {
          void registerPausedTurn(
            turnThreadId,
            turnModule,
            turnState.approvalDetail,
          );
        } else if (!aborted) {
          // 正常完成的轮次：以后端 checkpointer 为权威做一次对账，替换本地
          // 转写。这从根上治愈"本地视图与真实历史漂移"（停止/中断残留的
          // 半截内容、丢步骤等）。被用户停止的轮次不对账——后端可能没有
          // 本轮 checkpoint，对账会把用户刚看到的半截回复抹掉。
          void reconcileFromBackend(turnThreadId, turnModule, {
            force: usedRegenerate,
          });
        }
      }

      // 失败时调用方会把草稿放回输入框；停止/成功不回填。
      return { ok: !failed, draft: text };

    },
    [
      finalApiUrl,
      finalModule,
      getThreadMessages,
      getThread,
      saveThread,
      setTranscript,
      updateThreadId,
      reconcileFromBackend,
      registerPausedTurn,
    ],
  );

  // 继续执行（#8 resume）：对审批门暂停的活跃线程调 resume 端点重新开流。
  // 事件映射复用 createEventApplier 工厂（独立 rid：新卡的 id 空间不与
  // 暂停轮冲突）；上一轮的「等待审批」卡不进续跑转写——批准的调用会由
  // 新 tool_call 事件重新出卡，旧卡留着会出现同工具两张卡。
  const resumeThread = useCallback(() => {
    const id = threadIdRef.current;
    if (!id || !finalApiUrl || !finalModule) return;
    if (streamingRef.current.has(id)) return;
    const pending = pausedTurnsRef.current.get(id);
    if (!pending) return;
    const seed =
      transcriptsRef.current.get(id) ??
      (activeThreadRef.current === id ? messagesRef.current : undefined) ??
      getThreadMessages(id) ??
      [];
    streamingRef.current.add(id);
    const rid = requestId();
    let transcript: UiMessage[] = seed.filter(
      (m) => !(m.role === "tool" && m.status === "paused"),
    );
    setTranscript(id, transcript);
    setError(null);
    pausedTurnsRef.current.delete(id);
    syncPausedInfo();
    const existing = getThread(id);
    const turnModule = existing?.module ?? finalModule;
    saveThread({
      threadId: id,
      title: existing?.title ?? id,
      module: turnModule,
      updatedAt: Date.now(),
      messages: transcript,
      status: "streaming",
    });

    const turnState: TurnState = {
      firstDeltaSeen: false,
      backendErrored: false,
      paused: false,
      approvalDetail: null,
    };
    const applyEvent = createEventApplier(rid, turnState, (message) => {
      if (activeThreadRef.current === id) setError(message);
      toast.error("agent-base 返回错误", {
        description: (
          <p>
            <strong>{message}</strong>
          </p>
        ),
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    });
    const controller = new AbortController();
    abortRefs.current.set(id, controller);
    void (async () => {
      let aborted = false;
      let failed = false;
      let gateRejected = false;
      try {
        for await (const event of resumeAgent({
          apiUrl: finalApiUrl,
          module: turnModule,
          threadId: id,
          requestId: rid,
          signal: controller.signal,
        })) {
          transcript = applyEvent(event, transcript);
          setTranscript(id, transcript);
        }
      } catch (err) {
        aborted = err instanceof Error && err.name === "AbortError";
        // 门拒绝（409/429）：语义同 invoke 轮（GUI 验收二轮 D8）——run 未
        // 启动，不把线程落库状态污染为异常。
        gateRejected =
          !aborted && (err as { status?: number }).status === 409 ||
          !aborted && (err as { status?: number }).status === 429;
        if (!aborted) {
          failed = !gateRejected;
          const message = friendlyRequestError(err);
          if (activeThreadRef.current === id) setError(message);
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
        }
        // 用户主动停止（aborted）：保留已生成的部分内容，不当作错误。
      } finally {
        abortRefs.current.delete(id);
        streamingRef.current.delete(id);
        setStreamingTrigger((n) => n + 1);
        transcript = finalizeToolCards(transcript, {
          stopped: aborted,
          paused: turnState.paused,
        });
        setTranscript(id, transcript);
        const finalStatus: ThreadStatus = aborted
          ? "terminated"
          : turnState.paused
            ? "paused"
            : gateRejected
              ? getThread(id)?.status ?? "ended"
              : failed || turnState.backendErrored
                ? "error"
                : "ended";
        const t = getThread(id);
        saveThread({
          threadId: id,
          title: t?.title ?? id,
          module: turnModule,
          updatedAt: Date.now(),
          messages: transcript,
          status: finalStatus,
        });
        // 续跑若再次撞审批门（计划门 replan 修订版再暂停），登记新一轮；
        // 否则正常对账（与 invoke 轮同一语义）。
        if (turnState.paused) {
          void registerPausedTurn(id, turnModule, turnState.approvalDetail);
        } else if (!aborted) {
          void reconcileFromBackend(id, turnModule);
        }
      }
    })();
  }, [
    finalApiUrl,
    finalModule,
    getThread,
    getThreadMessages,
    reconcileFromBackend,
    registerPausedTurn,
    setTranscript,
    syncPausedInfo,
  ]);

  // 运行中插话（#7 steer）：仅活跃线程流进行中有效（与后端 404 掩蔽
  // 语义一致的前置守卫）；结果以 toast 反馈。
  const steer = useCallback(
    async (content: string): Promise<void> => {
      const id = threadIdRef.current;
      if (!id || !finalApiUrl || !finalModule) return;
      if (!streamingRef.current.has(id)) return;
      try {
        const result = await steerThreadApi({
          apiUrl: finalApiUrl,
          module: finalModule,
          threadId: id,
          content,
          kind: "user",
        });
        if (result.queued) {
          toast.success("插话已发送", {
            description: "将在运行中的下一个步骤边界注入对话",
            duration: 4000,
          });
        }
      } catch (err) {
        const message = friendlyRequestError(err);
        toast.error("插话发送失败", {
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
    },
    [finalApiUrl, finalModule],
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
    reloadThread,
    isThreadStreaming,
    pausedInfo,
    resumeThread,
    steer,
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
