"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { LoaderCircle, SendHorizontal } from "lucide-react";
import { ChatMessage } from "./ChatMessage";
import { useStreamContext } from "@/providers/Stream";

export function ChatInterface() {
  const stream = useStreamContext();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = stream.messages;
  const isLoading = stream.isLoading;
  const chatStarted = messages.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: isLoading ? "auto" : "smooth" });
    }
  }, [messages.length, isLoading]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    void stream.sendMessage(text);
    setInput("");
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
      >
        <div className="mx-auto w-full max-w-[900px] px-6 pb-6 pt-4">
          {!chatStarted && (
            <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">
                Agent 基座界面
              </h1>
              <p className="text-sm text-muted-foreground">
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

      <div className="flex-shrink-0 border-t border-border bg-background p-4">
        {stream.error && (
          <div className="mx-auto mb-3 max-w-[900px] rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {stream.error}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex w-full max-w-[900px] items-end gap-2 rounded-xl border border-input bg-background p-2 shadow-xs"
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
            className="field-sizing-content max-h-48 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Button type="button" disabled>
                <LoaderCircle className="h-4 w-4 animate-spin" />
                运行中…
              </Button>
            ) : (
              <Button type="submit" disabled={!input.trim()}>
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
