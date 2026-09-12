// 工具调用卡片（M5）：参考 chat-agent 的 ToolCallBox——头行是状态 +
// 耗时，展开体是"参数键值行 + 结果文本"；成功与失败 alike 可展开。
// 事件来源：池的 _TimeoutTool 经 tool_call 流事件发出的参数/结果。

import { Check, ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type ToolStepStatus = "running" | "completed" | "error";

// 参数值渲染上限：超长的 JSON 序列化值默认截断，点击逐项展开。
const PARAM_PREVIEW_CHARS = 80;

function ParamRow({ paramKey, value }: { paramKey: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const valueStr = JSON.stringify(value) ?? "undefined";
  const isLong = valueStr.length > PARAM_PREVIEW_CHARS;
  return (
    <div className="rounded border border-slate-100 bg-white">
      <button
        className="flex w-full items-baseline gap-2 px-2 py-1 text-left"
        onClick={() => isLong && setExpanded((v) => !v)}
        type="button"
      >
        <span className="font-mono text-xs whitespace-nowrap text-slate-600">{paramKey}</span>
        <span className="min-w-0 font-mono text-xs break-all text-slate-500">
          {isLong && !expanded ? `${valueStr.slice(0, PARAM_PREVIEW_CHARS)}…` : valueStr}
        </span>
        {isLong ? (
          <span className="ml-auto text-[10px] whitespace-nowrap text-gray-400">
            {expanded ? "收起" : "展开"}
          </span>
        ) : null}
      </button>
    </div>
  );
}

export function ToolStep({
  name,
  status,
  detail,
  result,
  args,
  duration_ms: durationMs,
  error,
}: {
  name: string;
  status: ToolStepStatus;
  detail?: string;
  result?: string;
  args?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}) {
  const Icon =
    status === "running" ? LoaderCircle : status === "completed" ? Check : X;
  const [open, setOpen] = useState(status === "running");
  const hasBody = Boolean(
    (args && Object.keys(args).length > 0) || result || (error && detail !== error),
  );
  const interruptedLabel =
    status === "error" && (detail === "已停止" || detail === "已中断" || detail === "已中断（页面刷新或关闭）");

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-2">
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
        <button
          className="flex w-full items-center gap-2 text-left"
          onClick={() => hasBody && setOpen((v) => !v)}
          type="button"
        >
          {hasBody ? (
            open ? (
              <ChevronDown className="size-3.5 shrink-0 text-gray-400" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-gray-400" />
            )
          ) : null}
          <Icon
            className={cn(
              "size-4 shrink-0",
              status === "running" && "animate-spin text-amber-500",
              status === "completed" && "text-green-500",
              status === "error" && "text-rose-500",
            )}
          />
          <code className="text-sm font-medium text-gray-900">{name}</code>
          {typeof durationMs === "number" ? (
            <span className="text-xs text-gray-400">{durationMs} ms</span>
          ) : null}
          <span className="ml-auto text-xs text-gray-400">
            {interruptedLabel
              ? detail
              : (
                  {
                    running: "运行中",
                    completed: "已完成",
                    error: "失败",
                  } as Record<string, string>
                )[status] ?? status}
          </span>
        </button>
        {open && hasBody ? (
          <div className="mt-2 grid gap-2">
            {args && Object.keys(args).length > 0 ? (
              <div>
                <p className="m-0 mb-1 text-xs font-medium text-gray-500">参数</p>
                <div className="grid gap-1">
                  {Object.entries(args).map(([paramKey, value]) => (
                    <ParamRow key={paramKey} paramKey={paramKey} value={value} />
                  ))}
                </div>
              </div>
            ) : null}
            {result ? (
              <div>
                <p className="m-0 mb-1 text-xs font-medium text-gray-500">结果</p>
                <pre className="max-h-60 overflow-auto rounded border border-slate-100 bg-white px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-slate-700">
                  {result}
                </pre>
              </div>
            ) : null}
            {error && !interruptedLabel ? (
              <div>
                <p className="m-0 mb-1 text-xs font-medium text-rose-500">错误</p>
                <pre className="max-h-40 overflow-auto rounded border border-rose-100 bg-rose-50 px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap text-rose-600">
                  {error}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
        {!open && (detail || error) ? (
          <p
            className={cn(
              "mt-1 truncate text-xs",
              status === "error" && !interruptedLabel ? "text-rose-500" : "text-gray-500",
            )}
            title={status === "error" && !interruptedLabel ? error : detail}
          >
            {status === "error" && !interruptedLabel ? error : detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
