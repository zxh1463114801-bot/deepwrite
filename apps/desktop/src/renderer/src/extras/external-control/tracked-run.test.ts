import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationController } from "../../composables/useAgentConversation";
import { createTrackedMessages } from "../../composables/agent-conversation/message-mutations";
import type { ChatMessage } from "../../types/conversation";
import { trackExternalRun } from "./tracked-run";

function harness(initialMessages: ChatMessage[]) {
  const messages = ref(initialMessages);
  const activeRunId = ref<string | null>("internal-run");
  const sessionId = ref("session-1");
  const busy = ref(true);
  const pendingUserInput = ref(null);
  const conversation = {
    messages,
    activeRunId,
    sessionId,
    pendingUserInput,
    isBusy: computed(() => busy.value)
  } as unknown as AgentConversationController;
  return {
    conversation,
    messages,
    activeRunId,
    sessionId,
    busy,
    pendingUserInput
  };
}

function message(
  value: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">
): ChatMessage {
  return {
    createdAt: "2026-11-22T00:00:00.000Z",
    ...value
  };
}

describe("trackExternalRun", () => {
  it("does not traverse old payloads or recompute tool usage for streamed content", async () => {
    const oldMessage = message({
      id: "old-assistant",
      role: "assistant",
      content: "old"
    }) as ChatMessage & { archivedPayload: unknown };
    Object.defineProperty(oldMessage, "archivedPayload", {
      enumerable: true,
      get() {
        throw new Error("unrelated history was traversed");
      }
    });
    let toolCallsRead = 0;
    const assistant = message({
      id: "current-assistant",
      runId: "internal-run",
      role: "assistant",
      content: "current",
      status: "streaming"
    });
    Object.defineProperty(assistant, "toolCalls", {
      enumerable: true,
      get() {
        toolCallsRead++;
        return [
          {
            id: "tool-1",
            name: "read",
            get args() {
              throw new Error("tool args were traversed");
            },
            status: "running" as const,
            requestedAt: "2026-11-22T00:00:00.000Z"
          }
        ];
      }
    });
    const trackedMessages = createTrackedMessages([oldMessage, assistant]);
    const liveAssistant = trackedMessages.findById(assistant.id)!;
    const test = harness([]);
    test.conversation.messages = trackedMessages.messages;

    const tracked = trackExternalRun(
      "external-run",
      test.conversation,
      liveAssistant
    );
    const initialToolReads = toolCallsRead;

    for (let batch = 0; batch < 10; batch++) {
      for (let index = 0; index < 50; index++)
        liveAssistant.content += `${batch}:${index}`;
      await nextTick();
    }
    expect(toolCallsRead).toBe(initialToolReads);

    liveAssistant.status = "completed";
    test.activeRunId.value = null;
    test.busy.value = false;
    await nextTick();
    expect(toolCallsRead).toBe(initialToolReads + 1);
    expect(tracked.snapshot()).toMatchObject({
      status: "completed",
      toolUsage: { total: 1, pending: 1 }
    });
  });

  it("reads live reply and tool usage on demand, then freezes the terminal result", async () => {
    const assistant = message({
      id: "current-assistant",
      runId: "internal-run",
      role: "assistant",
      content: "first",
      status: "streaming",
      toolCalls: [
        {
          id: "tool-1",
          name: "read",
          args: {},
          status: "running",
          requestedAt: "2026-11-22T00:00:00.000Z"
        }
      ]
    });
    const test = harness([assistant]);
    const tracked = trackExternalRun(
      "external-run",
      test.conversation,
      assistant
    );

    assistant.content = "latest";
    assistant.toolCalls![0]!.status = "completed";
    assistant.toolCalls![0]!.completedAt = "2026-11-22T00:00:01.000Z";
    expect(tracked.snapshot()).toMatchObject({
      status: "running",
      reply: "latest",
      toolUsage: { total: 1, succeeded: 1, pending: 0 }
    });

    assistant.content = "final";
    assistant.status = "completed";
    test.activeRunId.value = null;
    test.busy.value = false;
    await nextTick();
    expect(tracked.snapshot()).toMatchObject({
      status: "completed",
      reply: "final",
      toolUsage: { total: 1, succeeded: 1, pending: 0 }
    });

    assistant.content = "changed after completion";
    expect(tracked.snapshot().reply).toBe("final");
  });

  it("tracks placeholder identity and disposes its lifecycle watcher", async () => {
    const assistant = message({
      id: "placeholder",
      role: "assistant",
      content: "",
      status: "streaming"
    });
    const test = harness([assistant]);
    test.activeRunId.value = null;
    const identities = vi.fn();
    const tracked = trackExternalRun(
      "external-run",
      test.conversation,
      assistant,
      undefined,
      { kind: "short", id: "book-1" },
      { onIdentity: identities }
    );

    assistant.id = "accepted-assistant";
    assistant.runId = "accepted-run";
    test.activeRunId.value = "accepted-run";
    await nextTick();
    expect(tracked.ownsActiveRun()).toBe(true);
    expect(identities).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assistantId: "accepted-assistant",
        internalRunId: "accepted-run",
        lastStatus: "running"
      })
    );

    tracked.dispose();
    assistant.status = "completed";
    test.activeRunId.value = null;
    test.busy.value = false;
    await nextTick();
    expect(tracked.snapshot()).toMatchObject({
      status: "completed",
      reply: ""
    });
  });
});
