import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationHistoryApi,
  ConversationHistorySession
} from "@deepwrite/contracts";
import { createConversationRegistryHistory } from "./conversationRegistryHistory";
import {
  useAgentConversation,
  type AgentConversationController
} from "./useAgentConversation";

const now = "2026-11-23T00:00:00.000Z";
const controllers: AgentConversationController[] = [];
afterEach(() =>
  controllers.splice(0).forEach((controller) => controller.dispose())
);

function setup(count = 521, active = "session-0000") {
  const sessions: ConversationHistorySession[] = Array.from(
    { length: count },
    (_, index) => ({
      sessionId: `session-${String(index).padStart(4, "0")}`,
      metadata: { createdAt: now, updatedAt: now },
      revision: 1,
      generation: 0,
      sequence: 0,
      deleted: false,
      messageCount: 1,
      byteLength: index === 0 ? 40 * 1024 * 1024 : 128
    })
  );
  const api = {
    list: vi.fn(
      async (query: Parameters<ConversationHistoryApi["list"]>[0]) => {
        const start = query.afterSessionId
          ? sessions.findIndex(
              (session) => session.sessionId === query.afterSessionId
            ) + 1
          : 0;
        const page = sessions.slice(start, start + 100);
        return {
          activeSessionId: active,
          sessions: page,
          nextSessionId:
            start + page.length < sessions.length
              ? page.at(-1)!.sessionId
              : null
        };
      }
    ),
    session: vi.fn(
      async (query: Parameters<ConversationHistoryApi["session"]>[0]) =>
        sessions.find((session) => session.sessionId === query.sessionId) ??
        null
    ),
    messages: vi.fn(
      async (query: Parameters<ConversationHistoryApi["messages"]>[0]) => ({
        revision: 1,
        generation: 0,
        nextPosition: null,
        messages: [
          {
            messageId: `${query.sessionId}-user`,
            position: 0,
            byteLength: 128,
            details: [],
            value: {
              id: `${query.sessionId}-user`,
              role: "user",
              content: "saved content",
              createdAt: now,
              status: "completed"
            }
          }
        ]
      })
    )
  } as unknown as ConversationHistoryApi;
  const history = createConversationRegistryHistory(api, "history");
  const controller = useAgentConversation({
    api: () => undefined,
    ...history.hooks
  });
  controllers.push(controller);
  return { api, history, controller, sessions };
}

describe("registry history recovery", () => {
  it("keeps every paginated summary when the active record exceeds capacity, without persisting a partial record", async () => {
    const { api, history, controller } = setup();
    const fallback = controller.sessionId.value;
    const snapshot = await history.initialHistory(fallback);
    expect(snapshot).toMatchObject({
      activeSessionId: fallback,
      activeLoadError: expect.any(Error)
    });
    expect(snapshot.items).toHaveLength(521);
    expect(api.list).toHaveBeenCalledTimes(6);
    expect(await controller.restorePersistenceHistory(snapshot)).toBe(true);
    expect(controller.history.value).toHaveLength(521);
    expect(controller.messages.value).toEqual([]);
    expect(controller.capturePersistenceChanges().conversations).toEqual([]);
    expect(await controller.openConversation("session-0001")).toBe(true);
    const messages = controller.messages.value;
    await expect(controller.openConversation("session-0000")).rejects.toThrow();
    expect(controller.sessionId.value).toBe("session-0001");
    expect(controller.messages.value).toBe(messages);
    controller.messages.value.push({
      id: "new-message",
      role: "user",
      content: "new content",
      createdAt: now
    });
    const changes = controller.capturePersistenceChanges();
    expect(changes.conversations.map((change) => change.sessionId)).toEqual([
      "session-0001"
    ]);
    expect(JSON.stringify(changes)).not.toContain("session-0000");
    expect(
      changes.conversations
        .flatMap((change) => change.operations)
        .every(
          (operation) =>
            operation.type !== "removeMessages" &&
            operation.type !== "setDeleted"
        )
    ).toBe(true);
  });

  it("uses an independent recovery id if the fallback collides with any indexed session", async () => {
    const { history, controller, sessions } = setup(2);
    const snapshot = await history.initialHistory("session-0001");
    expect(
      sessions.some((session) => session.sessionId === snapshot.activeSessionId)
    ).toBe(false);
    expect(await controller.restorePersistenceHistory(snapshot)).toBe(true);
    expect(controller.capturePersistenceChanges().conversations).toEqual([]);
  });

  it("preserves normal active record restoration", async () => {
    const { history, controller } = setup(2, "session-0001");
    const snapshot = await history.initialHistory(controller.sessionId.value);
    expect(snapshot.activeSessionId).toBe("session-0001");
    expect(snapshot).not.toHaveProperty("activeLoadError");
    expect(await controller.restorePersistenceHistory(snapshot)).toBe(true);
    expect(controller.messages.value[0]?.content).toBe("saved content");
  });

  it("preserves the fresh controller id for an empty index", async () => {
    const { history, controller } = setup(0);
    const snapshot = await history.initialHistory(controller.sessionId.value);
    expect(snapshot).toEqual({
      activeSessionId: controller.sessionId.value,
      items: []
    });
    expect(await controller.restorePersistenceHistory(snapshot)).toBe(true);
  });

  it("does not mask index read failures", async () => {
    const { api, history } = setup();
    const failure = new Error("index unavailable");
    vi.mocked(api.list).mockRejectedValueOnce(failure);
    await expect(history.initialHistory("fresh")).rejects.toBe(failure);
  });
});
