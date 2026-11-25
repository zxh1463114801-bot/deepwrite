import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationHistoryReadSession,
  HistoryDetailTarget
} from "../composables/conversation-history-reader";
import { materializeConversationHistoryDetail } from "./conversationHistoryDetailMaterializer";

type WorkerReply = { type: "success"; value: unknown } | { type: "error" };

class FakeWorker {
  static behavior: "success" | "error" | "pending" | "stream-error" = "success";
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: { type: "chunk" | "finish" }) {
    if (message.type === "chunk" && FakeWorker.behavior === "stream-error") {
      queueMicrotask(() => this.onerror?.({} as ErrorEvent));
      return;
    }
    if (message.type !== "finish" || FakeWorker.behavior === "pending") return;
    queueMicrotask(() => {
      this.onmessage?.({
        data:
          FakeWorker.behavior === "success"
            ? { type: "success", value: { restored: true } }
            : { type: "error" }
      } as MessageEvent<WorkerReply>);
    });
  }
}

const target: HistoryDetailTarget = {
  messageId: "message",
  path: [],
  byteLength: 300 * 1024,
  encoding: "json"
};
const messages = { detail: "detail capacity", total: "total capacity" };

function readerWith(chunk: string) {
  return {
    async *streamDetail() {
      yield { chunk };
    }
  } as unknown as ConversationHistoryReadSession;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
  FakeWorker.behavior = "success";
});

describe("conversation history detail worker materialization", () => {
  it("uses and terminates the worker for large details", async () => {
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const value = await materializeConversationHistoryDetail(
      readerWith(" ".repeat(target.byteLength)),
      target,
      { receivedBytes: 0 },
      messages
    );

    expect(value).toEqual({ restored: true });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker after a parse error", async () => {
    FakeWorker.behavior = "error";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    await expect(
      materializeConversationHistoryDetail(
        readerWith(" ".repeat(target.byteLength)),
        target,
        { receivedBytes: 0 },
        messages
      )
    ).rejects.toThrow("could not be parsed");

    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker and rejects with AbortError when cancelled", async () => {
    FakeWorker.behavior = "pending";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const abort = new AbortController();
    const pending = materializeConversationHistoryDetail(
      readerWith(" ".repeat(target.byteLength)),
      target,
      { receivedBytes: 0 },
      messages,
      abort.signal
    );
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("keeps a worker failure terminal while subsequent stream chunks arrive", async () => {
    FakeWorker.behavior = "stream-error";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const reader = {
      async *streamDetail() {
        yield { chunk: " ".repeat(target.byteLength) };
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield { chunk: "tail" };
      }
    } as unknown as ConversationHistoryReadSession;

    await expect(
      materializeConversationHistoryDetail(
        reader,
        target,
        { receivedBytes: 0 },
        messages
      )
    ).rejects.toThrow("worker failed");

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("keeps cancellation terminal when a stream yields a late chunk", async () => {
    FakeWorker.behavior = "pending";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const abort = new AbortController();
    const reader = {
      async *streamDetail() {
        yield { chunk: " ".repeat(target.byteLength) };
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield { chunk: "tail" };
      }
    } as unknown as ConversationHistoryReadSession;

    await expect(
      materializeConversationHistoryDetail(
        reader,
        target,
        { receivedBytes: 0 },
        messages,
        abort.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("terminates and settles a pending worker when the stream rejects", async () => {
    FakeWorker.behavior = "pending";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const failure = new Error("stream failed");
    const reader = {
      async *streamDetail() {
        yield { chunk: " ".repeat(target.byteLength) };
        throw failure;
      }
    } as unknown as ConversationHistoryReadSession;

    await expect(
      materializeConversationHistoryDetail(
        reader,
        target,
        { receivedBytes: 0 },
        messages
      )
    ).rejects.toBe(failure);

    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("enforces actual UTF-8 detail bytes when a declared size is too small", async () => {
    await expect(
      materializeConversationHistoryDetail(
        readerWith("界".repeat(6 * 1024 * 1024)),
        { ...target, byteLength: 1, encoding: "text" },
        { receivedBytes: 0 },
        messages
      )
    ).rejects.toThrow(messages.detail);
  });

  it("counts streamed UTF-8 bytes against the earlier inline record budget", async () => {
    const budget = { receivedBytes: 32 * 1024 * 1024 - 2 };
    await expect(
      materializeConversationHistoryDetail(
        readerWith("界"),
        { ...target, byteLength: 3, encoding: "text" },
        budget,
        messages
      )
    ).rejects.toThrow(messages.total);
    expect(budget.receivedBytes).toBe(32 * 1024 * 1024 + 1);
  });

  it("terminates a worker if later chunks exceed the record budget", async () => {
    FakeWorker.behavior = "pending";
    vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
    const reader = {
      async *streamDetail() {
        yield { chunk: " ".repeat(target.byteLength) };
        yield { chunk: "tail" };
      }
    } as unknown as ConversationHistoryReadSession;

    await expect(
      materializeConversationHistoryDetail(
        reader,
        target,
        { receivedBytes: 32 * 1024 * 1024 - target.byteLength },
        messages
      )
    ).rejects.toThrow(messages.total);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
