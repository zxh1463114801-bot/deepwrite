import type { ConversationHistoryApi } from "@deepwrite/contracts";
import { createId } from "@deepwrite/shared";
import { loadConversationHistoryRecord } from "../utils/conversationHistoryRecordLoader";
import { listConversationHistoryIndex } from "../utils/conversationHistoryIndex";
import type { UseAgentConversationOptions } from "./useAgentConversation";

type Management = NonNullable<UseAgentConversationOptions["historyManagement"]>;

export function createConversationRegistryHistory(
  api: ConversationHistoryApi,
  key: string
) {
  // Management is opened by the user; restoring the active conversation needs
  // only the paginated reader, not deletion receipts and recovery orchestration.
  let management: Promise<Management> | undefined;
  function getManagement(): Promise<Management> {
    management ??= import("./conversationRegistryHistoryManagement")
      .then(({ createRegistryHistoryManagement }) =>
        createRegistryHistoryManagement(api, key)
      )
      .catch((error: unknown) => {
        management = undefined;
        throw error;
      });
    return management;
  }
  const hooks: Pick<
    UseAgentConversationOptions,
    "loadHistoryRecord" | "historyManagement"
  > = {
    loadHistoryRecord: (sessionId) =>
      loadConversationHistoryRecord(api, key, sessionId),
    historyManagement: {
      delete: async (sessionId) => (await getManagement()).delete(sessionId),
      restore: async (sessionId) => (await getManagement()).restore(sessionId),
      listDeleted: async () => (await getManagement()).listDeleted()
    }
  };
  async function initialHistory(fallbackSessionId: string) {
    const index = await listConversationHistoryIndex(api, key);
    const activeSessionId = index.items.some(
      (item) => item.sessionId === index.activeSessionId
    )
      ? index.activeSessionId!
      : (index.items[0]?.sessionId ?? fallbackSessionId);
    if (!index.items.length) return { ...index, activeSessionId };
    try {
      const active = await loadConversationHistoryRecord(
        api,
        key,
        activeSessionId
      );
      return { ...index, activeSessionId, active };
    } catch (activeLoadError: unknown) {
      // An unloaded persisted session must never become an empty writable record.
      let recoverySessionId = fallbackSessionId;
      while (index.items.some((item) => item.sessionId === recoverySessionId))
        recoverySessionId = createId("session");
      return { ...index, activeSessionId: recoverySessionId, activeLoadError };
    }
  }
  return { hooks, initialHistory };
}
