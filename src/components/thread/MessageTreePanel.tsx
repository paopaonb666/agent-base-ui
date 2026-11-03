"use client";

// 侧边消息树面板（ADR-013）：整棵会话树的缩进可视化。
//
// - 当前活跃路径高亮（沿 parent 链上溯的节点集合）；
// - 点击节点 = 切换到该分支（后端跳指针 + 视图整体重载）；
// - 分组：活跃树 / 已归档（折叠） / 已删除（折叠 + 恢复入口）；
// - 工具栏：刷新 / 导出 Markdown / 导出 JSON。
//
// 无图形库依赖：纯 CSS 连接线（border-l + ::before 横线），长会话渲染
// 成本与节点数线性，天然免虚拟化。

import { useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  RotateCcw,
  Star,
  User,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTree } from "@/providers/Tree";
import type { TreeNode } from "@/providers/agentBaseClient";

const ROLE_META: Record<
  TreeNode["role"],
  { icon: typeof User; label: string; tint: string }
> = {
  human: { icon: User, label: "用户", tint: "text-sky-600 dark:text-sky-400" },
  assistant: {
    icon: Bot,
    label: "助手",
    tint: "text-emerald-600 dark:text-emerald-400",
  },
  tool: {
    icon: Wrench,
    label: "工具",
    tint: "text-amber-600 dark:text-amber-400",
  },
};

/** 活跃路径的节点集合（沿 current_node_id 上溯）。 */
function activePathIds(
  tree: NonNullable<ReturnType<typeof useTree>["tree"]>,
): Set<string> {
  const byId = new Map(tree.nodes.map((n) => [n.node_id, n]));
  const ids = new Set<string>();
  let cursor = tree.current_node_id;
  while (cursor && byId.has(cursor) && !ids.has(cursor)) {
    ids.add(cursor);
    cursor = byId.get(cursor)!.parent_id;
  }
  return ids;
}

function NodeRow({
  node,
  depth,
  onActive,
}: {
  node: TreeNode;
  depth: number;
  onActive: boolean;
}) {
  const { switchBranch, tree, nodeById } = useTree();
  const meta = ROLE_META[node.role] ?? ROLE_META.assistant;
  const Icon = meta.icon;
  const isCurrent = tree?.current_node_id === node.node_id;
  const title = node.label || node.preview || meta.label;
  return (
    <button
      type="button"
      onClick={() => void switchBranch(node.node_id)}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs",
        "hover:bg-accent transition-colors",
        onActive && "bg-accent/60",
        isCurrent && "bg-accent ring-ring/40 ring-1",
        node.archived && "opacity-60",
      )}
      style={{ marginLeft: depth * 12 }}
      title={`${meta.label}：${node.preview ?? ""}`}
    >
      <Icon
        className={cn("size-3.5 shrink-0", meta.tint)}
        aria-hidden
      />
      {/* 连接线：非顶层节点渲染横向短线，配合父级缩进构成树干视觉 */}
      {depth > 0 && (
        <span
          aria-hidden
          className="bg-border h-px w-2 shrink-0"
        />
      )}
      {node.starred && (
        <Star
          className="size-3 shrink-0 fill-amber-400 text-amber-400"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "truncate",
          onActive ? "font-medium" : "text-muted-foreground",
        )}
      >
        {title}
      </span>
      {isCurrent && (
        <span className="bg-primary/10 text-primary ml-auto shrink-0 rounded px-1 text-[10px]">
          当前
        </span>
      )}
    </button>
  );
}

function NodeBranch({
  node,
  childrenMap,
  activeIds,
  depth,
  onActiveOnly,
}: {
  node: TreeNode;
  childrenMap: Map<string | null, TreeNode[]>;
  activeIds: Set<string>;
  depth: number;
  /** true = 只渲染活跃路径上的节点（主线优先呈现，旁支折叠到后面）。 */
  onActiveOnly: boolean;
}) {
  const children = (childrenMap.get(node.node_id) ?? []).filter(
    (n) => !n.archived,
  );
  return (
    <div>
      <NodeRow
        node={node}
        depth={depth}
        onActive={activeIds.has(node.node_id)}
      />
      {children.map((child) => {
        const childOnPath = activeIds.has(child.node_id);
        if (onActiveOnly && !childOnPath) return null;
        return (
          <NodeBranch
            key={child.node_id}
            node={child}
            childrenMap={childrenMap}
            activeIds={activeIds}
            depth={depth + 1}
            onActiveOnly={onActiveOnly && childOnPath}
          />
        );
      })}
    </div>
  );
}

/** 旁支（不在活跃路径上的兄弟子树），折叠渲染在主线之后。 */
function OffPathBranches({
  childrenMap,
  activeIds,
}: {
  childrenMap: Map<string | null, TreeNode[]>;
  activeIds: Set<string>;
}) {
  const roots = (childrenMap.get(null) ?? []).filter(
    (n) => !n.archived && !n.deleted,
  );
  const offPathRoots = roots.filter((n) => !activeIds.has(n.node_id));
  // 主线上的分岔点：活跃路径节点的孩子里不在活跃路径上的子树。
  const pathNodes = [...activeIds];
  return (
    <>
      {offPathRoots.map((root) => (
        <NodeBranch
          key={root.node_id}
          node={root}
          childrenMap={childrenMap}
          activeIds={activeIds}
          depth={0}
          onActiveOnly={false}
        />
      ))}
      {pathNodes.map((id) => {
        const branches = (childrenMap.get(id) ?? []).filter(
          (n) => !n.deleted && !n.archived && !activeIds.has(n.node_id),
        );
        return branches.map((head) => (
          <NodeBranch
            key={head.node_id}
            node={head}
            childrenMap={childrenMap}
            activeIds={activeIds}
            depth={0}
            onActiveOnly={false}
          />
        ));
      })}
    </>
  );
}

export function MessageTreePanel() {
  const { tree, loading, error, refresh, exportTree, restoreNode, patchNode } =
    useTree();
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const childrenMap = useMemo(() => {
    const map = new Map<string | null, TreeNode[]>();
    for (const node of tree?.nodes ?? []) {
      const list = map.get(node.parent_id) ?? [];
      list.push(node);
      map.set(node.parent_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.seq - b.seq);
    return map;
  }, [tree]);

  const activeIds = useMemo(
    () => (tree ? activePathIds(tree) : new Set<string>()),
    [tree],
  );
  const archived = useMemo(
    () => (tree?.nodes ?? []).filter((n) => n.archived && !n.deleted),
    [tree],
  );
  const deleted = useMemo(
    () => (tree?.nodes ?? []).filter((n) => n.deleted),
    [tree],
  );
  const liveRoots = useMemo(
    () =>
      (childrenMap.get(null) ?? []).filter(
        (n) => !n.archived && !n.deleted && activeIds.has(n.node_id),
      ),
    [childrenMap, activeIds],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          消息树
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => void refresh()}
            title="刷新"
          >
            <RotateCcw
              className="size-3.5"
              aria-hidden
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => void exportTree("md")}
            title="导出 Markdown"
          >
            <Download
              className="size-3.5"
              aria-hidden
            />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {error && <p className="text-destructive px-1 py-2 text-xs">{error}</p>}
        {!tree && !error && (
          <p className="text-muted-foreground px-1 py-2 text-xs">
            {loading ? "加载中…" : "发送第一条消息后，这里会展示整棵消息树"}
          </p>
        )}
        {tree && (
          <>
            {liveRoots.map((root) => (
              <NodeBranch
                key={root.node_id}
                node={root}
                childrenMap={childrenMap}
                activeIds={activeIds}
                depth={0}
                onActiveOnly
              />
            ))}
            <OffPathBranches
              childrenMap={childrenMap}
              activeIds={activeIds}
            />
            {archived.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-accent flex w-full items-center gap-1 rounded px-1 py-1 text-xs"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? (
                    <ChevronDown
                      className="size-3"
                      aria-hidden
                    />
                  ) : (
                    <ChevronRight
                      className="size-3"
                      aria-hidden
                    />
                  )}
                  已归档（{archived.length}）
                </button>
                {showArchived &&
                  archived.map((node) => (
                    <div
                      key={node.node_id}
                      className="flex items-center gap-1"
                    >
                      <div className="flex-1">
                        <NodeRow
                          node={node}
                          depth={0}
                          onActive={false}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5"
                        title="取消归档"
                        onClick={() =>
                          void patchNode(node.node_id, { archived: false })
                        }
                      >
                        <RotateCcw
                          className="size-3"
                          aria-hidden
                        />
                      </Button>
                    </div>
                  ))}
              </div>
            )}
            {deleted.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-accent flex w-full items-center gap-1 rounded px-1 py-1 text-xs"
                  onClick={() => setShowDeleted((v) => !v)}
                >
                  {showDeleted ? (
                    <ChevronDown
                      className="size-3"
                      aria-hidden
                    />
                  ) : (
                    <ChevronRight
                      className="size-3"
                      aria-hidden
                    />
                  )}
                  已删除（{deleted.length}）
                </button>
                {showDeleted &&
                  deleted
                    .filter((n) => {
                      // 只列删除波次的根（父节点不在已删除集合里的）。
                      const parent = tree.nodes.find(
                        (p) => p.node_id === n.parent_id,
                      );
                      return !parent || !parent.deleted;
                    })
                    .map((node) => (
                      <div
                        key={node.node_id}
                        className="flex items-center gap-1 opacity-70"
                      >
                        <div className="flex-1">
                          <NodeRow
                            node={node}
                            depth={0}
                            onActive={false}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          title="恢复该分支"
                          onClick={() => void restoreNode(node.node_id)}
                        >
                          <RotateCcw
                            className="size-3"
                            aria-hidden
                          />
                        </Button>
                      </div>
                    ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
