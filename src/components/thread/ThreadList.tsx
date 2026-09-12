"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Cloud, Loader2, MessageSquare, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useThreads, type RecentThread } from "@/providers/Thread";
import { deleteThread, listThreads } from "@/providers/agentBaseClient";
import { useStreamContext } from "@/providers/Stream";
import { resolveThreadStatus } from "@/lib/thread-status";
import { ThreadStatusBadge } from "./ThreadStatusBadge";
import { toast } from "sonner";

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
  const stream = useStreamContext();
  const [remoteThreads, setRemoteThreads] = useState<RecentThread[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [remoteVersion, setRemoteVersion] = useState(0);

  // 云端线程：checkpointer 里该模块命名空间下已持久化的会话。本地索引
  // 只覆盖"在这台浏览器上聊过"的线程；同一 threadId 本地优先。
  const refreshRemote = useCallback(
    (signal: { cancelled: boolean }) => {
      if (!stream.apiUrl || !stream.module) return;
      setRemoteLoading(true);
      listThreads({ apiUrl: stream.apiUrl, module: stream.module })
        .then((items) => {
          if (signal.cancelled) return;
          setRemoteThreads(
            items.map((it) => ({
              threadId: it.thread_id,
              title: it.title,
              module: it.module,
              updatedAt: it.updated_at,
              remote: true,
            })),
          );
        })
        .catch(() => {
          // 后端不可达 / 端点缺失：侧栏退化为只显示本地索引。
          if (!signal.cancelled) setRemoteThreads([]);
        })
        .finally(() => {
          if (!signal.cancelled) setRemoteLoading(false);
        });
    },
    [stream.apiUrl, stream.module],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    refreshRemote(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [refreshRemote, remoteVersion]);

  const merged = useMemo(() => {
    const seen = new Set(threads.map((t) => t.threadId));
    return [...threads, ...remoteThreads.filter((r) => !seen.has(r.threadId))];
  }, [threads, remoteThreads]);

  const grouped = useMemo(() => {
    const now = new Date();
    const groups: Record<keyof typeof GROUP_LABELS, RecentThread[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };

    merged.forEach((thread) => {
      const diff = now.getTime() - thread.updatedAt;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      if (days === 0) groups.today.push(thread);
      else if (days === 1) groups.yesterday.push(thread);
      else if (days < 7) groups.week.push(thread);
      else groups.older.push(thread);
    });

    return groups;
  }, [merged]);

  const handleDelete = (thread: RecentThread) => {
    if (!window.confirm("确定要删除这条对话吗？此操作无法撤销。")) return;
    setDeletingId(thread.threadId);
    // 同步删除后端 checkpointer 里的线程：只删本地索引的话，清缓存/
    // 换设备后会"复活"。后端失败不阻塞本地删除（离线也要能整理列表），
    // 但要给出可见的提示；成功后刷新云端列表，避免侧栏残留旧条目。
    removeThread(thread.threadId);
    deleteThread({
      apiUrl: stream.apiUrl,
      module: thread.module,
      threadId: thread.threadId,
    })
      .then(() => setRemoteVersion((v) => v + 1))
      .catch(() => {
        toast.error("云端会话删除失败", {
          description: "本地已移除，但服务端仍保留这条对话（清缓存后会重新出现）。",
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      })
      .finally(() => setDeletingId(null));
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-border flex flex-shrink-0 items-center justify-between gap-3 border-b p-4">
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
        {threadsLoading || (remoteLoading && merged.length === 0) ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-16 w-full"
              />
            ))}
          </div>
        ) : merged.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <MessageSquare className="mb-2 h-12 w-12 text-gray-300" />
            <p className="text-muted-foreground text-sm">暂无对话</p>
          </div>
        ) : (
          <div className="box-border w-full p-2">
            {(
              Object.keys(GROUP_LABELS) as Array<keyof typeof GROUP_LABELS>
            ).map((group) => {
              const groupThreads = grouped[group];
              if (groupThreads.length === 0) return null;

              return (
                <div
                  key={group}
                  className="mb-4"
                >
                  <h4 className="text-muted-foreground m-0 px-3 py-2 text-xs font-semibold tracking-wide uppercase">
                    {GROUP_LABELS[group]}
                  </h4>
                  <div className="flex flex-col gap-1">
                    {groupThreads.map((thread) => (
                      <div
                        key={thread.threadId}
                        className="group flex w-full items-center gap-1"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            onSelect({
                              threadId: thread.threadId,
                              module: thread.module,
                            })
                          }
                          className={cn(
                            "hover:bg-accent grid min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors duration-200",
                            activeThreadId === thread.threadId
                              ? "border-primary bg-accent hover:bg-accent border"
                              : "border border-transparent bg-transparent",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="mb-1 flex items-center justify-between">
                              <h3 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold">
                                <span className="truncate">
                                  {thread.title || thread.threadId}
                                </span>
                                {thread.remote && (
                                  <Cloud className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
                                )}
                              </h3>
                              <span className="text-muted-foreground ml-2 flex-shrink-0 text-xs">
                                {formatTime(new Date(thread.updatedAt))}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground flex-1 truncate text-xs">
                                {thread.module}
                              </span>
                              <ThreadStatusBadge
                                status={resolveThreadStatus(
                                  thread,
                                  stream.isThreadStreaming(thread.threadId),
                                )}
                                withLabel
                              />
                            </div>
                          </div>
                        </button>
                        {/* 本地与纯云端线程都可删除：只允许删本地会让
                            换浏览器/清缓存后的云端会话变成不可管理。 */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleDelete(thread);
                          }}
                          disabled={deletingId === thread.threadId}
                          title="删除对话"
                        >
                        {deletingId === thread.threadId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="text-muted-foreground hover:text-destructive h-3.5 w-3.5" />
                        )}
                      </Button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
