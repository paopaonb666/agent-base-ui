"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MessagesSquare, Settings, SquarePen } from "lucide-react";
import { ThreadList } from "./ThreadList";
import { ChatInterface } from "./ChatInterface";
import { ConfigDialog } from "./ConfigDialog";
import { ThreadStatusBadge } from "./ThreadStatusBadge";
import { useStreamContext } from "@/providers/Stream";
import { useThreads } from "@/providers/Thread";
import { resolveThreadStatus } from "@/lib/thread-status";

export function AgentChatApp() {
  const stream = useStreamContext();
  const { threads } = useThreads();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);

  const openThread = ({
    threadId: id,
    module: mod,
  }: {
    threadId: string;
    module: string;
  }) => {
    stream.setModule(mod);
    stream.setThreadId(id);
  };

  // 顶栏展示当前会话的收尾状态（进行中则显示"正在对话"）。threads 来自
  // Thread context：saveThread 更新索引状态时顶栏随之重渲染。
  const activeThread = stream.threadId
    ? threads.find((t) => t.threadId === stream.threadId)
    : undefined;

  return (
    <>
      <div className="flex h-screen flex-col">
        <header className="border-border flex h-16 items-center justify-between border-b px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold">Agent 基座界面</h1>
            {stream.threadId && (
              <ThreadStatusBadge
                status={resolveThreadStatus(
                  activeThread,
                  stream.isThreadStreaming(stream.threadId),
                )}
                withLabel
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSidebarOpen((v) => !v)}
              className="border-border bg-card text-foreground hover:bg-accent rounded-md border"
            >
              <MessagesSquare className="mr-2 h-4 w-4" />
              对话列表
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfigOpen(true)}
            >
              <Settings className="mr-2 h-4 w-4" />
              设置
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => stream.resetThread()}
              disabled={!stream.threadId}
            >
              <SquarePen className="mr-2 h-4 w-4" />
              新建对话
            </Button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <aside className="border-border bg-sidebar w-[320px] shrink-0 border-r">
              <ThreadList
                onSelect={openThread}
                onClose={() => setSidebarOpen(false)}
                activeThreadId={stream.threadId}
              />
            </aside>
          )}
          <main className="flex flex-1 flex-col overflow-hidden">
            <ChatInterface />
          </main>
        </div>
      </div>

      <ConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        onSave={(c) => {
          stream.setApiUrl(c.apiUrl);
          stream.setModule(c.module);
        }}
        initialConfig={{ apiUrl: stream.apiUrl, module: stream.module }}
      />
    </>
  );
}
