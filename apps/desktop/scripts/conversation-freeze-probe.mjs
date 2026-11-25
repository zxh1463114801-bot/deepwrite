import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { createServer } from "vite";

import { assertElectronLaunchAllowed } from "../../../tools/electron-launch-environment.mjs";

assertElectronLaunchAllowed();

const output = process.argv[2];
if (!output) throw new Error("Provide a JSON result path.");

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopRoot = resolve(workspaceRoot, "apps/desktop");
const cacheDir = await mkdtemp(join(tmpdir(), "deepwrite-freeze-probe-vite-"));
const profileDir = await mkdtemp(join(tmpdir(), "deepwrite-freeze-profile-"));
const require = createRequire(import.meta.url);
const server = await createServer({
  root: desktopRoot,
  cacheDir,
  publicDir: resolve(desktopRoot, "src/renderer/public"),
  configFile: false,
  plugins: [vue()],
  optimizeDeps: {
    entries: [
      resolve(desktopRoot, "scripts/fixtures/conversation-freeze-probe.html"),
      resolve(desktopRoot, "scripts/fixtures/conversation-vue-probe.html")
    ],
    include: ["vue", "pinia", "vue-i18n", "naive-ui"]
  },
  server: {
    port: 0,
    hmr: false,
    watch: { ignored: ["**/out/**", "**/.git/**"] }
  },
  resolve: {
    dedupe: ["vue"],
    alias: [
      {
        find: /^@deepwrite\/contracts\/renderer$/,
        replacement: resolve(
          workspaceRoot,
          "packages/contracts/src/renderer.ts"
        )
      },
      {
        find: /^@deepwrite\/contracts$/,
        replacement: resolve(
          workspaceRoot,
          "packages/contracts/src/renderer.ts"
        )
      },
      {
        find: /^@deepwrite\/contracts\/system$/,
        replacement: resolve(workspaceRoot, "packages/contracts/src/system.ts")
      },
      {
        find: "@deepwrite/shared",
        replacement: resolve(workspaceRoot, "packages/shared/src/index.ts")
      }
    ]
  }
});

try {
  await mkdir(dirname(resolve(output)), { recursive: true });
  await rm(output, { force: true });
  await server.listen();
  const url = new URL(
    "scripts/fixtures/conversation-freeze-probe.html",
    server.resolvedUrls.local[0]
  );
  const child = spawn(
    require("electron"),
    [
      fileURLToPath(
        new URL("conversation-freeze-probe-electron.mjs", import.meta.url)
      ),
      resolve(output),
      url.href
    ],
    {
      stdio: "inherit",
      env: { ...process.env, DEEPWRITE_FREEZE_PROBE_PROFILE: profileDir }
    }
  );
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal)
        reject(new Error(`Electron freeze probe terminated by ${signal}`));
      else resolveExit(exitCode ?? 1);
    });
  });
  if (code !== 0) {
    console.error(`Electron freeze probe exited with code ${code}.`);
    process.exitCode = Number(code);
  } else {
    const result = JSON.parse(await readFile(output, "utf8"));
    if (result?.passed !== true)
      throw new Error("Electron freeze probe did not report success.");
  }
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
  await rm(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
}
