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
import {
  fetchHealth,
  listModules,
  type ModuleInfo,
} from "@/providers/agentBaseClient";

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
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);

  const savedApiUrl = initialConfig?.apiUrl ?? "";

  useEffect(() => {
    if (open && initialConfig) {
      setApiUrl(initialConfig.apiUrl);
      setModule(initialConfig.module);
      setTestError(null);
    }
  }, [open, initialConfig]);

  // 打开时尝试拉取已注册模块列表（失败不阻塞——输入框保留自由填写）。
  useEffect(() => {
    if (!open || !savedApiUrl) return;
    let cancelled = false;
    listModules({ apiUrl: savedApiUrl })
      .then((mods) => {
        if (!cancelled && mods.length > 0) setModules(mods);
      })
      .catch(() => {
        // 模块列表不可用：保持自由输入。
      });
    return () => {
      cancelled = true;
    };
  }, [open, savedApiUrl]);

  const handleSave = async () => {
    if (!apiUrl.trim() || !module.trim()) return;
    // 模块名先本地校验（列表拉到过才有）：垃圾模块名保存后只会在
    // 发消息时以一句干巴巴的 Not Found 暴露。
    if (modules.length > 0 && !modules.some((m) => m.name === module.trim())) {
      setTestError(
        `未知模块 "${module.trim()}"；可用模块：${modules.map((m) => m.name).join("、")}`,
      );
      return;
    }
    setTesting(true);
    setTestError(null);
    try {
      // 保存前先探活：坏地址当场暴露，而不是第一次发消息时才报错。
      await fetchHealth({ apiUrl: apiUrl.trim() });
      onSave({ apiUrl: apiUrl.trim(), module: module.trim() });
      onOpenChange(false);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
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
              list="agent-module-options"
            />
            <datalist id="agent-module-options">
              {modules.map((m) => (
                <option
                  key={m.name}
                  value={m.name}
                >
                  {m.description}
                </option>
              ))}
            </datalist>
          </div>
          {testError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
              连接测试失败：{testError}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={testing || !apiUrl.trim() || !module.trim()}
          >
            {testing ? "测试连接中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
