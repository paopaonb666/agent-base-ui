// Feature flags（构建期环境变量；缺省=关闭）。
//
// 消息树（ADR-013）依赖后端 6 个树端点（tree/nodes/jump/restore/export）+
// invoke 的 parent_node_id/regenerate 锚点字段 + 历史消息的 node_id 标签
// ——当前后端（Python 与 Java）均未实现这组契约（纯前端规格先行）。
// 前端默认隐藏整组入口，代码与测试保留；后端立项后以
// NEXT_PUBLIC_ENABLE_MESSAGE_TREE=1 构建/配置打开。
export const MESSAGE_TREE_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_MESSAGE_TREE === "1";
