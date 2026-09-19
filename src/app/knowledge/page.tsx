"use client";

// 知识库独立路由（M8）：文档知识库 / 长期记忆 / 用户画像 三页签。
// provider 挂载方式与首页一致——apiUrl/module 从同一批 localStorage key
// 恢复，两个页面的配置天然同步（见 Stream.tsx 配置优先级注释）。

import React from "react";
import { Toaster } from "@/components/ui/sonner";
import { KnowledgePage } from "@/components/knowledge/KnowledgePage";
import { StreamProvider } from "@/providers/Stream";
import { ThreadProvider } from "@/providers/Thread";

export default function KnowledgeRoute(): React.ReactNode {
  return (
    <React.Suspense
      fallback={
        <div className="text-muted-foreground flex min-h-screen items-center justify-center text-sm">
          正在加载知识库…
        </div>
      }
    >
      <Toaster />
      <ThreadProvider>
        <StreamProvider>
          <KnowledgePage />
        </StreamProvider>
      </ThreadProvider>
    </React.Suspense>
  );
}
