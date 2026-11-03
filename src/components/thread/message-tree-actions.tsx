"use client";

// 消息树交互（ADR-013）：
// - BranchSwitcher：同父兄弟分支切换器 ‹ 1/2 ›（ChatGPT 式，数据来自
//   树 API，本地按 parent_id + role 计算 siblings）；
// - MessageActionsMenu：消息 hover 菜单——从此分岔 / 编辑重发 / 重新
//   生成 / 重命名 / 星标 / 删除子树。

import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  MoreVertical,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTree } from "@/providers/Tree";
import { useStreamContext } from "@/providers/Stream";

/** 同父兄弟分支切换器：该消息存在同级备选时渲染 ‹ 2/3 ›。 */
export function BranchSwitcher({ nodeId }: { nodeId: string }) {
  const { siblingsOf, switchBranch } = useTree();
  const siblings = useMemo(() => siblingsOf(nodeId), [siblingsOf, nodeId]);
  if (siblings.length <= 1) return null;
  const index = siblings.findIndex((s) => s.node_id === nodeId);
  if (index < 0) return null;
  const go = (delta: number) => {
    const next = siblings[(index + delta + siblings.length) % siblings.length];
    void switchBranch(next.node_id);
  };
  return (
    <div className="bg-background/80 text-muted-foreground inline-flex items-center gap-0.5 rounded-md border px-1 py-0.5 text-xs">
      <button
        type="button"
        className="hover:bg-accent rounded p-0.5 disabled:opacity-40"
        onClick={() => go(-1)}
        disabled={siblings.length < 2}
        title="上一个分支"
      >
        <ChevronLeft
          className="size-3.5"
          aria-hidden
        />
      </button>
      <span className="tabular-nums">
        {index + 1}/{siblings.length}
      </span>
      <button
        type="button"
        className="hover:bg-accent rounded p-0.5 disabled:opacity-40"
        onClick={() => go(1)}
        disabled={siblings.length < 2}
        title="下一个分支"
      >
        <ChevronRight
          className="size-3.5"
          aria-hidden
        />
      </button>
    </div>
  );
}

type PendingDialog =
  | { kind: "rename"; nodeId: string; initial: string }
  | { kind: "edit"; nodeId: string; parentId: string; initial: string }
  | { kind: "delete"; nodeId: string; descendants: number }
  | null;

export function MessageActionsMenu({
  nodeId,
  role,
  content,
  className,
}: {
  nodeId: string;
  role: "human" | "assistant";
  content: string;
  className?: string;
}) {
  const { tree, nodeById, patchNode, removeNode, setBranchHint } = useTree();
  const stream = useStreamContext();
  const [dialog, setDialog] = useState<PendingDialog>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const node = nodeById(nodeId);
  // 后代计数（删除确认文案用）：沿 children 逐层统计。
  const descendants = useMemo(() => {
    if (!tree) return 0;
    const byParent = new Map<string | null, string[]>();
    for (const n of tree.nodes) {
      if (n.deleted) continue;
      const list = byParent.get(n.parent_id) ?? [];
      list.push(n.node_id);
      byParent.set(n.parent_id, list);
    }
    let count = 0;
    const stack = [...(byParent.get(nodeId) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      count += 1;
      stack.push(...(byParent.get(id) ?? []));
    }
    return count;
  }, [tree, nodeId]);

  const parentId = node?.parent_id ?? null;
  const streamingHere =
    stream.threadId !== null && stream.isThreadStreaming(stream.threadId);

  const openDialog = (next: PendingDialog) => {
    setDialog(next);
    setDraft(
      next?.kind === "rename"
        ? next.initial
        : next?.kind === "edit"
          ? next.initial
          : "",
    );
  };

  const submitDialog = async () => {
    if (!dialog || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === "rename") {
        await patchNode(dialog.nodeId, { label: draft.trim() || null });
      } else if (dialog.kind === "edit") {
        // 编辑重发 = 在原消息的父节点下分岔（原消息完整保留为另一分支）。
        if (!dialog.parentId) return;
        await stream.sendMessage(draft.trim(), undefined, {
          parentNodeId: dialog.parentId,
        });
      } else if (dialog.kind === "delete") {
        await removeNode(dialog.nodeId, dialog.descendants > 0);
      }
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
          className,
        )}
      >
        <BranchSwitcher nodeId={nodeId} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-6"
              disabled={streamingHere}
              title="消息操作"
            >
              <MoreVertical
                className="size-3.5"
                aria-hidden
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-44"
          >
            <DropdownMenuItem
              onClick={() =>
                setBranchHint({
                  nodeId,
                  label: node?.label || content.slice(0, 40),
                })
              }
            >
              <GitBranch
                className="size-3.5"
                aria-hidden
              />{" "}
              从此分岔
            </DropdownMenuItem>
            {role === "human" && parentId && (
              <DropdownMenuItem
                onClick={() =>
                  openDialog({
                    kind: "edit",
                    nodeId,
                    parentId,
                    initial: content,
                  })
                }
              >
                <Pencil
                  className="size-3.5"
                  aria-hidden
                />{" "}
                编辑重发
              </DropdownMenuItem>
            )}
            {role === "assistant" && parentId && (
              <DropdownMenuItem
                onClick={() =>
                  void stream.sendMessage("", undefined, {
                    regenerate: true,
                    parentNodeId: parentId,
                  })
                }
              >
                <RefreshCw
                  className="size-3.5"
                  aria-hidden
                />{" "}
                重新生成
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                openDialog({
                  kind: "rename",
                  nodeId,
                  initial: node?.label ?? "",
                })
              }
            >
              <Tag
                className="size-3.5"
                aria-hidden
              />{" "}
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void patchNode(nodeId, { starred: !node?.starred })
              }
            >
              <Star
                className={cn(
                  "size-3.5",
                  node?.starred && "fill-amber-400 text-amber-400",
                )}
                aria-hidden
              />
              {node?.starred ? "取消星标" : "星标"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() =>
                openDialog({ kind: "delete", nodeId, descendants })
              }
            >
              <Trash2
                className="size-3.5"
                aria-hidden
              />
              {descendants > 0 ? `删除子树（${descendants} 条）` : "删除"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="sm:max-w-md">
          {dialog?.kind === "delete" ? (
            <>
              <DialogHeader>
                <DialogTitle>确认删除</DialogTitle>
              </DialogHeader>
              <p className="text-muted-foreground text-sm">
                {dialog.descendants > 0
                  ? `该节点下还有 ${dialog.descendants} 条后代消息，将连同整棵子树一起移入「已删除」（可在树面板恢复）。`
                  : "该消息将移入「已删除」（可在树面板恢复）。"}
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDialog(null)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void submitDialog()}
                >
                  删除
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog?.kind === "rename" ? "重命名节点" : "编辑并重新发送"}
                </DialogTitle>
              </DialogHeader>
              {dialog?.kind === "edit" && (
                <p className="text-muted-foreground text-xs">
                  原消息完整保留为另一条分支；新消息将作为它的兄弟分岔发出。
                </p>
              )}
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  dialog?.kind === "rename" ? "分支名称" : "编辑后的消息"
                }
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submitDialog();
                  }
                }}
              />
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDialog(null)}
                >
                  取消
                </Button>
                <Button
                  onClick={() => void submitDialog()}
                  disabled={busy || !draft.trim()}
                >
                  {dialog?.kind === "rename" ? "保存" : "发送"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
