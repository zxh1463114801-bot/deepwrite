import { computed, nextTick, ref } from "vue";
import { createTrackedMessages } from "../../src/renderer/src/composables/agent-conversation/message-mutations";
import type { AgentConversationController } from "../../src/renderer/src/composables/useAgentConversation";
import { trackExternalRun } from "../../src/renderer/src/extras/external-control/tracked-run";
import type { ChatMessage } from "../../src/renderer/src/types/conversation";
import type {
  ConversationHistoryReadSession,
  HistoryDetailTarget
} from "../../src/renderer/src/composables/conversation-history-reader";
import {
  materializeConversationHistoryDetail,
  MAX_CONVERSATION_HISTORY_DETAIL_BYTES,
  MAX_CONVERSATION_HISTORY_RECORD_BYTES
} from "../../src/renderer/src/utils/conversationHistoryDetailMaterializer";

declare global {
  interface Window {
    runConversationFreezeProbe(): Promise<FreezeProbeResult>;
  }
}

interface SampleResult {
  nestedObjects: number;
  updateAverageMs: number;
  updateP95Ms: number;
  heartbeatP95Ms: number;
  heartbeatMaxMs: number;
  nestedPayloadReads: number;
  toolUsage: { total: number; succeeded: number; pending: number };
  statuses: string[];
  terminalReply: string;
}

interface FreezeProbeResult {
  passed: boolean;
  synthetic: true;
  iterations: number;
  thresholds: { updateP95Ms: number; heartbeatMaxMs: number };
  samples: SampleResult[];
  lifecycle: Record<string, string>;
  worker: Awaited<ReturnType<typeof runWorkerProbe>>;
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <main>
    <header>
      <p>DeepWrite renderer diagnostic</p>
      <h1>Conversation responsiveness</h1>
      <span id="summary">Preparing synthetic histories...</span>
    </header>
    <section class="states" aria-label="Run lifecycle">
      <article><span class="dot running"></span><b>Running</b><small>Streaming reply updates</small></article>
      <article><span class="dot waiting"></span><b>Waiting</b><small>User input is pending</small></article>
      <article><span class="dot completed"></span><b>Completed</b><small>Terminal result is frozen</small></article>
    </section>
    <section class="table-section">
      <table>
        <thead><tr><th>Nested objects</th><th>Update avg</th><th>Update P95</th><th>Heartbeat max</th><th>Payload reads</th><th>Result</th></tr></thead>
        <tbody id="results"></tbody>
      </table>
    </section>
    <footer>Isolated synthetic Electron probe. No user conversation data is loaded.</footer>
  </main>
`;

const style = document.createElement("style");
style.id = "freeze-probe-style";
style.textContent = `
  :root { color: #17202a; background: #eef2f5; font: 14px/1.45 Inter, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 720px; }
  main { width: min(1040px, calc(100% - 48px)); margin: 32px auto; background: #fff; border: 1px solid #d8dee5; border-radius: 8px; box-shadow: 0 12px 34px rgba(24, 34, 45, .1); overflow: hidden; }
  header { padding: 28px 32px 24px; border-bottom: 1px solid #e4e8ec; }
  header p { margin: 0 0 6px; color: #52606d; font-size: 12px; font-weight: 700; text-transform: uppercase; }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
  #summary { color: #52606d; }
  .states { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #e4e8ec; border-bottom: 1px solid #e4e8ec; }
  article { display: grid; grid-template-columns: 18px 1fr; gap: 2px 10px; padding: 18px 24px; background: #f9fafb; }
  article small { grid-column: 2; color: #687684; }
  .dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; }
  .running { background: #1677ff; } .waiting { background: #d97706; } .completed { background: #17803d; }
  .table-section { padding: 24px 32px 28px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 12px 10px; border-bottom: 1px solid #e6eaee; text-align: right; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #52606d; font-size: 12px; }
  .pass { color: #17803d; font-weight: 700; }
  footer { padding: 14px 32px; background: #f5f7f9; color: #687684; font-size: 12px; }
`;
document.head.append(style);

const percentile = (values: number[], ratio = 0.95) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
  ]!;
};

function syntheticHistory(count: number, payloadReads: { value: number }) {
  const toolCalls = Array.from({ length: Math.ceil(count / 2) }, (_, index) => {
    const item = {
      id: `archived-tool-${index}`,
      name: "synthetic_read",
      status: "completed",
      requestedAt: "2026-11-22T00:00:00.000Z",
      completedAt: "2026-11-22T00:00:01.000Z"
    } as Record<string, unknown>;
    Object.defineProperty(item, "args", {
      enumerable: true,
      get() {
        payloadReads.value += 1;
        return { synthetic: true, index, text: "x".repeat(64) };
      }
    });
    return item;
  });
  const modelCalls = Array.from(
    { length: Math.floor(count / 2) },
    (_, index) => {
      const item = {
        id: `archived-model-${index}`,
        status: "completed",
        startedAt: "2026-11-22T00:00:00.000Z",
        completedAt: "2026-11-22T00:00:01.000Z"
      } as Record<string, unknown>;
      Object.defineProperty(item, "request", {
        enumerable: true,
        get() {
          payloadReads.value += 1;
          return { synthetic: true, index, messages: ["x".repeat(64)] };
        }
      });
      return item;
    }
  );
  return {
    id: "archived-assistant",
    role: "assistant",
    content: "synthetic archived reply",
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "completed",
    toolCalls,
    subagentRuns: [
      {
        parentToolCallId: "archived-parent",
        subagentRunId: "archived-subagent",
        subagentId: "synthetic",
        name: "Synthetic",
        task: "Synthetic renderer probe",
        status: "completed",
        runtime: { providerId: "synthetic", modelId: "synthetic" },
        toolCalls: [],
        processingSteps: [],
        startedAt: "2026-11-22T00:00:00.000Z",
        modelCalls
      }
    ]
  } as unknown as ChatMessage;
}

async function runSample(nestedObjects: number): Promise<SampleResult> {
  const payloadReads = { value: 0 };
  const assistant: ChatMessage = {
    id: "current-assistant",
    runId: "current-run",
    role: "assistant",
    content: "start",
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "streaming",
    toolCalls: [
      {
        id: "current-tool",
        name: "synthetic_write",
        args: { synthetic: true },
        status: "running",
        requestedAt: "2026-11-22T00:00:00.000Z"
      }
    ]
  };
  const trackedMessages = createTrackedMessages([
    syntheticHistory(nestedObjects, payloadReads),
    assistant
  ]);
  const activeRunId = ref<string | null>("current-run");
  const sessionId = ref("synthetic-session");
  const busy = ref(true);
  const pendingUserInput = ref<unknown>(null);
  const conversation = {
    messages: trackedMessages.messages,
    activeRunId,
    sessionId,
    pendingUserInput,
    isBusy: computed(() => busy.value)
  } as unknown as AgentConversationController;
  const current = trackedMessages.findById("current-assistant")!;
  const run = trackExternalRun("external-run", conversation, current);
  const updateCosts: number[] = [];
  const heartbeatGaps: number[] = [];
  let lastHeartbeat = performance.now();
  const heartbeat = window.setInterval(() => {
    const now = performance.now();
    heartbeatGaps.push(now - lastHeartbeat);
    lastHeartbeat = now;
  }, 4);
  const statuses = [run.snapshot().status];
  try {
    for (let index = 0; index < 60; index += 1) {
      const started = performance.now();
      trackedMessages.appendText(current, "content", ` synthetic-${index}`);
      await nextTick();
      const snapshot = run.snapshot();
      if (!snapshot.reply.endsWith(`synthetic-${index}`))
        throw new Error("Live reply snapshot did not include the latest text.");
      updateCosts.push(performance.now() - started);
      if (index % 10 === 0)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
    }

    pendingUserInput.value = {
      source: "ask_user_question",
      questions: [{ id: "synthetic-question", question: "Continue?" }]
    };
    await nextTick();
    statuses.push(run.snapshot().status);

    pendingUserInput.value = null;
    current.toolCalls![0]!.status = "completed";
    current.toolCalls![0]!.completedAt = "2026-11-22T00:00:01.000Z";
    current.status = "completed";
    activeRunId.value = null;
    busy.value = false;
    await nextTick();
    const completed = run.snapshot();
    statuses.push(completed.status);
    const terminalReply = completed.reply;
    trackedMessages.appendText(current, "content", " ignored-after-terminal");
    await nextTick();
    if (run.snapshot().reply !== terminalReply)
      throw new Error("Terminal snapshot changed after completion.");

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const result: SampleResult = {
      nestedObjects,
      updateAverageMs:
        updateCosts.reduce((total, value) => total + value, 0) /
        updateCosts.length,
      updateP95Ms: percentile(updateCosts),
      heartbeatP95Ms: percentile(heartbeatGaps),
      heartbeatMaxMs: Math.max(...heartbeatGaps),
      nestedPayloadReads: payloadReads.value,
      toolUsage: completed.toolUsage ?? { total: 0, succeeded: 0, pending: 0 },
      statuses,
      terminalReply
    };
    if (result.nestedPayloadReads !== 0)
      throw new Error(
        `Historical nested payloads were traversed ${result.nestedPayloadReads} times.`
      );
    if (result.updateP95Ms > 40)
      throw new Error(`Update P95 exceeded 40ms: ${result.updateP95Ms}`);
    if (result.heartbeatMaxMs > 120)
      throw new Error(`Heartbeat gap exceeded 120ms: ${result.heartbeatMaxMs}`);
    if (result.statuses.join(",") !== "running,waiting_for_input,completed")
      throw new Error(`Unexpected lifecycle: ${result.statuses.join(",")}`);
    if (
      result.toolUsage.total !== 1 ||
      result.toolUsage.succeeded !== 1 ||
      result.toolUsage.pending !== 0
    )
      throw new Error(
        `Unexpected tool usage: ${JSON.stringify(result.toolUsage)}`
      );
    return result;
  } finally {
    clearInterval(heartbeat);
    run.dispose();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runLifecycleProbe() {
  const outcomes: Record<string, string> = {};
  for (const scenario of [
    "stopped",
    "error",
    "write_approval",
    "proposal_review",
    "session_switch",
    "removed"
  ] as const) {
    const tracked = createTrackedMessages([
      {
        id: "lifecycle-assistant",
        runId: "lifecycle-run",
        role: "assistant",
        content: "Synthetic lifecycle reply",
        createdAt: "2026-11-22T00:00:00.000Z",
        status: "streaming"
      }
    ]);
    const current = tracked.findById("lifecycle-assistant")!;
    const activeRunId = ref<string | null>("lifecycle-run");
    const sessionId = ref("lifecycle-session");
    const pendingUserInput = ref<unknown>(null);
    const busy = ref(true);
    const conversation = {
      messages: tracked.messages,
      activeRunId,
      sessionId,
      pendingUserInput,
      isBusy: computed(() => busy.value)
    } as unknown as AgentConversationController;
    const run = trackExternalRun(
      "external-lifecycle-run",
      conversation,
      current
    );
    try {
      if (scenario === "write_approval")
        pendingUserInput.value = { source: "write_approval", questions: [] };
      else if (scenario === "proposal_review") {
        current.editProposals = [
          {
            id: "synthetic-proposal",
            status: "pending",
            title: "Synthetic proposal"
          }
        ] as ChatMessage["editProposals"];
        activeRunId.value = null;
        busy.value = false;
      } else if (scenario === "session_switch")
        sessionId.value = "other-synthetic-session";
      else if (scenario === "removed") tracked.messages.value = [];
      else {
        current.status = scenario;
        if (scenario === "error") current.errorMessage = "Synthetic failure";
        activeRunId.value = null;
        busy.value = false;
      }
      await nextTick();
      const expected = ["write_approval", "proposal_review"].includes(scenario)
        ? "waiting_for_user"
        : scenario === "stopped"
          ? "stopped"
          : "failed";
      assert(
        run.snapshot().status === expected,
        `Lifecycle ${scenario} should be ${expected}.`
      );
      outcomes[scenario] = run.snapshot().status;
      if (scenario === "write_approval") {
        pendingUserInput.value = null;
        await nextTick();
        assert(run.snapshot().status === "running", "Approval did not resume.");
        outcomes.approval_resumed = run.snapshot().status;
      } else if (scenario === "proposal_review") {
        current.editProposals![0]!.status = "accepted";
        current.status = "completed";
        await nextTick();
        assert(
          run.snapshot().status === "completed",
          "Accepted proposal did not finish."
        );
        outcomes.proposal_accepted = run.snapshot().status;
      }
    } finally {
      run.dispose();
    }
  }
  return outcomes;
}

async function runWorkerProbe() {
  const NativeWorker = window.Worker;
  const telemetry = {
    created: 0,
    terminated: 0,
    replies: 0,
    errors: 0,
    urls: [] as string[]
  };
  let cancelOnFinish: (() => void) | undefined;
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      telemetry.created += 1;
      telemetry.urls.push(String(url));
      this.addEventListener("message", () => {
        telemetry.replies += 1;
      });
      this.addEventListener("error", () => {
        telemetry.errors += 1;
      });
    }
    override postMessage(message: unknown) {
      super.postMessage(message);
      if ((message as { type?: string }).type === "finish" && cancelOnFinish) {
        const cancel = cancelOnFinish;
        cancelOnFinish = undefined;
        queueMicrotask(cancel);
      }
    }
    override terminate() {
      telemetry.terminated += 1;
      super.terminate();
    }
  }
  window.Worker = ObservedWorker;
  const messages = {
    detail: "Synthetic detail limit",
    total: "Synthetic total limit"
  };
  const readerFor = (text: string) =>
    ({
      async *streamDetail() {
        for (let offset = 0; offset < text.length; offset += 64 * 1024)
          yield { chunk: text.slice(offset, offset + 64 * 1024) };
      }
    }) as unknown as ConversationHistoryReadSession;
  const targetFor = (text: string, encoding: "json" | "text" = "json") =>
    ({
      messageId: "synthetic-worker-message",
      path: ["toolCalls", 0, "args"],
      byteLength: new TextEncoder().encode(text).byteLength,
      encoding
    }) satisfies HistoryDetailTarget;
  const expectError = async (operation: Promise<unknown>, expected: string) => {
    try {
      await operation;
    } catch (error) {
      const value = error as Error;
      assert(
        value.message.includes(expected) || value.name === expected,
        `Expected ${expected}, received ${value.name}: ${value.message}`
      );
      return value.name === "AbortError" ? value.name : value.message;
    }
    throw new Error(`Expected failure ${expected}.`);
  };
  try {
    const text = JSON.stringify({
      synthetic: true,
      rows: Array.from({ length: 8_000 }, (_, id) => ({
        id,
        text: "Synthetic payload ".repeat(12)
      }))
    });
    const budget = { receivedBytes: 0 };
    const start = performance.now();
    const value = await materializeConversationHistoryDetail(
      readerFor(text),
      targetFor(text),
      budget,
      messages
    );
    const successMs = performance.now() - start;
    assert(
      typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Array.isArray(value.rows) &&
        value.rows.length === 8_000,
      "Large Worker JSON result did not match synthetic input."
    );
    assert(telemetry.created === 1, "Large JSON did not create a real Worker.");
    assert(telemetry.terminated === 1, "Completed Worker was not released.");
    assert(
      budget.receivedBytes === targetFor(text).byteLength,
      "Byte budget mismatch."
    );
    const textPayload = "合成文本".repeat(80_000);
    const restoredText = await materializeConversationHistoryDetail(
      readerFor(textPayload),
      targetFor(textPayload, "text"),
      { receivedBytes: 0 },
      messages
    );
    assert(restoredText === textPayload, "Large Worker text result differed.");
    const abort = new AbortController();
    cancelOnFinish = () => abort.abort();
    const cancelled = await expectError(
      materializeConversationHistoryDetail(
        readerFor(text),
        targetFor(text),
        { receivedBytes: 0 },
        messages,
        abort.signal
      ),
      "AbortError"
    );
    assert(
      telemetry.created === 3,
      "Cancellation did not reach a real Worker."
    );
    assert(telemetry.terminated === 3, "Cancelled Worker was not released.");
    const parseFailure = await expectError(
      materializeConversationHistoryDetail(
        readerFor("[".repeat(300 * 1024)),
        targetFor("[".repeat(300 * 1024)),
        { receivedBytes: 0 },
        messages
      ),
      "could not be parsed"
    );
    const declaredDetailLimit = await expectError(
      materializeConversationHistoryDetail(
        readerFor(""),
        {
          ...targetFor(""),
          byteLength: MAX_CONVERSATION_HISTORY_DETAIL_BYTES + 1
        },
        { receivedBytes: 0 },
        messages
      ),
      messages.detail
    );
    const streamedDetailLimit = await expectError(
      materializeConversationHistoryDetail(
        readerFor("x".repeat(MAX_CONVERSATION_HISTORY_DETAIL_BYTES + 1)),
        targetFor(""),
        { receivedBytes: 0 },
        messages
      ),
      messages.detail
    );
    const totalLimit = await expectError(
      materializeConversationHistoryDetail(
        readerFor("synthetic"),
        targetFor("synthetic", "text"),
        { receivedBytes: MAX_CONVERSATION_HISTORY_RECORD_BYTES - 1 },
        messages
      ),
      messages.total
    );
    assert(
      telemetry.created === telemetry.terminated,
      "A Worker remains active."
    );
    assert(telemetry.errors === 0, "Worker emitted runtime errors.");
    return {
      passed: true,
      realWebWorker: true,
      bytes: budget.receivedBytes,
      successMs,
      cancelled,
      parseFailure,
      declaredDetailLimit,
      streamedDetailLimit,
      totalLimit,
      ...telemetry
    };
  } finally {
    window.Worker = NativeWorker;
  }
}

window.runConversationFreezeProbe = async () => {
  const samples: SampleResult[] = [];
  const results = document.querySelector<HTMLTableSectionElement>("#results")!;
  for (const nestedObjects of [100, 1_000, 5_000]) {
    const sample = await runSample(nestedObjects);
    samples.push(sample);
    results.insertAdjacentHTML(
      "beforeend",
      `<tr><td>${nestedObjects.toLocaleString()}</td><td>${sample.updateAverageMs.toFixed(2)} ms</td><td>${sample.updateP95Ms.toFixed(2)} ms</td><td>${sample.heartbeatMaxMs.toFixed(2)} ms</td><td>${sample.nestedPayloadReads}</td><td class="pass">Passed</td></tr>`
    );
  }
  const lifecycle = await runLifecycleProbe();
  const worker = await runWorkerProbe();
  document.querySelector("#summary")!.textContent =
    `Synthetic streams, stop/approval and real Worker checks passed (${worker.created} workers released).`;
  return {
    passed: true,
    synthetic: true,
    iterations: 60,
    thresholds: { updateP95Ms: 40, heartbeatMaxMs: 120 },
    samples,
    lifecycle,
    worker
  } satisfies FreezeProbeResult;
};
