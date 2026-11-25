import { describe, expect, it, vi } from "vitest";
import type {
  ConversationHistoryApi,
  ConversationHistoryDetailResult,
  ConversationHistoryMessage,
  ConversationHistoryMessagesResult,
  ConversationHistorySession
} from "@deepwrite/contracts";
import { HistoryReadConflictError } from "../composables/conversation-history-reader";
import { loadConversationHistoryRecord } from "./conversationHistoryRecordLoader";

const MIB = 1024 * 1024;
const now = "2026-01-02T03:04:05.000Z";

function session(
  overrides: Partial<ConversationHistorySession> = {}
): ConversationHistorySession {
  return {
    sessionId: "session",
    metadata: { createdAt: now, updatedAt: now },
    revision: 1,
    generation: 0,
    sequence: 0,
    deleted: false,
    messageCount: 0,
    byteLength: 128,
    ...overrides
  };
}

function apiFor(options: {
  session: ConversationHistorySession;
  messages?: ConversationHistoryMessagesResult;
  detail?: (
    query: Parameters<ConversationHistoryApi["detail"]>[0]
  ) => Promise<ConversationHistoryDetailResult>;
  metadataDetail?: (
    query: Parameters<ConversationHistoryApi["metadataDetail"]>[0]
  ) => Promise<ConversationHistoryDetailResult>;
}) {
  const api = {
    session: vi.fn().mockResolvedValue(options.session),
    messages: vi.fn().mockResolvedValue(
      options.messages ?? {
        revision: options.session.revision,
        generation: options.session.generation,
        messages: [],
        nextPosition: null
      }
    ),
    detail: vi.fn(options.detail),
    metadataDetail: vi.fn(options.metadataDetail),
    turns: vi.fn(),
    mergeScopes: vi.fn(),
    stage: vi.fn(),
    commit: vi.fn(),
    list: vi.fn(),
    listArchived: vi.fn(),
    purge: vi.fn()
  };
  return api as unknown as ConversationHistoryApi & typeof api;
}

function jsonResult(
  value: unknown,
  revision = 1
): ConversationHistoryDetailResult {
  const chunk = JSON.stringify(value);
  return {
    revision,
    encoding: "json",
    chunk,
    nextOffset: null,
    totalBytes: new TextEncoder().encode(chunk).byteLength
  };
}

describe("loadConversationHistoryRecord", () => {
  it("rejects an oversized session before reading pages or details", async () => {
    const current = session({ byteLength: 458 * MIB });
    const api = apiFor({ session: current });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).rejects.toThrow();

    expect(api.messages).not.toHaveBeenCalled();
    expect(api.detail).not.toHaveBeenCalled();
    expect(api.metadataDetail).not.toHaveBeenCalled();
    expect(api.stage).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it("applies the record budget to aggregate metadata rather than the detail budget", async () => {
    const current = session({ metadataByteLength: 20 * MIB });
    const api = apiFor({ session: current });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).resolves.toMatchObject({ sessionId: "session", messages: [] });
  });

  it("restores a 9 MiB newline draft with an 18 MiB serialized size upper bound", async () => {
    const draft = "\n".repeat(9 * MIB);
    const current = session({
      metadataByteLength: 18 * MIB + 128,
      metadataDetails: [
        { path: ["draft"], encoding: "text", byteLength: 18 * MIB + 2 }
      ]
    });
    const api = apiFor({
      session: current,
      metadataDetail: async (query) => {
        const offset = query.offset ?? 0;
        const end = Math.min(offset + MIB, draft.length);
        return {
          revision: 1,
          encoding: "text",
          chunk: draft.slice(offset, end),
          nextOffset: end === draft.length ? null : end,
          totalBytes: draft.length
        };
      }
    });

    const record = await loadConversationHistoryRecord(
      api,
      "history",
      "session",
      { session: current }
    );

    expect(record.draft).toBe(draft);
  });

  it("counts UTF-8 inline metadata and messages across pages when declared sizes are too small", async () => {
    const content = "界".repeat(170_000);
    const current = session({
      messageCount: 66,
      byteLength: 1,
      metadata: { createdAt: now, updatedAt: now, draft: content }
    });
    const api = apiFor({ session: current });
    api.messages.mockImplementation(async (query) => {
      const position = (query.afterPosition ?? -1) + 1;
      return {
        revision: 1,
        generation: 0,
        nextPosition: position === 65 ? null : position,
        messages: [
          {
            messageId: `message-${position}`,
            position,
            value: {
              id: `message-${position}`,
              role: "user",
              createdAt: now,
              content
            },
            details: [],
            byteLength: 1
          }
        ]
      };
    });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).rejects.toThrow();
    expect(api.messages.mock.calls.length).toBeLessThan(66);
    expect(api.stage).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it("counts declared message sizes when the session size is too small", async () => {
    const current = session({ messageCount: 3, byteLength: 1 });
    const api = apiFor({
      session: current,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: Array.from({ length: 3 }, (_, position) => ({
          messageId: `message-${position}`,
          position,
          value: {
            id: `message-${position}`,
            role: "user",
            createdAt: now,
            content: ""
          },
          details: [],
          byteLength: 11 * MIB
        }))
      }
    });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).rejects.toThrow();
    expect(api.session).not.toHaveBeenCalled();
  });

  it("restores all messages in a 15.7 MiB session without truncating older context", async () => {
    const content = "x".repeat(Math.floor(7.85 * MIB));
    const current = session({
      messageCount: 2,
      byteLength: 2 * content.length + 1024
    });
    const api = apiFor({
      session: current,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: ["oldest", "newest"].map((messageId, position) => ({
          messageId,
          position,
          value: { id: messageId, role: "user", createdAt: now },
          details: [
            {
              path: ["content"],
              encoding: "text",
              byteLength: content.length
            }
          ],
          byteLength: content.length + 128
        }))
      },
      detail: async (query) => {
        const offset = query.offset ?? 0;
        const end = Math.min(offset + MIB, content.length);
        return {
          revision: 1,
          encoding: "text",
          chunk: content.slice(offset, end),
          nextOffset: end === content.length ? null : end,
          totalBytes: content.length
        };
      }
    });

    const record = await loadConversationHistoryRecord(
      api,
      "history",
      "session",
      { session: current }
    );

    expect(record.messages.map((message) => message.id)).toEqual([
      "oldest",
      "newest"
    ]);
    expect(
      record.messages.every((message) => message.content === content)
    ).toBe(true);
    expect(api.stage).not.toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it("allows a message larger than 16 MiB when each detail fits its own budget", async () => {
    const content = "x".repeat(10 * MIB);
    const current = session({ messageCount: 1, byteLength: 21 * MIB });
    const message: ConversationHistoryMessage = {
      messageId: "message",
      position: 0,
      value: { id: "message", role: "assistant", createdAt: now },
      details: ["content", "thinking"].map((field) => ({
        path: [field],
        encoding: "text",
        byteLength: content.length
      })),
      byteLength: 20 * MIB + 128
    };
    const api = apiFor({
      session: current,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: [message]
      },
      detail: async (query) => {
        const offset = query.offset ?? 0;
        const end = Math.min(offset + MIB, content.length);
        return {
          revision: 1,
          encoding: "text",
          chunk: content.slice(offset, end),
          nextOffset: end === content.length ? null : end,
          totalBytes: content.length
        };
      }
    });

    const record = await loadConversationHistoryRecord(
      api,
      "history",
      "session",
      { session: current }
    );

    expect(record.messages[0]).toMatchObject({ content, thinking: content });
  });

  it("rejects oversized declared metadata and message details before materializing them", async () => {
    const metadataSession = session({
      metadataDetails: [
        { path: ["draft"], encoding: "json", byteLength: 16 * MIB + 1 }
      ]
    });
    const metadataApi = apiFor({ session: metadataSession });
    await expect(
      loadConversationHistoryRecord(metadataApi, "history", "session", {
        session: metadataSession
      })
    ).rejects.toThrow();
    expect(metadataApi.metadataDetail).not.toHaveBeenCalled();
    expect(metadataApi.messages).not.toHaveBeenCalled();

    const messageSession = session({ messageCount: 1 });
    const messageApi = apiFor({
      session: messageSession,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: [
          {
            messageId: "message",
            position: 0,
            value: {
              id: "message",
              role: "user",
              createdAt: now
            },
            details: [
              {
                path: ["content"],
                encoding: "json",
                byteLength: 16 * MIB + 1
              }
            ],
            byteLength: 16 * MIB + 1
          }
        ]
      }
    });
    await expect(
      loadConversationHistoryRecord(messageApi, "history", "session", {
        session: messageSession
      })
    ).rejects.toThrow();
    expect(messageApi.detail).not.toHaveBeenCalled();
  });

  it("counts cumulative detail references when declared message sizes are too small", async () => {
    const content = "x".repeat(11 * MIB);
    const current = session({ messageCount: 3, byteLength: 1 });
    const api = apiFor({
      session: current,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: Array.from({ length: 3 }, (_, index) => ({
          messageId: `message-${index}`,
          position: index,
          value: {
            id: `message-${index}`,
            role: index % 2 ? "assistant" : "user",
            createdAt: now
          },
          details: [
            {
              path: ["content"],
              encoding: "text" as const,
              byteLength: content.length
            }
          ],
          byteLength: 1
        }))
      },
      detail: async (query) => {
        const offset = query.offset ?? 0;
        const end = Math.min(offset + MIB, content.length);
        return {
          revision: 1,
          encoding: "text",
          chunk: content.slice(offset, end),
          nextOffset: end === content.length ? null : end,
          totalBytes: content.length
        };
      }
    });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).rejects.toThrow();
    expect(api.detail).toHaveBeenCalled();
  });

  it("cancels during detail streaming without returning a partial record", async () => {
    let resolveTail!: (value: ConversationHistoryDetailResult) => void;
    const tail = new Promise<ConversationHistoryDetailResult>((resolve) => {
      resolveTail = resolve;
    });
    const current = session({ messageCount: 1, byteLength: 2 * MIB });
    const abort = new AbortController();
    const api = apiFor({
      session: current,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: [
          {
            messageId: "message",
            position: 0,
            value: { id: "message", role: "user", createdAt: now },
            details: [
              {
                path: ["content"],
                encoding: "text",
                byteLength: 2 * MIB
              }
            ],
            byteLength: 2 * MIB
          }
        ]
      },
      detail: async (query) =>
        query.offset === 0
          ? {
              revision: 1,
              encoding: "text",
              chunk: "a".repeat(MIB),
              nextOffset: MIB,
              totalBytes: 2 * MIB
            }
          : tail
    });

    const pending = loadConversationHistoryRecord(api, "history", "session", {
      session: current,
      signal: abort.signal
    });
    await vi.waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveTail({
      revision: 1,
      encoding: "text",
      chunk: "b".repeat(MIB),
      nextOffset: null,
      totalBytes: 2 * MIB
    });
  });

  it("preserves complete metadata and compaction checkpoints", async () => {
    const checkpoint = {
      summary: "Earlier work",
      firstKeptRunId: "run-2",
      tokensBefore: 12_000,
      createdAt: now,
      refs: { read: ["doc:one"], proposed: [], skills: [], materials: [] }
    };
    const storedMessage = {
      id: "message",
      role: "assistant",
      content: "complete answer",
      createdAt: now,
      runId: "run-2",
      contextCompactions: [
        {
          id: "compaction",
          status: "completed",
          reason: "threshold",
          level: "summary",
          tokensBefore: 12_000,
          tokensAfter: 4_000,
          checkpoint,
          createdAt: now,
          completedAt: now
        }
      ]
    };
    const messageDetail = jsonResult(storedMessage);
    const metadataDetail = jsonResult({
      createdAt: now,
      updatedAt: now,
      draft: "full draft",
      approvalMode: "auto-approve",
      temperature: 0.4
    });
    const current = session({
      messageCount: 1,
      metadataDetails: [
        {
          path: [],
          encoding: "json",
          byteLength: metadataDetail.totalBytes
        }
      ]
    });
    const api = apiFor({
      session: current,
      metadataDetail: async () => metadataDetail,
      detail: async () => messageDetail,
      messages: {
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: [
          {
            messageId: "message",
            position: 0,
            value: {},
            details: [
              {
                path: [],
                encoding: "json",
                byteLength: messageDetail.totalBytes
              }
            ],
            byteLength: messageDetail.totalBytes
          }
        ]
      }
    });

    const record = await loadConversationHistoryRecord(
      api,
      "history",
      "session",
      { session: current }
    );

    expect(record).toMatchObject({
      sessionId: "session",
      draft: "full draft",
      approvalMode: "auto-approve",
      temperature: 0.4
    });
    expect(record.messages).toHaveLength(1);
    expect(record.messages[0]).toMatchObject({
      id: "message",
      content: "complete answer",
      runId: "run-2",
      contextCompactions: [{ checkpoint }]
    });
  });

  it("keeps revision conflict behavior unchanged", async () => {
    const current = session({ messageCount: 1 });
    const api = apiFor({
      session: current,
      messages: {
        revision: 2,
        generation: 0,
        messages: [],
        nextPosition: null
      }
    });

    await expect(
      loadConversationHistoryRecord(api, "history", "session", {
        session: current
      })
    ).rejects.toBeInstanceOf(HistoryReadConflictError);
  });
});
