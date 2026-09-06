"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Loader2, MessageSquare, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useThreads, type RecentThread } from "@/providers/Thread";

const GROUP_LABELS = {
  today: "今天",
  yesterday: "昨天",
  week: "本周",
  older: "更早",
} as const;

function formatTime(date: Date, now = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return format(date, "HH:mm");
  if (days === 1) return "昨天";
  if (days < 7) return format(date, "EEEE");
  return format(date, "MM/dd");
}

interface ThreadListProps {
  onSelect: (t: { threadId: string; module: string }) => void;
  onClose?: () => void;
  activeThreadId?: string | null;
}

export function ThreadList({
  onSelect,
  onClose,
  activeThreadId,
}: ThreadListProps) {
  const { threads, removeThread, threadsLoading } = useThreads();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const now = new Date();
    const groups: Record<keyof typeof GROUP_LABELS, RecentThread[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };

    threads.forEach((thread) => {
      const diff = now.getTime() - thread.updatedAt;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      if (days === 0) groups.today.push(thread);
      else if (days === 1) groups.yesterday.push(thread);
      else if (days < 7) groups.week.push(thread);
      else groups.older.push(thread);
    });

    return groups;
  }, [threads]);

  const handleDelete = (threadId: string) => {
    if (!window.confirm("确定要删除这条对话吗？此操作无法撤销。")) return;
    setDeletingId(threadId);
    removeThread(threadId);
    setDeletingId(null);
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border p-4">
        <h2 className="text-lg font-semibold tracking-tight">对话列表</h2>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="关闭对话列表"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-track]:bg-transparent">
        {threadsLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <MessageSquare className="mb-2 h-12 w-12 text-gray-300" />
            <p className="text-sm text-muted-foreground">暂无对话</p>
          </div>
        ) : (
          <div className="box-border w-full p-2">
            {(Object.keys(GROUP_LABELS) as Array<keyof typeof GROUP_LABELS>).map(
              (group) => {
                const groupThreads = grouped[group];
                if (groupThreads.length === 0) return null;

                return (
                  <div key={group} className="mb-4">
                    <h4 className="m-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {GROUP_LABELS[group]}
                    </h4>
                    <div className="flex flex-col gap-1">
                      {groupThreads.map((thread) => (
                        <div key={thread.threadId} className="group flex w-full items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              onSelect({
                                threadId: thread.threadId,
                                module: thread.module,
                              })
                            }
                            className={cn(
                              "grid min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors duration-200 hover:bg-accent",
                              activeThreadId === thread.threadId
                                ? "border border-primary bg-accent hover:bg-accent"
                                : "border border-transparent bg-transparent",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="mb-1 flex items-center justify-between">
                                <h3 className="truncate text-sm font-semibold">
                                  {thread.title || thread.threadId}
                                </h3>
                                <span className="ml-2 flex-shrink-0 text-xs text-muted-foreground">
                                  {formatTime(new Date(thread.updatedAt))}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="flex-1 truncate text-xs text-muted-foreground">
                                  {thread.module}
                                </span>
                              </div>
                            </div>
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDelete(thread.threadId);
                            }}
                            disabled={deletingId === thread.threadId}
                            title="删除对话"
                          >
                            {deletingId === thread.threadId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                            )}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        )}
      </div>
    </div>
  );
}
