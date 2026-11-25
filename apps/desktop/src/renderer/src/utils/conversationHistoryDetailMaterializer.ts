import type { ConversationHistoryJson } from "@deepwrite/contracts";
import type {
  ConversationHistoryReadSession,
  HistoryDetailTarget
} from "../composables/conversation-history-reader";
import { HistoryReadCancelledError } from "../composables/conversation-history-reader";
import {
  MAX_CONVERSATION_HISTORY_DETAIL_BYTES,
  MAX_CONVERSATION_HISTORY_RECORD_BYTES
} from "./conversationHistoryLimits";
export {
  MAX_CONVERSATION_HISTORY_DETAIL_BYTES,
  MAX_CONVERSATION_HISTORY_RECORD_BYTES
} from "./conversationHistoryLimits";
const HISTORY_DETAIL_WORKER_THRESHOLD_BYTES = 256 * 1024;

interface WorkerRequest {
  type: "chunk" | "finish";
  chunk?: string;
  encoding?: "text" | "json";
}
type WorkerResponse =
  { type: "success"; value: ConversationHistoryJson } | { type: "error" };

export interface ConversationHistoryStreamBudget {
  receivedBytes: number;
}

interface CapacityMessages {
  detail: string;
  total: string;
}

function createWorkerAccumulator(signal?: AbortSignal) {
  let worker: Worker | undefined;
  let chunks: string[] = [];
  let units = 0;
  let completed = false;
  let failure: unknown;
  let resolveResult: ((value: ConversationHistoryJson) => void) | undefined;
  let rejectResult: ((reason: unknown) => void) | undefined;
  let result: Promise<ConversationHistoryJson> | undefined;

  const assertActive = () => {
    if (failure !== undefined) throw failure;
    if (signal?.aborted) {
      fail(new HistoryReadCancelledError());
      throw failure;
    }
  };
  const cleanup = () => {
    signal?.removeEventListener("abort", cancel);
    worker?.terminate();
    worker = undefined;
    chunks = [];
  };
  const fail = (error: unknown) => {
    if (completed || failure !== undefined) return;
    failure = error;
    rejectResult?.(error);
    cleanup();
  };
  const cancel = () => fail(new HistoryReadCancelledError());
  signal?.addEventListener("abort", cancel, { once: true });

  const startWorker = () => {
    if (worker || typeof Worker === "undefined") return;
    assertActive();
    result = new Promise<ConversationHistoryJson>((resolve, rejectPromise) => {
      resolveResult = resolve;
      rejectResult = rejectPromise;
    });
    void result.catch(() => undefined);
    worker = new Worker(
      new URL("./conversationHistoryDetail.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (completed || failure !== undefined) return;
      if (event.data.type === "error") {
        fail(new Error("Conversation history detail could not be parsed."));
        return;
      }
      completed = true;
      resolveResult?.(event.data.value);
      cleanup();
    };
    worker.onerror = () =>
      fail(new Error("Conversation history detail worker failed."));
    worker.onmessageerror = () =>
      fail(
        new Error("Conversation history detail worker returned invalid data.")
      );
    for (const chunk of chunks)
      worker.postMessage({ type: "chunk", chunk } satisfies WorkerRequest);
    chunks = [];
  };

  return {
    push(chunk: string) {
      assertActive();
      units += chunk.length;
      if (worker) {
        worker.postMessage({ type: "chunk", chunk } satisfies WorkerRequest);
        return;
      }
      chunks.push(chunk);
      if (units >= HISTORY_DETAIL_WORKER_THRESHOLD_BYTES) startWorker();
    },
    async finish(encoding: "text" | "json") {
      assertActive();
      if (!worker) {
        const text = chunks.length === 1 ? chunks[0]! : chunks.join("");
        cleanup();
        return encoding === "text"
          ? text
          : (JSON.parse(text) as ConversationHistoryJson);
      }
      worker.postMessage({ type: "finish", encoding } satisfies WorkerRequest);
      return result!;
    },
    dispose() {
      if (worker && !completed && failure === undefined)
        fail(new HistoryReadCancelledError());
      else cleanup();
    }
  };
}

export async function materializeConversationHistoryDetail(
  reader: ConversationHistoryReadSession,
  target: HistoryDetailTarget,
  budget: ConversationHistoryStreamBudget,
  messages: CapacityMessages,
  signal?: AbortSignal
): Promise<ConversationHistoryJson> {
  if (
    target.encoding === "json" &&
    target.byteLength > MAX_CONVERSATION_HISTORY_DETAIL_BYTES
  )
    throw new Error(messages.detail);
  const accumulator = createWorkerAccumulator(signal);
  const encoder = new TextEncoder();
  let detailBytes = 0;
  try {
    for await (const part of reader.streamDetail(target, signal)) {
      const chunkBytes = encoder.encode(part.chunk).byteLength;
      detailBytes += chunkBytes;
      budget.receivedBytes += chunkBytes;
      if (detailBytes > MAX_CONVERSATION_HISTORY_DETAIL_BYTES)
        throw new Error(messages.detail);
      if (budget.receivedBytes > MAX_CONVERSATION_HISTORY_RECORD_BYTES)
        throw new Error(messages.total);
      accumulator.push(part.chunk);
    }
    return await accumulator.finish(target.encoding);
  } finally {
    accumulator.dispose();
  }
}
