"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { CircleStop, SendHorizontal } from "lucide-react";
import { ChatMessage } from "./ChatMessage";
import { useStreamContext } from "@/providers/Stream";

export function ChatInterface() {
  const stream = useStreamContext();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // 发送后立即清空；若这一轮在收到任何回复前失败，把草稿放回来，
  // 避免用户的长文本凭空丢失（只能改小重发）。
  const draftRef = useRef("");

  const messages = stream.messages;
  const isLoading = stream.isLoading;
  const chatStarted = messages.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: isLoading ? "auto" : "smooth",
      });
    }
  }, [messages.length, isLoading]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    draftRef.current = text;
    setInput("");
    void stream.sendMessage(text).then((result) => {
      if (!result.ok && !stream.isLoading) {
        // 发送失败：恢复草稿（若期间用户已输入新内容则不覆盖）。
        setInput((prev) => (prev ? prev : (result.draft ?? draftRef.current)));
      }
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
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
        <form
          onSubmit={handleSubmit}
          className="border-input bg-background mx-auto flex w-full max-w-[900px] items-end gap-2 rounded-xl border p-2 shadow-xs"
        >
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
            placeholder={isLoading ? "运行中…" : "输入您的消息…"}
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
                disabled={!input.trim()}
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
