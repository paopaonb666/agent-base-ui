"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { CircleStop, FileText, Paperclip, SendHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { ChatMessage } from "./ChatMessage";
import { uploadDocument, type UploadedFile } from "@/providers/agentBaseClient";
import { useStreamContext } from "@/providers/Stream";

const ATTACHMENT_ACCEPT = ".pdf,.docx,.txt,.md,.markdown";

// 上传进行中的条目：chip 显示进度条，完成后转为正式附件。
interface PendingUpload {
  key: string;
  filename: string;
  progress: number;
}

export function ChatInterface() {
  const stream = useStreamContext();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const uploading = pending.length > 0;
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 发送后立即清空；若这一轮在收到任何回复前失败，把草稿放回来，
  // 避免用户的长文本凭空丢失（只能改小重发）。
  const draftRef = useRef("");

  const messages = stream.messages;
  const isLoading = stream.isLoading;
  const chatStarted = messages.length > 0;

  // 贴底跟随：流式内容增长时视图跟着滚，用户向上翻阅即暂停跟随，
  // 滚回底部自动恢复。没有这个，长回复会在视口外"盲长"。
  const stickRef = useRef(true);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // 切换会话视为重新贴底（新会话从最新消息看起）。
  useEffect(() => {
    stickRef.current = true;
  }, [stream.threadId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: isLoading ? "auto" : "smooth",
      });
    }
    // messages 身份在每次 delta 追加后都会变化：内容增长本身就是滚动信号。
  }, [messages, isLoading]);

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || uploading) return;
    for (const file of Array.from(files)) {
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setPending((prev) => [...prev, { key, filename: file.name, progress: 0 }]);
      try {
        const uploaded = await uploadDocument({
          apiUrl: stream.apiUrl,
          module: stream.module,
          file,
          onProgress: (percent) =>
            setPending((prev) =>
              prev.map((p) => (p.key === key ? { ...p, progress: percent } : p)),
            ),
        });
        setAttachments((prev) => [...prev, uploaded]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`上传 ${file.name} 失败`, {
          description: <p className="max-w-80 break-all">{message}</p>,
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      } finally {
        setPending((prev) => prev.filter((p) => p.key !== key));
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (isLoading) return;
    void handleFiles(e.dataTransfer?.files ?? null);
  };

  const removeAttachment = (fileId: string) => {
    setAttachments((prev) => prev.filter((a) => a.file_id !== fileId));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || isLoading || pending.length > 0) return;
    const attachmentMeta = attachments.map((a) => ({
      file_id: a.file_id,
      filename: a.filename,
      format: a.format,
      pages: a.pages,
      text_len: a.text_len,
    }));
    const composed =
      text || (attachments.length > 0 ? "请阅读上面的附件内容。" : "");
    draftRef.current = text;
    setInput("");
    setAttachments([]);
    void stream.sendMessage(composed, attachmentMeta).then((result) => {
      if (!result.ok && !stream.isLoading) {
        // 发送失败：恢复草稿与附件（若期间用户已输入新内容则不覆盖）。
        setInput((prev) => (prev ? prev : (result.draft ?? draftRef.current)));
        setAttachments((prev) => (prev.length > 0 ? prev : attachmentMeta.map((m) => ({
          ...m,
          paragraphs: null,
          truncated: false,
          warning: null,
        }))));
      }
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-[900px] px-6 pt-4 pb-6">
          {!chatStarted && (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">
                Agent 基座界面
              </h1>
              <p className="text-muted-foreground text-sm">
                输入消息开始与 agent-base 对话
              </p>
            </div>
          )}
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => (
              <ChatMessage
                key={m.id || `${m.role}-${i}`}
                message={m}
                isStreaming={isLoading && i === messages.length - 1}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="border-border bg-background flex-shrink-0 border-t p-4">
        {stream.error && (
          <div className="mx-auto mb-3 max-w-[900px] rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {stream.error}
          </div>
        )}
        {(attachments.length > 0 || pending.length > 0) && (
          <div className="mx-auto mb-2 flex max-w-[900px] flex-wrap gap-2">
            {pending.map((p) => (
              <span
                className="border-border bg-muted flex w-64 flex-col gap-1 rounded-lg border px-2 py-1 text-xs"
                key={p.key}
              >
                <span className="flex items-center gap-1.5">
                  <FileText className="size-3.5 text-blue-400" />
                  <span className="max-w-40 truncate font-medium">{p.filename}</span>
                  <span className="text-muted-foreground">{p.progress}%</span>
                </span>
                <span className="bg-border h-1 w-full overflow-hidden rounded-full">
                  <span
                    className="bg-blue-500 block h-full transition-all"
                    style={{ width: `${p.progress}%` }}
                  />
                </span>
              </span>
            ))}
            {attachments.map((a) => (
              <span
                className="border-border bg-muted flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs"
                key={a.file_id}
              >
                <FileText className="size-3.5 text-blue-500" />
                <span className="max-w-40 truncate font-medium">{a.filename}</span>
                <span className="text-muted-foreground">
                  {a.format}
                  {a.pages ? ` · ${a.pages} 页` : ""} · {a.text_len} 字符
                </span>
                {a.warning ? (
                  <span className="text-amber-600" title={a.warning}>
                    ⚠
                  </span>
                ) : null}
                <button
                  aria-label={`移除附件 ${a.filename}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => removeAttachment(a.file_id)}
                  type="button"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragActive(false);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDrop={handleDrop}
          className={`border-input bg-background mx-auto flex w-full max-w-[900px] items-end gap-2 rounded-xl border p-2 shadow-xs ${
            dragActive ? "border-blue-500 bg-blue-50/40" : ""
          }`}
        >
          <input
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
            ref={fileInputRef}
            type="file"
          />
          <Button
            aria-label="上传附件"
            className="shrink-0"
            disabled={uploading || isLoading}
            onClick={() => fileInputRef.current?.click()}
            size="icon"
            title="上传或拖拽文档（PDF / DOCX / TXT / Markdown）"
            type="button"
            variant="ghost"
          >
            <Paperclip className={uploading ? "size-4 animate-pulse" : "size-4"} />
          </Button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                const form = (e.target as HTMLElement).closest("form");
                form?.requestSubmit();
              }
            }}
            placeholder={
              dragActive
                ? "松开即可添加附件…"
                : isLoading
                  ? "运行中…"
                  : "输入您的消息，或拖入 PDF / DOCX / TXT / MD"
            }
            rows={1}
            className="placeholder:text-muted-foreground field-sizing-content max-h-48 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none"
          />
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Button
                type="button"
                variant="destructive"
                onClick={stream.stop}
              >
                <CircleStop className="h-4 w-4" />
                停止
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || pending.length > 0}
              >
                <SendHorizontal className="h-4 w-4" />
                发送
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
