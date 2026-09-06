"use client";

import { memo } from "react";
import { UiMessage } from "@/providers/Stream";
import { MarkdownText } from "./markdown-text";
import { ToolStep } from "./messages/tool-calls";

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
}: {
  message: UiMessage;
  isStreaming?: boolean;
}) {
  if (message.role === "tool") {
    return <ToolStep name={message.name} status={message.status} />;
  }

  if (message.role === "human") {
    return (
      <div className="flex w-full justify-end">
        <div
          className="max-w-[70%] overflow-hidden break-words rounded-2xl rounded-br-sm border border-border px-3 py-2 text-sm leading-relaxed text-foreground"
          style={{ backgroundColor: "var(--color-user-message-bg)" }}
        >
          <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start">
      <div className="min-w-0 max-w-full">
        {message.content ? (
          <MarkdownText>{message.content}</MarkdownText>
        ) : isStreaming ? (
          <div className="flex items-center gap-1 py-2">
            <span className="size-1.5 animate-pulse rounded-full bg-foreground/50" />
            <span className="size-1.5 animate-pulse rounded-full bg-foreground/50 [animation-delay:150ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-foreground/50 [animation-delay:300ms]" />
          </div>
        ) : null}
      </div>
    </div>
  );
});
