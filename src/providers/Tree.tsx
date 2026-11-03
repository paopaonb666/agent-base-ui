"use client";

// 消息树状态层（ADR-013）：整棵消息树的获取 / 维护 / 分支跳转。
//
// 包在 StreamProvider 之外（依赖它的 apiUrl/module/threadId 与转写重载）；
// 组件层用 useTree() 消费。树数据的刷新时机：会话切换、一轮对话收尾
// （isLoading 翻转）、维护操作之后——树面板永远反映后端的事实。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  deleteTreeNode,
  exportThreadTree,
  fetchThreadTree,
  jumpThreadBranch,
  patchTreeNode,
  restoreTreeNode,
  type ThreadTree,
  type TreeNode,
} from "./agentBaseClient";
import { useStreamContext } from "./Stream";

interface TreeContextType {
  tree: ThreadTree | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** 切换活跃分支：后端跳转指针 + 前端整体重载该分支的转写。 */
  switchBranch: (nodeId: string) => Promise<void>;
  patchNode: (
    nodeId: string,
    patch: {
      label?: string | null;
      starred?: boolean | null;
      archived?: boolean | null;
    },
  ) => Promise<void>;
  removeNode: (nodeId: string, cascade: boolean) => Promise<boolean>;
  restoreNode: (nodeId: string) => Promise<void>;
  /** 导出整棵树并触发浏览器下载。 */
  exportTree: (format: "md" | "json") => Promise<void>;
  /** 同父兄弟（分支切换器 ‹1/2› 的数据源），按 seq 升序。 */
  siblingsOf: (nodeId: string) => TreeNode[];
  /** 树中定位一个节点（不存在返回 null）。 */
  nodeById: (nodeId: string) => TreeNode | null;
  /** "从此分岔"挂起态：消息菜单设置、输入框展示与消费（下一条消息
   * 以该节点为父），发送后由 ChatInterface 清除。 */
  branchHint: { nodeId: string; label: string } | null;
  setBranchHint: (hint: { nodeId: string; label: string } | null) => void;
}

const TreeContext = createContext<TreeContextType | undefined>(undefined);

export function useTree(): TreeContextType {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("useTree 必须在 <TreeProvider> 内使用");
  return ctx;
}

export function TreeProvider({ children }: { children: ReactNode }) {
  const stream = useStreamContext();
  const { threadId, module: moduleName, apiUrl } = stream;
  const [tree, setTree] = useState<ThreadTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchHint, setBranchHint] = useState<{
    nodeId: string;
    label: string;
  } | null>(null);
  // 上一帧的 isLoading：true→false 翻转意味着一轮对话收尾（树多了尾巴）。
  const prevLoadingRef = useRef(stream.isLoading);

  const refresh = useCallback(async () => {
    if (!threadId || !apiUrl) {
      setTree(null);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchThreadTree({
        apiUrl,
        module: moduleName,
        threadId,
      });
      setTree(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [threadId, apiUrl, moduleName]);

  // 会话切换即拉树。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 一轮对话收尾（isLoading true→false）后刷新树：回写钩子刚落了新节点。
  useEffect(() => {
    const was = prevLoadingRef.current;
    prevLoadingRef.current = stream.isLoading;
    if (was && !stream.isLoading && threadId) {
      void refresh();
    }
  }, [stream.isLoading, threadId, refresh]);

  const guardBusy = useCallback((): boolean => {
    if (threadId && stream.isThreadStreaming(threadId)) {
      toast.info("对话进行中，请等待本轮结束再操作分支");
      return true;
    }
    return false;
  }, [threadId, stream]);

  const switchBranch = useCallback(
    async (nodeId: string) => {
      if (!threadId || !apiUrl) return;
      if (guardBusy()) return;
      try {
        await jumpThreadBranch({
          apiUrl,
          module: moduleName,
          threadId,
          nodeId,
        });
        // 后端指针已切：清缓存整体重载该分支的转写。
        stream.reloadThread();
        await refresh();
      } catch (err) {
        toast.error("切换分支失败", {
          description: (
            <p>
              <strong>
                {err instanceof Error ? err.message : String(err)}
              </strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      }
    },
    [threadId, apiUrl, moduleName, stream, refresh, guardBusy],
  );

  const patchNode = useCallback(
    async (
      nodeId: string,
      patch: {
        label?: string | null;
        starred?: boolean | null;
        archived?: boolean | null;
      },
    ) => {
      if (!threadId || !apiUrl) return;
      try {
        await patchTreeNode({
          apiUrl,
          module: moduleName,
          threadId,
          nodeId,
          ...patch,
        });
        await refresh();
      } catch (err) {
        toast.error("更新节点失败", {
          description: (
            <p>
              <strong>
                {err instanceof Error ? err.message : String(err)}
              </strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      }
    },
    [threadId, apiUrl, moduleName, refresh],
  );

  const removeNode = useCallback(
    async (nodeId: string, cascade: boolean): Promise<boolean> => {
      if (!threadId || !apiUrl) return false;
      if (guardBusy()) return false;
      try {
        const result = await deleteTreeNode({
          apiUrl,
          module: moduleName,
          threadId,
          nodeId,
          cascade,
        });
        // 活跃路径被删（指针回退）时，视图也要跟着回退。
        if (result.pointer_rolled_back) stream.reloadThread();
        await refresh();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 409 = 有后代：提示用户确认级联（交由调用方弹确认后再调）。
        toast.error("删除失败", {
          description: (
            <p>
              <strong>{message}</strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
        return false;
      }
    },
    [threadId, apiUrl, moduleName, stream, refresh, guardBusy],
  );

  const restoreNode = useCallback(
    async (nodeId: string) => {
      if (!threadId || !apiUrl) return;
      try {
        await restoreTreeNode({ apiUrl, module: moduleName, threadId, nodeId });
        await refresh();
        toast.success("已恢复该分支");
      } catch (err) {
        toast.error("恢复失败", {
          description: (
            <p>
              <strong>
                {err instanceof Error ? err.message : String(err)}
              </strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      }
    },
    [threadId, apiUrl, moduleName, refresh],
  );

  const exportTree = useCallback(
    async (format: "md" | "json") => {
      if (!threadId || !apiUrl) return;
      try {
        const content = await exportThreadTree({
          apiUrl,
          module: moduleName,
          threadId,
          format,
        });
        const blob = new Blob([content], {
          type:
            format === "md"
              ? "text/markdown;charset=utf-8"
              : "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `thread-${threadId}-tree.${format}`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        toast.error("导出失败", {
          description: (
            <p>
              <strong>
                {err instanceof Error ? err.message : String(err)}
              </strong>
            </p>
          ),
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
      }
    },
    [threadId, apiUrl, moduleName],
  );

  const siblingsOf = useCallback(
    (nodeId: string): TreeNode[] => {
      const node = tree?.nodes.find((n) => n.node_id === nodeId);
      if (!tree || !node) return [];
      return tree.nodes
        .filter(
          (n) =>
            n.parent_id === node.parent_id &&
            n.role === node.role &&
            !n.deleted,
        )
        .sort((a, b) => a.seq - b.seq);
    },
    [tree],
  );

  const nodeById = useCallback(
    (nodeId: string): TreeNode | null =>
      tree?.nodes.find((n) => n.node_id === nodeId) ?? null,
    [tree],
  );

  const value = useMemo<TreeContextType>(
    () => ({
      tree,
      loading,
      error,
      refresh,
      switchBranch,
      patchNode,
      removeNode,
      restoreNode,
      exportTree,
      siblingsOf,
      nodeById,
      branchHint,
      setBranchHint,
    }),
    [
      tree,
      loading,
      error,
      refresh,
      switchBranch,
      patchNode,
      removeNode,
      restoreNode,
      exportTree,
      siblingsOf,
      nodeById,
      branchHint,
    ],
  );

  return <TreeContext.Provider value={value}>{children}</TreeContext.Provider>;
}
