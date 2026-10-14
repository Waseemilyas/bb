import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { attachServerUpdateControl } from "../src/server-update-control.js";
import { startBbAppProcess } from "../src/bb-process.js";

describe("hosting desktop update control", () => {
  it.each(["direct", ...(process.platform === "linux" ? ["appimage"] : [])])(
    "updates the hosting app through the server and launcher IPC (%s)",
    async (runtimeKind) => {
      const root = await mkdtemp(join(tmpdir(), "bb-desktop-control-"));
      const bridgePath = join(root, "bridge.mjs");
      const relayUrl = pathToFileURL(
        join(__dirname, "../../../packages/config/src/desktop-app-update.ts"),
      ).href;
      const serverScript = `
        process.send({ channel: "bb-desktop-update/request", requestId: "status", action: "status" });
        process.on("message", (message) => {
          if (message.channel !== "bb-desktop-update/response") return;
          if (message.error !== null || message.info.version !== "1.0.0") process.exit(1);
          if (message.requestId === "status") {
            process.send({ channel: "bb-desktop-update/request", requestId: "install", action: "install" });
          } else {
            process.stdout.write("server update accepted");
            process.exit(0);
          }
        });
      `;
      await writeFile(
        bridgePath,
        `
        import { spawn } from "node:child_process";
        import { relayDesktopAppUpdates } from ${JSON.stringify(relayUrl)};
        const server = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(serverScript)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
        relayDesktopAppUpdates(server);
        server.on("exit", (code) => process.exit(code));
      `,
      );
      const child = startBbAppProcess({
        bridgePath,
        cwd: root,
        env: { ...process.env, APPDIR: root },
        logLineLimit: 50,
        runtime:
          runtimeKind === "appimage"
            ? {
                kind: "appimage",
                appDirPath: root,
                executablePath: process.execPath,
                mode: "electron-node",
              }
            : {
                kind: "direct",
                executablePath: process.execPath,
                mode: "node",
              },
      });
      const install = vi.fn(async () => undefined);
      const onError = vi.fn();
      attachServerUpdateControl({
        child: child.childProcess,
        getInfo: () => ({
          supported: true,
          version: "1.0.0",
          latestVersion: "1.1.0",
          pendingVersion: "1.1.0",
          updateAvailable: true,
          updateDownloaded: true,
          downloadState: "downloaded",
        }),
        check: async () => undefined,
        install,
        subscribe: () => () => undefined,
        onError,
      });
      try {
        const exit = await child.exit;
        expect(exit, child.logs.text()).toMatchObject({ code: 0 });
        expect(child.logs.text()).toContain("server update accepted");
        expect(install).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        await child.stop({
          signal: "SIGTERM",
          timeoutMs: 1_000,
          killSignal: "SIGKILL",
          killTimeoutMs: 1_000,
        });
        await rm(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
