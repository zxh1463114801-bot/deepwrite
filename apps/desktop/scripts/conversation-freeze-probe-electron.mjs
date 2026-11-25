import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [, , output, url] = process.argv;
const profile = process.env.DEEPWRITE_FREEZE_PROBE_PROFILE;
if (!profile) throw new Error("Provide an isolated Electron profile path.");
app.setPath("userData", profile);

void app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      show: false,
      webPreferences: { backgroundThrottling: false }
    });
    const rendererErrors = [];
    win.webContents.on("console-message", (event) => {
      if (event.level !== "error") return;
      const message = event.message.slice(0, 1_000);
      rendererErrors.push(message);
      if (rendererErrors.length <= 5) console.error(message);
    });
    const execute = (script, timeoutMs = 45_000) =>
      Promise.race([
        win.webContents.executeJavaScript(script),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Freeze probe operation timeout")),
            timeoutMs
          );
          timer.unref();
        })
      ]);
    try {
      await win.loadURL(url);
      await execute(
        "new Promise((resolve, reject) => { const deadline = Date.now() + 15000; const timer = setInterval(() => { if (window.runConversationFreezeProbe) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Freeze fixture load timeout')); } }, 10); })"
      );
      const capture = async (name) => {
        await execute(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
        );
        await writeFile(
          join(dirname(output), name),
          (await win.capturePage()).toPNG()
        );
      };
      await capture("01-probe-entry.png");
      const result = await execute("runConversationFreezeProbe()", 120_000);
      result.versions = {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform
      };
      await capture("02-probe-results.png");
      await execute("document.querySelector('#freeze-probe-style').remove()");
      await execute(
        `(() => { const style = document.createElement('style'); style.textContent = 'html,body,#app{margin:0;width:100%;height:100%}#app>.conversation-pane{height:100%}'; document.head.append(style); })()`
      );
      await execute(
        "import('/scripts/fixtures/conversation-vue-probe.ts').then(() => true)"
      );
      const uiSetup = await execute("prepareVueProbe(100, true)");
      await execute(
        `document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;right:12px;top:12px;z-index:9999;background:#17202a;color:white;padding:6px 12px;font:14px Segoe UI">Synthetic renderer smoke · 100 turns</div>')`
      );
      await capture("03-conversation-streaming.png");
      const uiMetrics = await execute("measureVueProbe()", 120_000);
      if (
        Math.abs(uiMetrics.lockedDelta) > 1 ||
        Math.abs(uiMetrics.navigationOffset - 22) > 2
      )
        throw new Error(
          `Conversation scroll/navigation smoke failed: ${JSON.stringify(uiMetrics)}`
        );
      result.conversationUi = {
        synthetic: true,
        hiddenWindow: true,
        frameMetricScope:
          "Observed hidden-window scheduling; no foreground FPS claim.",
        ...uiSetup,
        ...uiMetrics
      };
      await capture("04-conversation-navigation.png");
      if (rendererErrors.length)
        throw new Error(
          `Renderer errors during freeze probe: ${rendererErrors.join("; ")}`
        );
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
      await writeFile(
        output.replace(/\.json$/, ".png"),
        (await win.capturePage()).toPNG()
      );
      console.log(
        `Conversation freeze probe passed: ${result.samples.length} scales`
      );
    } finally {
      win.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
