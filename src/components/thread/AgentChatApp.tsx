"use client";

import { useState } from "react";
import { useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { MessagesSquare, Settings, SquarePen } from "lucide-react";
import { ThreadList } from "./ThreadList";
import { ChatInterface } from "./ChatInterface";
import { ConfigDialog } from "./ConfigDialog";
import { useStreamContext } from "@/providers/Stream";

export function AgentChatApp() {
  const stream = useStreamContext();
  const [threadId, setThreadId] = useQueryState("threadId");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);

  const openThread = ({ threadId: id, module: mod }: { threadId: string; module: string }) => {
    stream.setModule(mod);
    void setThreadId(id);
  };

  return (
    <>
      <div className="flex h-screen flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold">Agent 基座界面</h1>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSidebarOpen((v) => !v)}
              className="rounded-md border border-border bg-card text-foreground hover:bg-accent"
            >
              <MessagesSquare className="mr-2 h-4 w-4" />
              对话列表
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
              <Settings className="mr-2 h-4 w-4" />
              设置
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => stream.resetThread()}
              disabled={!threadId}
            >
              <SquarePen className="mr-2 h-4 w-4" />
              新建对话
            </Button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <aside className="w-[320px] shrink-0 border-r border-border bg-sidebar">
              <ThreadList
                onSelect={openThread}
                onClose={() => setSidebarOpen(false)}
                activeThreadId={threadId}
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
