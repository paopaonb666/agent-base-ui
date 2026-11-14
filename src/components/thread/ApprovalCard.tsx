"use client";

// 审批卡（Java wire 扩展 #26 工具门 / #62 计划门）：done(termination=paused)
// 后端快照挂着 pending_approval——这里列出待决定项（工具调用的 id/名称/
// 参数摘要，或计划审批的保留键 plan），逐项或一键落决定，随后 resume 续跑。
// 决定落账走 postApproval（404=暂停态已消失/非属主——以错误 toast 透出）。

import { useState } from "react";
import { Check, CircleAlert, ClipboardList, X } from "lucide-react";
import { toast } from "sonner";
import { postApproval } from "@/providers/agentBaseClient";
import type { PendingApprovalCall } from "@/providers/Stream";

export function ApprovalCard({
  threadId,
  kind,
  detail,
  calls,
  apiUrl,
  module,
  onResume,
}: {
  threadId: string;
  kind: "tool" | "plan";
  detail?: string;
  calls: PendingApprovalCall[];
  apiUrl: string;
  module: string;
  onResume: () => void;
}) {
  // 已落决定的调用（per call_id）；kind=plan 只有一个保留键。
  const [decided, setDecided] = useState<Record<string, "approve" | "reject">>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);
  const pendingCalls = calls.filter((c) => !decided[c.callId]);

  const decide = async (callId: string, decision: "approve" | "reject") => {
    setSubmitting(true);
    try {
      await postApproval({ apiUrl, module, threadId, callId, decision });
      const next = { ...decided, [callId]: decision };
      setDecided(next);
      const remaining = calls.filter((c) => !next[c.callId]);
      if (remaining.length === 0) {
        // 全部决定已落账：恢复续跑（resume 从 pending_approval.resume_node
        // 空输入重入图，事件流复用会话管线）。
        onResume();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("审批决定提交失败", {
        description: <p className="max-w-80 break-all">{message}</p>,
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const decideAll = async (decision: "approve" | "reject") => {
    setSubmitting(true);
    try {
      for (const call of pendingCalls) {
        await postApproval({
          apiUrl,
          module,
          threadId,
          callId: call.callId,
          decision,
        });
      }
      onResume();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("审批决定提交失败", {
        description: <p className="max-w-80 break-all">{message}</p>,
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const argSummary = (args?: Record<string, unknown>): string | null => {
    if (!args || Object.keys(args).length === 0) return null;
    const text = JSON.stringify(args);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  };

  return (
    <div className="mx-auto mb-3 max-w-[900px] rounded-lg border border-violet-200 bg-violet-50/60 px-4 py-3 dark:border-violet-900 dark:bg-violet-950/40">
      <p className="m-0 flex items-center gap-2 text-sm font-medium text-violet-700 dark:text-violet-300">
        <ClipboardList className="size-4 shrink-0" aria-hidden />
        {kind === "plan"
          ? "计划等待审批：批准后开始执行子任务，拒绝将触发重规划"
          : "工具调用等待审批：批准后执行，拒绝将把拒绝原因回喂给模型"}
      </p>
      {calls.length > 0 ? (
        <ul className="m-0 mt-2 list-none flex-col gap-1.5 p-0">
          {calls.map((call) => {
            const chosen = decided[call.callId];
            const summary = argSummary(call.args);
            return (
              <li
                className="flex flex-wrap items-center gap-2 rounded-md border border-violet-200 bg-background px-2 py-1.5 text-xs dark:border-violet-900"
                key={call.callId}
              >
                <code className="font-medium text-gray-900 dark:text-gray-100">
                  {call.name ?? call.callId}
                </code>
                {summary ? (
                  <span
                    className="text-muted-foreground min-w-0 flex-1 truncate font-mono"
                    title={summary}
                  >
                    {summary}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                {chosen ? (
                  <span
                    className={
                      chosen === "approve"
                        ? "text-xs font-medium text-green-600"
                        : "text-xs font-medium text-rose-600"
                    }
                  >
                    {chosen === "approve" ? "已批准" : "已拒绝"}
                  </span>
                ) : (
                  <>
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={submitting}
                      onClick={() => void decide(call.callId, "approve")}
                      type="button"
                    >
                      <Check className="size-3" aria-hidden />
                      批准
                    </button>
                    <button
                      className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={submitting}
                      onClick={() => void decide(call.callId, "reject")}
                      type="button"
                    >
                      <X className="size-3" aria-hidden />
                      拒绝
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 mt-2 text-xs text-violet-700 dark:text-violet-300">
          {detail ? `后端标记：${detail}（待审批项明细不可用）` : "待审批项明细不可用（历史拉取失败）——可直接继续或刷新页面重试。"}
        </p>
      )}
      {pendingCalls.length > 1 ? (
        <div className="mt-2 flex gap-2">
          <button
            className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting}
            onClick={() => void decideAll("approve")}
            type="button"
          >
            <Check className="size-3" aria-hidden />
            全部批准并继续
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-md border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-900"
            disabled={submitting}
            onClick={() => void decideAll("reject")}
            type="button"
          >
            <CircleAlert className="size-3" aria-hidden />
            全部拒绝并继续
          </button>
        </div>
      ) : null}
    </div>
  );
}
