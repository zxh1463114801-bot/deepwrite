import { createScopedTranslator } from "../i18n";
import type {
  ConversationHistoryApi,
  ConversationHistoryJson,
  ConversationHistoryRecord,
  ConversationHistorySession
} from "@deepwrite/contracts";
import type {
  HistoryDetailTarget,
  ConversationHistoryReadSession
} from "../composables/conversation-history-reader";
import { clonePersistenceRecord } from "../composables/agent-conversation/persistence-changes";
import { parsePersistenceRecord } from "../composables/agent-conversation/persistence-snapshot";
import { awaitHistoryResponse } from "../composables/conversation-history-reader/cancellation";
import {
  HistoryReadCancelledError,
  HistoryReadConflictError
} from "../composables/conversation-history-reader/types";
import {
  MAX_CONVERSATION_HISTORY_DETAIL_BYTES,
  MAX_CONVERSATION_HISTORY_RECORD_BYTES
} from "./conversationHistoryLimits";
import type { ConversationHistoryStreamBudget } from "./conversationHistoryDetailMaterializer";

const t = createScopedTranslator("workspace.conversationHistoryRecordLoader");

const RECORD_FIELDS = new Set([
  "sessionId",
  "createdAt",
  "updatedAt",
  "draft",
  "approvalMode",
  "temperature"
]);

function setLoadedField(
  target: ConversationHistoryRecord,
  path: readonly (string | number)[],
  value: ConversationHistoryJson
) {
  let parent: ConversationHistoryJson = target;
  for (const part of path.slice(0, -1)) {
    if (!parent || typeof parent !== "object")
      throw new Error(t("invalidHistoryFieldPath"));
    parent = Reflect.get(parent, part) as ConversationHistoryJson;
  }
  const key = path.at(-1);
  if (key === undefined || !parent || typeof parent !== "object")
    throw new Error(t("invalidHistoryFieldPath"));
  Object.defineProperty(parent, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function assertDetailCapacity(reference: {
  encoding: "text" | "json";
  byteLength: number;
}) {
  if (
    reference.encoding === "json" &&
    reference.byteLength > MAX_CONVERSATION_HISTORY_DETAIL_BYTES
  )
    throw new Error(t("historyDetailExceedsTheSafeLoadingSize"));
}

const encoder = new TextEncoder();

function jsonByteLength(value: ConversationHistoryJson) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function addActualBytes(
  budget: ConversationHistoryStreamBudget,
  byteLength: number
) {
  budget.receivedBytes += byteLength;
  if (budget.receivedBytes > MAX_CONVERSATION_HISTORY_RECORD_BYTES)
    throw new Error(t("streamedHistoryExceedsTheSafeLoadingSize"));
}

function assertRecordCapacity(byteLength: number) {
  if (byteLength > MAX_CONVERSATION_HISTORY_RECORD_BYTES)
    throw new Error(t("conversationExceedsTheSafeLoadingSize"));
}

async function materializeForActiveController(
  reader: ConversationHistoryReadSession,
  target: HistoryDetailTarget,
  budget: ConversationHistoryStreamBudget,
  signal?: AbortSignal
) {
  const { materializeConversationHistoryDetail } =
    await import("./conversationHistoryDetailMaterializer");
  return materializeConversationHistoryDetail(
    reader,
    target,
    budget,
    {
      detail: t("historyDetailExceedsTheSafeLoadingSize"),
      total: t("streamedHistoryExceedsTheSafeLoadingSize")
    },
    signal
  );
}

/** Only the selected session is materialized; other sessions remain lightweight history items. */
export async function loadConversationHistoryRecord(
  api: ConversationHistoryApi,
  key: string,
  sessionId: string,
  options: {
    signal?: AbortSignal;
    session?: ConversationHistorySession;
    allowDeleted?: boolean;
  } = {}
) {
  if (options.signal?.aborted) throw new HistoryReadCancelledError();
  const session =
    options.session ??
    (await awaitHistoryResponse(
      api.session({ key, sessionId, maxBytes: 64 * 1024 }),
      [options.signal]
    ));
  if (!session || (session.deleted && !options.allowDeleted))
    throw new Error(t("thisConversationNoLongerExistsOrHasBeenDeleted"));
  if (session.byteLength > MAX_CONVERSATION_HISTORY_RECORD_BYTES)
    throw new Error(t("conversationExceedsTheSafeLoadingSize"));
  if (session.metadataByteLength !== undefined)
    assertRecordCapacity(session.metadataByteLength);
  for (const reference of session.metadataDetails ?? [])
    assertDetailCapacity(reference);
  // Empty histories need only the lightweight index. Load the page/detail
  // reader after a real session has been found, or on explicit history selection.
  const { createConversationHistoryReader } =
    await import("../composables/conversation-history-reader");
  if (options.signal?.aborted) throw new HistoryReadCancelledError();
  const reader = createConversationHistoryReader(api).openSession(
    key,
    sessionId,
    session.revision
  );
  try {
    const streamBudget: ConversationHistoryStreamBudget = { receivedBytes: 0 };
    const metadata = clonePersistenceRecord(session.metadata);
    const inlineMetadataBytes = jsonByteLength(metadata);
    addActualBytes(streamBudget, inlineMetadataBytes);
    let declaredRecordBytes = Math.max(
      session.metadataByteLength ?? 0,
      inlineMetadataBytes +
        (session.metadataDetails ?? []).reduce(
          (total, reference) => total + reference.byteLength,
          0
        )
    );
    assertRecordCapacity(declaredRecordBytes);
    for (const reference of session.metadataDetails ?? []) {
      if (
        reference.path.length &&
        !RECORD_FIELDS.has(String(reference.path[0]))
      )
        continue;
      const value = await materializeForActiveController(
        reader,
        { ...reference, kind: "metadata" },
        streamBudget,
        options.signal
      );
      if (reference.path.length)
        setLoadedField(metadata, reference.path, value);
      else {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error(t("invalidHistoryMetadata"));
        for (const field of RECORD_FIELDS) {
          if (Object.hasOwn(value, field))
            setLoadedField(metadata, [field], value[field]!);
        }
      }
    }
    const messages: ConversationHistoryRecord[] = [];
    let afterPosition: number | undefined;
    for (;;) {
      const page = await reader.readMessages(
        { afterPosition, limit: 100 },
        options.signal
      );
      for (const message of page.messages) {
        let value = clonePersistenceRecord(message.value);
        const inlineMessageBytes = jsonByteLength(value);
        addActualBytes(streamBudget, inlineMessageBytes);
        declaredRecordBytes += Math.max(
          message.byteLength,
          inlineMessageBytes +
            message.details.reduce(
              (total, reference) => total + reference.byteLength,
              0
            )
        );
        assertRecordCapacity(declaredRecordBytes);
        for (const reference of message.details) {
          assertDetailCapacity(reference);
          const detail = await materializeForActiveController(
            reader,
            {
              ...reference,
              path: [...reference.path],
              messageId: message.messageId
            },
            streamBudget,
            options.signal
          );
          if (reference.path.length)
            setLoadedField(value, reference.path, detail);
          else {
            if (!detail || typeof detail !== "object" || Array.isArray(detail))
              throw new Error(t("invalidHistoryMessageFormat"));
            value = detail;
          }
        }
        if (value.id !== message.messageId)
          throw new Error(
            t("historyMessageIdentifiersDoNotMatchTheCurrentConversation")
          );
        messages.push(value);
      }
      if (page.nextPosition === null) break;
      if (afterPosition !== undefined && page.nextPosition <= afterPosition)
        throw new Error(t("theHistoryPaginationCursorDidNotAdvance"));
      afterPosition = page.nextPosition;
    }
    const confirmed = await awaitHistoryResponse(
      api.session({ key, sessionId, maxBytes: 4096 }),
      [options.signal]
    );
    if (
      !confirmed ||
      confirmed.revision !== session.revision ||
      confirmed.generation !== session.generation ||
      (confirmed.deleted && !options.allowDeleted)
    )
      throw new HistoryReadConflictError(
        session.revision,
        confirmed?.revision ?? -1
      );
    if (messages.length !== session.messageCount)
      throw new Error(
        t("historyMessageCountValidationFailedTheCurrentConversationHas")
      );
    const record = parsePersistenceRecord({ ...metadata, sessionId, messages });
    if (!record)
      throw new Error(t("conversationHistoryCouldNotBeFullyReadTheOriginal"));
    return record;
  } finally {
    reader.dispose();
  }
}
