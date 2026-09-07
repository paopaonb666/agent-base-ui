// agentBaseClient 的单元测试（vitest，node 环境）。
// 覆盖：SSE 帧解析、invokeAgent 的流消费与请求头、非 2xx 错误处理、
// fetchThreadHistory / fetchHealth / listModules。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchHealth,
  fetchThreadHistory,
  invokeAgent,
  listModules,
  parseFrame,
} from "../src/providers/agentBaseClient";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseFrame", () => {
  it("解析 ping 帧", () => {
    expect(parseFrame('event: ping\ndata: {"type":"ping"}')).toEqual({
      type: "ping",
    });
  });

  it("解析 step 帧的 name/status/detail", () => {
    const frame =
      'event: step\ndata: {"type":"step","name":"agent","status":"completed","detail":"done"}';
    expect(parseFrame(frame)).toEqual({
      type: "step",
      name: "agent",
      status: "completed",
      detail: "done",
    });
  });

  it("解析 delta/done/error 帧", () => {
    expect(
      parseFrame('event: delta\ndata: {"type":"delta","content":"你好"}'),
    ).toEqual({
      type: "delta",
      content: "你好",
    });
    expect(
      parseFrame('event: done\ndata: {"type":"done","thread_id":"t1"}'),
    ).toEqual({ type: "done", thread_id: "t1" });
    expect(
      parseFrame('event: error\ndata: {"type":"error","message":"boom"}'),
    ).toEqual({ type: "error", message: "boom" });
  });

  it("未知事件类型返回 null（前向兼容）", () => {
    expect(parseFrame('event: future\ndata: {"type":"future"}')).toBeNull();
  });

  it("坏 JSON / 缺 data 行返回 null", () => {
    expect(parseFrame("event: delta\ndata: {not-json")).toBeNull();
    expect(parseFrame("event: delta")).toBeNull();
  });
});

describe("invokeAgent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("消费 SSE 流并按序产出事件；携带 X-Request-ID 头", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        sseResponse([
          'event: step\ndata: {"type":"step","name":"agent","status":"running"}\n\n',
          'event: delta\ndata: {"type":"delta","content":"你好"}\n\n',
          'event: done\ndata: {"type":"done","thread_id":"t-1"}\n\n',
        ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of invokeAgent({
      apiUrl: "http://backend:8000/",
      module: "chat",
      message: "hi",
      requestId: "rid123",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "step", name: "agent", status: "running", detail: null },
      { type: "delta", content: "你好" },
      { type: "done", thread_id: "t-1" },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ "X-Request-ID": "rid123" });
    expect(JSON.parse(String(init?.body))).toEqual({ message: "hi" });
  });

  it("非 2xx 响应抛出后端 detail 文本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ detail: "module 'x' is not enabled" }, 404),
      ),
    );
    await expect(
      invokeAgent({ apiUrl: "http://b", module: "x", message: "hi" }).next(),
    ).rejects.toThrow("module 'x' is not enabled");
  });

  it("URL 尾部斜杠被规范化", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => sseResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of invokeAgent({
      apiUrl: "http://b/",
      module: "chat",
      message: "hi",
    })) {
      // 空流
    }
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://b/v1/agents/chat/invoke",
    );
  });
});

describe("fetchThreadHistory / fetchHealth / listModules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchThreadHistory 解析历史消息", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          thread_id: "t1",
          module: "chat",
          messages: [{ role: "human", content: "hi" }],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const history = await fetchThreadHistory({
      apiUrl: "http://b",
      module: "chat",
      threadId: "t1",
    });
    expect(history.messages).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://b/v1/agents/chat/threads/t1",
    );
  });

  it("fetchThreadHistory 的 404 抛出 detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "nope" }, 404)),
    );
    await expect(
      fetchThreadHistory({ apiUrl: "http://b", module: "chat", threadId: "x" }),
    ).rejects.toThrow("nope");
  });

  it("fetchHealth 返回健康状态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "ok", components: { checkpointer: "ok" } }),
      ),
    );
    const health = await fetchHealth({ apiUrl: "http://b" });
    expect(health.status).toBe("ok");
  });

  it("listModules 返回模块列表", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          modules: [{ name: "chat", description: "对话" }],
        }),
      ),
    );
    const mods = await listModules({ apiUrl: "http://b" });
    expect(mods).toEqual([{ name: "chat", description: "对话" }]);
  });
});
