import type { RecentThread, ThreadStatus } from "@/providers/Thread";

/**
 * 会话项实际展示的状态：流进行中优先（运行时真相源是 Stream 里的
 * streaming 集合），否则取落库的收尾状态；没有收尾记录（纯云端线程、
 * 旧数据）视为"对话结束"。
 */
export function resolveThreadStatus(
  thread: Pick<RecentThread, "status"> | undefined,
  isStreaming: boolean,
): ThreadStatus {
  if (isStreaming) return "streaming";
  return thread?.status ?? "ended";
}
