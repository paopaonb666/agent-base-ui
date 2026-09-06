// Tool step rendering for agent-base events.
//
// agent-base only streams step events (node name + status); it does NOT
// emit tool arguments/results, so the heavy ToolCalls /
// ToolResult tables are replaced by a simple status chip per step.

import { Check, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolStepStatus = "running" | "completed" | "error";

export function ToolStep({
  name,
  status,
}: {
  name: string;
  status: ToolStepStatus;
}) {
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "completed"
        ? Check
        : X;
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-2">
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
        <Icon
          className={cn(
            "size-4",
            status === "running" && "animate-spin text-amber-500",
            status === "completed" && "text-green-500",
            status === "error" && "text-rose-500",
          )}
        />
        <code className="text-sm font-medium text-gray-900">{name}</code>
        <span className="ml-auto text-xs text-gray-400">{({ running: "运行中", completed: "已完成", error: "失败" } as Record<string, string>)[status] ?? status}</span>
      </div>
    </div>
  );
}