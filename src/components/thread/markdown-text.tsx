"use client";

import "./markdown-styles.css";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { FC, memo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { SyntaxHighlighter } from "@/components/thread/syntax-highlighter";

import { TooltipIconButton } from "@/components/thread/tooltip-icon-button";
import { cn } from "@/lib/utils";

import "katex/dist/katex.min.css";

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

// 围栏代码块外壳：头部（语言标签 + 复制按钮）+ 代码主体。带语言时走
// 语法高亮（源码取自子 code 元素的文本），否则退化为纯文本块——复制
// 内容从 DOM textContent 读取，对两条路径同样可靠。
const CodeBlock: FC<{
  language?: string;
  code: string;
  children: ReactNode;
}> = ({ language, code, children }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const contentRef = useRef<HTMLDivElement>(null);
  const onCopy = () => {
    const text = contentRef.current?.textContent ?? code;
    if (!text || isCopied) return;
    copyToClipboard(text);
  };

  return (
    <div className="my-4 max-w-4xl overflow-hidden rounded-lg bg-black text-white">
      <div className="flex items-center justify-between gap-4 bg-zinc-900 px-4 py-2 text-sm font-semibold">
        <span className="lowercase text-zinc-300">{language ?? "text"}</span>
        <TooltipIconButton
          tooltip="Copy"
          onClick={onCopy}
          aria-label="复制代码"
        >
          {!isCopied && <CopyIcon />}
          {isCopied && <CheckIcon />}
        </TooltipIconButton>
      </div>
      <div ref={contentRef}>
        {language && code ? (
          <SyntaxHighlighter language={language}>
            {code.replace(/\n$/, "")}
          </SyntaxHighlighter>
        ) : (
          <pre className="overflow-x-auto p-4 text-sm leading-6">{children}</pre>
        )}
      </div>
    </div>
  );
};

const defaultComponents: any = {
  h1: ({ className, ...props }: { className?: string }) => (
    <h1
      className={cn(
        "mb-8 scroll-m-20 text-4xl font-extrabold tracking-tight last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }: { className?: string }) => (
    <h2
      className={cn(
        "mt-8 mb-4 scroll-m-20 text-3xl font-semibold tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }: { className?: string }) => (
    <h3
      className={cn(
        "mt-6 mb-4 scroll-m-20 text-2xl font-semibold tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }: { className?: string }) => (
    <h4
      className={cn(
        "mt-6 mb-4 scroll-m-20 text-xl font-semibold tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }: { className?: string }) => (
    <h5
      className={cn(
        "my-4 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }: { className?: string }) => (
    <h6
      className={cn("my-4 font-semibold first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  p: ({ className, ...props }: { className?: string }) => (
    <p
      className={cn("mt-5 mb-5 leading-7 first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  a: ({ className, ...props }: { className?: string }) => (
    <a
      className={cn(
        "text-primary font-medium underline underline-offset-4",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: { className?: string }) => (
    <blockquote
      className={cn("border-l-2 pl-6 italic", className)}
      {...props}
    />
  ),
  ul: ({ className, ...props }: { className?: string }) => (
    <ul
      className={cn("my-5 ml-6 list-disc [&>li]:mt-2", className)}
      {...props}
    />
  ),
  ol: ({ className, ...props }: { className?: string }) => (
    <ol
      className={cn("my-5 ml-6 list-decimal [&>li]:mt-2", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }: { className?: string }) => (
    <hr
      className={cn("my-5 border-b", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }: { className?: string }) => (
    <table
      className={cn(
        "my-5 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }: { className?: string }) => (
    <th
      className={cn(
        "bg-muted px-4 py-2 text-left font-bold first:rounded-tl-lg last:rounded-tr-lg [&[align=center]]:text-center [&[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: { className?: string }) => (
    <td
      className={cn(
        "border-b border-l px-4 py-2 text-left last:border-r [&[align=center]]:text-center [&[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }: { className?: string }) => (
    <tr
      className={cn(
        "m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
  sup: ({ className, ...props }: { className?: string }) => (
    <sup
      className={cn("[&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ children }: { children?: ReactNode }) => {
    // 统一的围栏代码块外壳：头部（语言 + 复制）对带语言和不带语言的块
    // 一视同仁。旧实现只在 code 带 language-xxx 时渲染头部，无语言标注
    // 的块（``` 直接开栏）没有复制按钮。语言与源码从子 code 元素提取。
    const first = Array.isArray(children) ? children[0] : children;
    const childProps =
      typeof first === "object" && first !== null && "props" in first
        ? (first as { props?: { className?: string; children?: unknown } })
            .props ?? {}
        : {};
    const language = /language-([\w-]+)/.exec(childProps.className ?? "")?.[1];
    const code =
      typeof childProps.children === "string" ? childProps.children : "";
    return (
      <CodeBlock
        language={language}
        code={code}
      >
        {children}
      </CodeBlock>
    );
  },
  code: ({
    className,
    children,
    ...props
  }: {
    className?: string;
    children: ReactNode;
  }) => {
    // 带语言的块由 CodeBlock 外壳负责头部/复制/高亮（见 pre 覆写），
    // 这里只处理无语言标注的情形：出现在段落里是行内代码，出现在
    // CodeBlock 里则是纯文本块。
    return (
      <code
        className={cn("rounded font-semibold", className)}
        {...props}
      >
        {children}
      </code>
    );
  },
};

const MarkdownTextImpl: FC<{ children: string }> = ({ children }) => {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={defaultComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
