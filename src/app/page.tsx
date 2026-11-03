"use client";

import React from "react";
import { ThreadProvider } from "@/providers/Thread";
import { StreamProvider } from "@/providers/Stream";
import { TreeProvider } from "@/providers/Tree";
import { AgentChatApp } from "@/components/thread/AgentChatApp";
import { Toaster } from "@/components/ui/sonner";

export default function HomePage(): React.ReactNode {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <p className="text-muted-foreground">加载中…</p>
        </div>
      }
    >
      <Toaster />
      <ThreadProvider>
        <StreamProvider>
          <TreeProvider>
            <AgentChatApp />
          </TreeProvider>
        </StreamProvider>
      </ThreadProvider>
    </React.Suspense>
  );
}
