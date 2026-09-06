"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfigDialog, type AppConfig } from "./ConfigDialog";

export function SetupScreen({
  defaultApiUrl,
  defaultModule,
  onSave,
}: {
  defaultApiUrl: string;
  defaultModule: string;
  onSave: (config: AppConfig) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <>
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold">欢迎使用 Agent 基座界面</h1>
          <p className="mt-2 text-muted-foreground">
            请配置 agent-base 服务地址与模块以开始使用
          </p>
          <Button onClick={() => setOpen(true)} className="mt-4">
            打开配置
          </Button>
        </div>
      </div>
      <ConfigDialog
        open={open}
        onOpenChange={setOpen}
        onSave={onSave}
        initialConfig={{ apiUrl: defaultApiUrl, module: defaultModule }}
      />
    </>
  );
}
