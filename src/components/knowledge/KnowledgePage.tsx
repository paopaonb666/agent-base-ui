"use client";

// 独立知识库页面（M8）：文档知识库 / 长期记忆 / 用户画像 三页签。
// 数据全部来自 agent-base 的用户级端点（X-User-Id 作用域）；apiUrl 与
// module 经 StreamProvider 从 localStorage 恢复，与聊天页配置一致。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Brain,
  FileText,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Upload,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FilePreviewDialog, type PreviewTarget } from "@/components/thread/FilePreviewDialog";
import { useStreamContext } from "@/providers/Stream";
import {
  deleteMemory,
  fetchMemories,
  updateMemoryStatus,
  fetchProfile,
  listKnowledgeFiles,
  revokeFile,
  uploadDocument,
  type KnowledgeFile,
  type MemoryItem,
  type MemoryKind,
  type UserProfile,
} from "@/providers/agentBaseClient";

type TabKey = "files" | "memories" | "profile";

const KIND_LABELS: Record<MemoryKind, string> = {
  semantic: "语义",
  episodic: "情节",
  procedural: "程序",
};

function formatTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

export function KnowledgePage() {
  const stream = useStreamContext();
  const [tab, setTab] = useState<TabKey>("files");
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memKind, setMemKind] = useState<MemoryKind | "">("");
  const [memStatus, setMemStatus] = useState<"active" | "archived" | "superseded" | "">("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewTarget | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalChunks = files.reduce((sum, f) => sum + f.chunks, 0);

  const loadFiles = useCallback(
    async (signal?: AbortSignal) => {
      const list = await listKnowledgeFiles({ apiUrl: stream.apiUrl, signal });
      setFiles(list);
    },
    [stream.apiUrl],
  );

  const loadMemories = useCallback(
    async (signal?: AbortSignal) => {
      const list = await fetchMemories({
        apiUrl: stream.apiUrl,
        query: memQuery.trim() || undefined,
        kind: memKind || undefined,
        status: memStatus || undefined,
        limit: 100,
        signal,
      });
      setMemories(list);
    },
    [stream.apiUrl, memQuery, memKind, memStatus],
  );

  const loadProfile = useCallback(
    async (signal?: AbortSignal) => {
      setProfile(await fetchProfile({ apiUrl: stream.apiUrl, signal }));
    },
    [stream.apiUrl],
  );

  // 页签首次进入 / 手动刷新时拉数据。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const job =
      tab === "files"
        ? loadFiles(controller.signal)
        : tab === "memories"
          ? loadMemories(controller.signal)
          : loadProfile(controller.signal);
    void job
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        toast.error("加载数据失败", {
          description: <p className="max-w-80 break-all">{message}</p>,
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tab, loadFiles, loadMemories, loadProfile]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || uploading) return;
    for (const file of Array.from(files)) {
      setUploading(true);
      try {
        await uploadDocument({ apiUrl: stream.apiUrl, module: stream.module, file });
        toast.success(`已上传 ${file.name}`, { richColors: true });
        await loadFiles();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`上传 ${file.name} 失败`, {
          description: <p className="max-w-80 break-all">{message}</p>,
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      } finally {
        setUploading(false);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRevoke = async (target: KnowledgeFile) => {
    if (!window.confirm(`确认撤销「${target.filename}」？其全部切片将从知识库删除。`)) return;
    try {
      await revokeFile({
        apiUrl: stream.apiUrl,
        module: stream.module,
        fileId: target.file_id,
      });
      toast.success(`已撤销 ${target.filename}`, { richColors: true });
      await loadFiles();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("撤销失败", {
        description: <p className="max-w-80 break-all">{message}</p>,
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    }
  };

  const handleToggleMemoryStatus = async (target: MemoryItem) => {
    const next = target.status === "active" ? "archived" : "active";
    try {
      await updateMemoryStatus({
        apiUrl: stream.apiUrl,
        memoryId: target.memory_id,
        status: next,
      });
      if (next === "active") {
        // 重新启用会刷新 updated_at，TTL 窗口随之重置——过期标志消失。
        await loadMemories();
      } else {
        setMemories((prev) =>
          prev.map((m) => (m.memory_id === target.memory_id ? { ...m, status: next } : m)),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(next === "archived" ? "停用记忆失败" : "启用记忆失败", {
        description: <p className="max-w-80 break-all">{message}</p>,
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    }
  };

  const handleDeleteMemory = async (target: MemoryItem) => {
    try {
      await deleteMemory({ apiUrl: stream.apiUrl, memoryId: target.memory_id });
      setMemories((prev) => prev.filter((m) => m.memory_id !== target.memory_id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("删除记忆失败", {
        description: <p className="max-w-80 break-all">{message}</p>,
        duration: 8000,
        richColors: true,
        closeButton: true,
      });
    }
  };

  const tabs: { key: TabKey; label: string; icon: typeof BookOpen }[] = [
    { key: "files", label: "文档知识库", icon: BookOpen },
    { key: "memories", label: "长期记忆", icon: Brain },
    { key: "profile", label: "用户画像", icon: UserRound },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 顶栏：返回对话 + 标题 + 刷新 */}
      <header className="border-border flex h-16 flex-shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost">
            <Link href="/">
              <ArrowLeft className="size-4" />
              返回对话
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">知识库</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={loading || uploading}
            onClick={() => {
              const controller = new AbortController();
              setLoading(true);
              const job =
                tab === "files"
                  ? loadFiles(controller.signal)
                  : tab === "memories"
                    ? loadMemories(controller.signal)
                    : loadProfile(controller.signal);
              void job.finally(() => setLoading(false));
            }}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </header>

      {/* 统计行 */}
      <div className="text-muted-foreground flex flex-shrink-0 gap-6 px-6 py-3 text-xs">
        <span>文件 {files.length}</span>
        <span>切片 {totalChunks}</span>
        {tab === "memories" || memories.length > 0 ? (
          <span>记忆 {memories.length}</span>
        ) : null}
      </div>

      {/* 页签 */}
      <div className="border-border flex flex-shrink-0 gap-1 border-b px-6 pb-2">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
              tab === key
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            }`}
            key={key}
            onClick={() => setTab(key)}
            type="button"
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <main className="mx-auto w-full max-w-[900px] flex-1 px-6 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            {tab === "files" ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <input
                    accept=".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.gif"
                    className="hidden"
                    multiple
                    onChange={(e) => void handleUpload(e.target.files)}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Button
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    size="sm"
                  >
                    <Upload className="size-4" />
                    {uploading ? "上传中…" : "上传文档"}
                  </Button>
                  <p className="text-muted-foreground text-xs">
                    上传后自动解析、切块并入库；在对话里也可直接引用。
                  </p>
                </div>
                {files.length === 0 ? (
                  <p className="text-muted-foreground py-10 text-center text-sm">
                    知识库还是空的——上传第一份文档，或在对话里上传附件。
                  </p>
                ) : (
                  files.map((f) => (
                    <div
                      className="border-border flex items-center gap-3 rounded-lg border p-3"
                      key={f.file_id}
                    >
                      <FileText className="size-5 shrink-0 text-blue-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{f.filename}</p>
                        <p className="text-muted-foreground text-xs">
                          {f.format}
                          {f.pages ? ` · ${f.pages} 页` : ""} · {f.text_len} 字符 · {f.chunks}{" "}
                          切片 · {formatTime(f.created_at)}
                          {f.truncated ? " · 已截断" : ""}
                        </p>
                        {f.warning ? (
                          <p className="mt-0.5 text-xs text-amber-600">{f.warning}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          onClick={() =>
                            setPreviewFile({
                              file_id: f.file_id,
                              filename: f.filename,
                              format: f.format,
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          查看切片
                        </Button>
                        <Button
                          aria-label={`撤销 ${f.filename}`}
                          onClick={() => void handleRevoke(f)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="size-4 text-rose-500" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {tab === "memories" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="border-input flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5">
                    <Search className="text-muted-foreground size-3.5" />
                    <input
                      className="w-56 bg-transparent text-sm outline-none"
                      onChange={(e) => setMemQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void loadMemories();
                      }}
                      placeholder="混合检索（语义 + 关键词）"
                      value={memQuery}
                    />
                  </div>
                  <select
                    className="border-input bg-background rounded-lg border px-2 py-1.5 text-sm"
                    onChange={(e) => setMemKind(e.target.value as MemoryKind | "")}
                    value={memKind}
                  >
                    <option value="">全部类型</option>
                    <option value="semantic">语义</option>
                    <option value="episodic">情节</option>
                    <option value="procedural">程序</option>
                  </select>
                  <select
                    className="border-input bg-background rounded-lg border px-2 py-1.5 text-sm"
                    onChange={(e) =>
                      setMemStatus(
                        e.target.value as "active" | "archived" | "superseded" | "",
                      )
                    }
                    value={memStatus}
                  >
                    <option value="">全部状态</option>
                    <option value="active">启用中</option>
                    <option value="archived">已归档</option>
                    <option value="superseded">已废弃</option>
                  </select>
                  <Button
                    onClick={() => void loadMemories()}
                    size="sm"
                    variant="outline"
                  >
                    查询
                  </Button>
                </div>
                {memories.length === 0 ? (
                  <p className="text-muted-foreground py-10 text-center text-sm">
                    没有匹配的长期记忆——它们随对话由后台管线自动形成，或在对话里让 agent
                    调用 memory_save；可调整类型/状态筛选查看已归档与已废弃的记忆。
                  </p>
                ) : (
                  memories.map((m) => (
                    <div
                      className="border-border flex items-start gap-3 rounded-lg border p-3"
                      key={m.memory_id}
                    >
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                          m.kind === "semantic"
                            ? "bg-blue-100 text-blue-700"
                            : m.kind === "episodic"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {KIND_LABELS[m.kind] ?? m.kind}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-relaxed break-words">{m.content}</p>
                        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          {m.status === "active" ? (
                            m.expired ? (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">
                                已过期（不再召回）
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">
                                启用中
                              </span>
                            )
                          ) : (
                            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-medium">
                              {m.status === "archived" ? "已归档" : "已废弃"}
                            </span>
                          )}
                          <span>创建 {formatTime(m.created_at)}</span>
                          <span>更新 {formatTime(m.updated_at)}</span>
                          <span>
                            显著度 {m.salience.toFixed(1)} · 被召回 {m.access_count} 次
                          </span>
                          {m.tags.length > 0 ? <span>{m.tags.join("、")}</span> : null}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          aria-label={m.status === "active" ? "停用记忆" : "重新启用记忆"}
                          onClick={() => void handleToggleMemoryStatus(m)}
                          size="icon"
                          title={
                            m.status === "active"
                              ? "停用（保留但不注入召回，可随时恢复）"
                              : "重新启用（进入召回，TTL 窗口重置）"
                          }
                          variant="ghost"
                        >
                          {m.status === "active" ? (
                            <Archive className="text-muted-foreground size-4" />
                          ) : (
                            <Undo2 className="size-4 text-emerald-600" />
                          )}
                        </Button>
                        <Button
                          aria-label="删除记忆"
                          onClick={() => void handleDeleteMemory(m)}
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2 className="text-rose-500 size-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {tab === "profile" ? (
              profile ? (
                <div className="flex flex-col gap-3">
                  {Object.entries(profile).map(([section, entries]) => (
                    <div className="border-border rounded-lg border p-3" key={section}>
                      <p className="mb-1.5 text-sm font-medium">{section}</p>
                      {entries.length > 0 ? (
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                          {entries.map((entry, i) => (
                            <li className="text-sm leading-relaxed" key={`${section}-${i}`}>
                              <span className="text-muted-foreground mr-1.5">·</span>
                              {entry}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground text-xs">（暂无条目）</p>
                      )}
                    </div>
                  ))}
                  <p className="text-muted-foreground text-xs">
                    画像由后台管线随对话自动合并演化（新事实为准），无需手工维护。
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground py-10 text-center text-sm">
                  还没有用户画像——与 agent 多聊几轮（涉及偏好、背景、目标的话题），
                  后台管线会自动建立并持续合并画像。
                </p>
              )
            ) : null}
          </>
        )}
      </main>

      {previewFile ? (
        <FilePreviewDialog
          file={previewFile}
          onOpenChange={(o) => {
            if (!o) setPreviewFile(null);
          }}
          open
        />
      ) : null}
    </div>
  );
}
