import type { ConversationHistoryJson } from "@deepwrite/contracts";

type WorkerRequest =
  | { type: "chunk"; chunk: string }
  | { type: "finish"; encoding: "text" | "json" };
type WorkerResponse =
  { type: "success"; value: ConversationHistoryJson } | { type: "error" };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const chunks: string[] = [];

scope.onmessage = (event) => {
  if (event.data.type === "chunk") {
    chunks.push(event.data.chunk);
    return;
  }
  try {
    const text = chunks.length === 1 ? chunks[0]! : chunks.join("");
    const value: ConversationHistoryJson =
      event.data.encoding === "text" ? text : JSON.parse(text);
    scope.postMessage({ type: "success", value });
  } catch {
    scope.postMessage({ type: "error" });
  } finally {
    chunks.length = 0;
    scope.close();
  }
};
