"use client";

// 文档预览与切片可视化对话框（M7）：
// - 预览页签：文本文档显示提取正文（与注入给模型的内容同源），图片
//   显示原图，附元信息与"下载原文"；
// - 切片方式页签：原文按切片区间交替着色 + 序号角标（直观看切块
//   边界落在哪个段落），下方切片卡片列表（区间/长度/向量化状态）。
// 数据来自后端三个只读端点（preview / chunks / raw），属主校验由
// X-User-Id 头承载——身份不进 URL。

import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Loader2, ScanText } from "lucide-react";
import { toast } from "sonner";
import {
  fetchFileChunks,
  fetchFilePreview,
  fetchFileRawObjectUrl,
  type FileChunkView,
  type FilePreview,
} from "@/providers/agentBaseClient";
import { useStreamContext } from "@/providers/Stream";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

// 与后端 IMAGE_STORED_FORMATS 对齐：这些 format 的附件按图片预览。
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp", "gif"]);

export interface PreviewTarget {
  file_id: string;
  filename: string;
  format: string;
}

/** 原文高亮用的渲染片段：属于某切片（带序号）或切片之间的间隙。 */
interface RenderPiece {
  text: string;
  ordinal: number | null;
}

/** 把切片区间铺到原文上，生成高亮渲染序列；重叠区间按序号先后裁剪。 */
function buildHighlightPieces(
  source: string,
  chunks: FileChunkView[],
): RenderPiece[] {
  const withSegments = chunks
    .filter((c) => c.offsets && c.offsets.length > 0)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (withSegments.length === 0) return [];
  const pieces: RenderPiece[] = [];
  let cursor = 0;
  for (const chunk of withSegments) {
    for (const [start, end] of chunk.offsets ?? []) {
      const s = Math.max(start, cursor);
      const e = Math.min(Math.max(end, s), source.length);
      if (e <= s) continue;
      if (s > cursor) {
        pieces.push({ text: source.slice(cursor, s), ordinal: null });
      }
      pieces.push({ text: source.slice(s, e), ordinal: chunk.ordinal });
      cursor = e;
    }
  }
  if (cursor < source.length) {
    pieces.push({ text: source.slice(cursor), ordinal: null });
  }
  return pieces;
}

export function FilePreviewDialog({
  open,
  onOpenChange,
  file,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: PreviewTarget | null;
}) {
  const stream = useStreamContext();
  const [view, setView] = useState<"preview" | "chunks">("preview");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [chunks, setChunks] = useState<FileChunkView[]>([]);
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setView("preview");
    setPreview(null);
    setChunks([]);
    setRawUrl(null);
    void (async () => {
      try {
        const [previewData, chunkData, rawObjectUrl] = await Promise.all([
          fetchFilePreview({
            apiUrl: stream.apiUrl,
            module: stream.module,
            fileId: file.file_id,
            signal: controller.signal,
          }),
          fetchFileChunks({
            apiUrl: stream.apiUrl,
            module: stream.module,
            fileId: file.file_id,
            signal: controller.signal,
          }),
          fetchFileRawObjectUrl({
            apiUrl: stream.apiUrl,
            module: stream.module,
            fileId: file.file_id,
            signal: controller.signal,
          }).catch(() => null), // 原文拉取失败不阻塞预览（如纯知识分块已被撤销）
        ]);
        setPreview(previewData);
        setChunks(chunkData);
        setRawUrl(rawObjectUrl);
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`加载文档预览失败`, {
          description: <p className="max-w-80 break-all">{message}</p>,
          duration: 8000,
          richColors: true,
          closeButton: true,
        });
        onOpenChange(false);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, file, stream.apiUrl, stream.module, onOpenChange]);

  // 关闭时释放 objectURL。
  useEffect(() => {
    if (!open && rawUrl) {
      URL.revokeObjectURL(rawUrl);
      setRawUrl(null);
    }
  }, [open, rawUrl]);

  const isImage = file ? IMAGE_FORMATS.has(file.format) : false;
  const highlightPieces =
    preview && chunks.length > 0
      ? buildHighlightPieces(preview.extracted_text, chunks)
      : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {isImage ? (
              <ImageIcon className="size-4 text-blue-500" />
            ) : (
              <FileText className="size-4 text-blue-500" />
            )}
            <span className="max-w-[480px] truncate">{file?.filename}</span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {file?.format}
            {preview?.pages ? ` · ${preview.pages} 页` : ""} ·{" "}
            {preview?.text_len ?? 0} 字符
            {preview?.truncated ? " · 解析时已截断" : ""}
            {chunks.length > 0 ? ` · ${chunks.length} 个切片` : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col gap-2 py-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <>
            {/* 页签切换（ui 无 tabs 原语，用 toggle 按钮对） */}
            <div className="border-border flex gap-1 border-b pb-2">
              <button
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  view === "preview"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setView("preview")}
                type="button"
              >
                预览
              </button>
              <button
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  view === "chunks"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setView("chunks")}
                type="button"
              >
                切片方式
              </button>
              {rawUrl ? (
                <a
                  className="text-muted-foreground hover:text-foreground ml-auto self-center text-xs hover:underline"
                  download={file?.filename}
                  href={rawUrl}
                >
                  下载原文
                </a>
              ) : null}
            </div>

            {view === "preview" ? (
              isImage ? (
                rawUrl ? (
                  <img
                    alt={file?.filename}
                    className="mx-auto max-h-[55vh] rounded-lg object-contain"
                    src={rawUrl}
                  />
                ) : (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    原图不可用
                  </p>
                )
              ) : (
                <div className="border-border max-h-[55vh] overflow-auto rounded-lg border p-3">
                  <p className="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {preview?.extracted_text || "（未能从该文件提取到文本）"}
                  </p>
                </div>
              )
            ) : chunks.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                该文件没有知识库切片（可能解析失败或已撤销）
              </p>
            ) : (
              <div className="flex flex-col gap-4 overflow-y-auto pr-1">
                {highlightPieces.length > 0 ? (
                  <div>
                    <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                      原文切片边界（交替底色 = 不同切片）
                    </p>
                    <div className="border-border max-h-[32vh] overflow-auto rounded-lg border p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                      {highlightPieces.map((piece, i) =>
                        piece.ordinal === null ? (
                          <span key={`gap-${i}`}>{piece.text}</span>
                        ) : (
                          <span
                            className={
                              piece.ordinal % 2 === 0
                                ? "rounded-sm bg-blue-100"
                                : "rounded-sm bg-amber-100"
                            }
                            key={`seg-${i}`}
                            title={`切片 #${piece.ordinal}`}
                          >
                            {piece.text}
                            <sup className="text-muted-foreground ml-0.5 text-[10px]">
                              #{piece.ordinal}
                            </sup>
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    该文件切片于偏移量记录功能上线之前，无法在原文上标注边界（下方卡片仍可见）。
                  </p>
                )}
                <div>
                  <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                    切片卡片（{chunks.length} 个）
                  </p>
                  <div className="flex flex-col gap-2">
                    {chunks.map((chunk) => (
                      <div
                        className="border-border rounded-lg border p-2.5"
                        key={chunk.chunk_id}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">
                            <ScanText className="size-3" />#{chunk.ordinal}
                          </span>
                          <span className="text-muted-foreground">
                            {chunk.char_len} 字符
                            {chunk.offsets
                              ? ` · 区间 ${chunk.offsets
                                  .map(([s, e]) => `${s}–${e}`)
                                  .join("、")}`
                              : ""}
                          </span>
                          <span
                            className={`ml-auto rounded px-1.5 py-0.5 ${
                              chunk.has_embedding
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {chunk.has_embedding
                              ? `已向量化（${chunk.embedding_dim} 维）`
                              : "纯文本（未向量化）"}
                          </span>
                        </div>
                        <pre className="text-muted-foreground m-0 max-h-24 overflow-auto text-xs leading-relaxed break-words whitespace-pre-wrap">
                          {chunk.text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {view === "preview" && !isImage && chunks.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                切换到「切片方式」可查看该文档的切块边界与存储形态。
              </p>
            ) : null}
          </>
        )}
        {/* 惯例的隐藏加载指示：footer 留空 */}
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" /> 正在加载…
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
