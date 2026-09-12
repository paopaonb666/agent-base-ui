"use client";

import { memo } from "react";
import { ExternalLink } from "lucide-react";
import { UiMessage } from "@/providers/Stream";
import { MarkdownText } from "./markdown-text";
import { ToolStep } from "./messages/tool-calls";
import { useSmoothText } from "./use-smooth-text";

// 助手消息：流式内容经打字机平滑揭示（display-only，权威转写不变，
// 见 use-smooth-text）。历史回放/切回的完整消息不做打字重放。
function AssistantMessage({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  const shown = useSmoothText(content);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-full min-w-0">
        {shown ? (
          <MarkdownText>{shown}</MarkdownText>
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
}

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
        result={message.result}
      />
    );
  }

  if (message.role === "sources") {
    // 工具发布的引用来源（web_search）：可点击的外链卡片。
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-1">
        <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-2">
          <p className="m-0 text-xs font-medium text-gray-500">信息来源</p>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {message.sources.map((s, i) => (
              <li
                key={`${s.title}-${i}`}
                className="truncate text-xs"
              >
                <span className="mr-1 text-gray-400">[{i + 1}]</span>
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    title={s.title}
                  >
                    <span className="truncate">{s.title}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ) : (
                  <span
                    className="text-gray-600"
                    title={s.title}
                  >
                    {s.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
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
    <AssistantMessage
      content={message.content}
      isStreaming={isStreaming}
    />
  );
});
