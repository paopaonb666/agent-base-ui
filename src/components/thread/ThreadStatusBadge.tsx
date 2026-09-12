import { cn } from "@/lib/utils";
import type { ThreadStatus } from "@/providers/Thread";

// 配色沿袭 chat-agent 的 STATUS_CONFIG 惯例：运行中=蓝（带扩散动画）、
// 完成=绿、中断=琥珀、失败=红——提升到会话维度。
const STATUS_CONFIG: Record<
  ThreadStatus,
  { label: string; dot: string; ping: string; text: string }
> = {
  streaming: {
    label: "正在对话",
    dot: "bg-blue-500",
    ping: "bg-blue-400",
    text: "text-blue-600",
  },
  ended: {
    label: "对话结束",
    dot: "bg-emerald-500",
    ping: "",
    text: "text-emerald-600",
  },
  terminated: {
    label: "对话终止",
    dot: "bg-amber-500",
    ping: "",
    text: "text-amber-600",
  },
  error: {
    label: "对话异常",
    dot: "bg-red-500",
    ping: "",
    text: "text-red-600",
  },
};

/**
 * 会话状态点：实心圆点 + 可选文字标签。"正在对话"带 animate-ping 扩散圈
 * （chat-agent 运行中状态的 spinner/动画惯例在点上的等价物），其余为静态点。
 */
export function ThreadStatusBadge({
  status,
  withLabel = false,
  className,
}: {
  status: ThreadStatus;
  withLabel?: boolean;
  className?: string;
}) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5", className)}
      title={config.label}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        {status === "streaming" && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              config.ping,
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            config.dot,
          )}
        />
      </span>
      {withLabel && (
        <span
          className={cn("text-xs font-medium whitespace-nowrap", config.text)}
        >
          {config.label}
        </span>
      )}
    </span>
  );
}
