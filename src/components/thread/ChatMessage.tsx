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
    return (
      <ToolStep
        name={message.name}
        status={message.status}
        detail={message.detail}
      />
    );
  }

  if (message.role === "human") {
    return (
      <div className="flex w-full justify-end">
        <div
          className="border-border text-foreground max-w-[70%] overflow-hidden rounded-2xl rounded-br-sm border px-3 py-2 text-sm leading-relaxed break-words"
          style={{ backgroundColor: "var(--color-user-message-bg)" }}
        >
          <p className="m-0 break-words whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-full min-w-0">
        {message.content ? (
          <MarkdownText>{message.content}</MarkdownText>
        ) : isStreaming ? (
          <div className="flex items-center gap-1 py-2">
            <span className="bg-foreground/50 size-1.5 animate-pulse rounded-full" />
            <span className="bg-foreground/50 size-1.5 animate-pulse rounded-full [animation-delay:150ms]" />
            <span className="bg-foreground/50 size-1.5 animate-pulse rounded-full [animation-delay:300ms]" />
          </div>
        ) : null}
      </div>
    </div>
  );
});
