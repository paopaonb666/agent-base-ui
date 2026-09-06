"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export interface AppConfig {
  apiUrl: string;
  module: string;
}

interface ConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: AppConfig) => void;
  initialConfig?: AppConfig;
}

export function ConfigDialog({
  open,
  onOpenChange,
  onSave,
  initialConfig,
}: ConfigDialogProps) {
  const [apiUrl, setApiUrl] = useState(initialConfig?.apiUrl || "");
  const [module, setModule] = useState(initialConfig?.module || "");

  useEffect(() => {
    if (open && initialConfig) {
      setApiUrl(initialConfig.apiUrl);
      setModule(initialConfig.module);
    }
  }, [open, initialConfig]);

  const handleSave = () => {
    if (!apiUrl.trim() || !module.trim()) return;
    onSave({ apiUrl: apiUrl.trim(), module: module.trim() });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>配置</DialogTitle>
          <DialogDescription>
            配置 agent-base 服务地址和要对话的模块（chat / writer / supervisor
            …）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="agent-api-url">agent-base 服务地址</Label>
            <Input
              id="agent-api-url"
              placeholder="http://localhost:8000"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-module">Agent 模块</Label>
            <Input
              id="agent-module"
              placeholder="chat"
              value={module}
              onChange={(e) => setModule(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            onClick={handleSave}
            disabled={!apiUrl.trim() || !module.trim()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
