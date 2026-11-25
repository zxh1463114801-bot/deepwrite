import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { createRequire } from "node:module";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertElectronLaunchAllowed } from "../../tools/electron-launch-environment.mjs";

assertElectronLaunchAllowed();
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const output = join(directory, "built-worker-result.json");

if (!process.versions.electron) {
  const require = createRequire(import.meta.url);
  const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], {
    stdio: "inherit"
  });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    assert.equal(code, 0);
  } finally {
    clearTimeout(timeout);
  }
} else {
  const { app, BrowserWindow } = await import("electron");
  const profile = await mkdtemp(join(tmpdir(), "deepwrite-built-worker-"));
  const renderer = join(root, "apps/desktop/out/renderer");
  const htmlPath = join(renderer, `.worker-probe-${process.pid}.html`);
  app.setPath("userData", profile);
  void app.whenReady().then(async () => {
  let window;
  try {
    const index = await readFile(join(renderer, "index.html"), "utf8");
    const policy = index.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
    )?.[1];
    assert.ok(policy, "The production CSP must be preserved.");
    const loader = (await readdir(join(renderer, "assets"))).find((name) =>
      /^conversationHistoryRecordLoader-.*\.js$/.test(name)
    );
    assert.ok(loader);
    const loaderUrl = pathToFileURL(join(renderer, "assets", loader)).href;
    await writeFile(
      htmlPath,
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><title>Synthetic worker probe</title>`
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    await window.loadFile(htmlPath);
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const module = await import(${JSON.stringify(loaderUrl)});
        const load = Object.values(module).find((value) =>
          typeof value === "function" &&
          value.toString().includes("historyMessageCountValidationFailed")
        );
        if (!load) throw new Error("Built history loader export not found");
        let created = 0, terminated = 0;
        const OriginalWorker = globalThis.Worker;
        globalThis.Worker = class extends OriginalWorker {
          constructor(...args) { super(...args); created++; }
          terminate() { terminated++; return super.terminate(); }
        };
        const date = "2026-11-22T00:00:00.000Z";
        const body = "x".repeat(2 * 1024 * 1024);
        const tools = [{
          id: "synthetic-tool", name: "read", status: "completed",
          requestedAt: date, args: { body }, resultSummary: "synthetic"
        }];
        const detail = JSON.stringify(tools);
        const metadata = {
          sessionId: "synthetic-session", createdAt: date, updatedAt: date,
          draft: "", approvalMode: "request-approval", temperature: 0.7
        };
        const value = {
          id: "synthetic-message", role: "assistant", content: "synthetic",
          status: "completed", createdAt: date, toolCalls: []
        };
        const session = {
          sessionId: metadata.sessionId, metadata, revision: 1,
          generation: 0, sequence: 0, deleted: false, messageCount: 1,
          byteLength: detail.length + 1024
        };
        const api = {
          session: async () => session,
          messages: async () => ({
            revision: 1, generation: 0, nextPosition: null,
            messages: [{
              messageId: value.id, position: 0, value,
              byteLength: detail.length + 512,
              details: [{ path: ["toolCalls"], encoding: "json", byteLength: detail.length }]
            }]
          }),
          detail: async ({offset = 0, maxBytes}) => {
            const chunk = detail.slice(offset, offset + maxBytes);
            const next = offset + chunk.length;
            return {
              revision: 1, encoding: "json", totalBytes: detail.length,
              chunk, nextOffset: next < detail.length ? next : null
            };
          }
        };
        const started = performance.now();
        const record = await load(api, "conversation-history:synthetic", metadata.sessionId);
        const restored = record.messages[0].toolCalls[0].args.body;
        if (restored !== body || created !== 1 || terminated !== 1)
          throw new Error("Built worker did not complete and terminate correctly");
        return {
          passed: true, transport: "file:", productionCsp: true,
          restoredBytes: restored.length, workersCreated: created,
          workersTerminated: terminated,
          elapsedMs: Math.round((performance.now() - started) * 10) / 10
        };
      })()
    `);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
    window.destroy();
    window = undefined;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await rm(htmlPath, { force: true });
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
    await rm(profile, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 100
    }).catch(() => undefined);
    app.exit(process.exitCode ?? 0);
  }
  });
}
