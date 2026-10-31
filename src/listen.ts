import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createSandboxConfig, isAllowed, execInSandbox, type SandboxConfig } from "./sandbox.js";
import { applySync, type SyncFile } from "./sync.js";

interface ListenOptions {
  host: string;
  roomId: string;
  password: string;
  name: string;
  allowlist?: string[];
  timeoutMs?: number;
}

function getMirrorDir(roomId: string): string {
  const dir = join(homedir(), ".localdrop", "mirror", roomId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function joinRoom(
  host: string,
  roomId: string,
  password: string,
  nickname: string,
): Promise<string> {
  const res = await fetch(`${host}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, nickname }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Join failed: ${res.status}`);
  }
  const cookie = res.headers.get("set-cookie");
  const match = cookie?.match(new RegExp(`ld_${roomId}=([^;]+)`));
  if (!match) throw new Error("No auth cookie received");
  return match[1];
}

function makeHeaders(roomId: string, token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `ld_${roomId}=${token}`,
  };
}

async function postResult(
  host: string,
  roomId: string,
  token: string,
  commandId: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): Promise<void> {
  await fetch(`${host}/api/rooms/${roomId}/system/result`, {
    method: "POST",
    headers: makeHeaders(roomId, token),
    body: JSON.stringify({ commandId, exitCode, stdout, stderr }),
  });
}

async function postStatus(
  host: string,
  roomId: string,
  token: string,
  commandId: string,
  status: string,
): Promise<void> {
  await fetch(`${host}/api/rooms/${roomId}/system/status`, {
    method: "POST",
    headers: makeHeaders(roomId, token),
    body: JSON.stringify({ commandId, status }),
  });
}

async function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function handleCommand(
  cmd: { id: string; run: string; sync: boolean; target: string | null },
  opts: ListenOptions,
  token: string,
  config: SandboxConfig,
  mirrorDir: string,
): Promise<void> {
  if (cmd.target && cmd.target !== opts.name) return;

  console.log(`\n  Command received: ${cmd.run}`);

  if (!isAllowed(cmd.run, config)) {
    console.log(`  Not in allowlist. Allow?`);
    console.log(`    [d]eny  [o]nce  [a]lways`);
    const answer = await promptUser("  > ");

    if (answer === "d" || answer === "deny") {
      await postStatus(opts.host, opts.roomId, token, cmd.id, "denied");
      await postResult(opts.host, opts.roomId, token, cmd.id, 1, "", "Denied by user");
      console.log("  Denied.");
      return;
    }
    if (answer === "a" || answer === "always") {
      config.allowlist.push(cmd.run);
      console.log(`  Added "${cmd.run}" to allowlist.`);
    }
  }

  if (cmd.sync) {
    console.log("  Syncing files...");
    try {
      const res = await fetch(`${opts.host}/api/rooms/${opts.roomId}/sync-files`, {
        headers: makeHeaders(opts.roomId, token),
      });
      if (res.ok) {
        const data = await res.json() as { files: SyncFile[] };
        applySync(mirrorDir, data.files);
        console.log(`  Synced ${data.files.length} files.`);
      }
    } catch (e) {
      console.error("  Sync failed:", (e as Error).message);
    }
  }

  await postStatus(opts.host, opts.roomId, token, cmd.id, "running");
  console.log("  Running...");

  const result = await execInSandbox(cmd.run, mirrorDir, config);

  if (result.timedOut) {
    console.log("  Timed out.");
  } else {
    console.log(`  Exit code: ${result.exitCode}`);
  }

  if (result.stdout) {
    const lines = result.stdout.trimEnd().split("\n");
    const preview = lines.slice(-5).map((l) => "    " + l).join("\n");
    console.log(preview);
  }

  if (result.stderr) {
    const lines = result.stderr.trimEnd().split("\n");
    const preview = lines.slice(-3).map((l) => "    " + l).join("\n");
    console.error(preview);
  }

  await postResult(
    opts.host, opts.roomId, token, cmd.id,
    result.timedOut ? null : result.exitCode,
    result.stdout,
    result.stderr + (result.timedOut ? "\n[timed out]" : ""),
  );
}

function connectSSE(
  host: string,
  roomId: string,
  token: string,
  onCommand: (cmd: { id: string; run: string; sync: boolean; target: string | null }) => void,
): void {
  const url = `${host}/api/rooms/${roomId}/events`;

  const connect = async () => {
    try {
      const res = await fetch(url, {
        headers: { Cookie: `ld_${roomId}=${token}` },
      });
      if (!res.ok || !res.body) {
        console.error("  SSE connection failed, retrying in 3s...");
        setTimeout(connect, 3000);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const eventMatch = part.match(/^event: (.+)$/m);
          const dataMatch = part.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;

          if (eventMatch[1] === "system") {
            try {
              const msg = JSON.parse(dataMatch[1]);
              if (msg.type === "command" && msg.status === "pending") {
                onCommand(msg);
              }
            } catch {}
          }
        }
      }

      console.log("  SSE disconnected, reconnecting in 3s...");
      setTimeout(connect, 3000);
    } catch {
      console.error("  SSE error, retrying in 3s...");
      setTimeout(connect, 3000);
    }
  };

  connect();
}

export async function listen(opts: ListenOptions): Promise<void> {
  const mirrorDir = getMirrorDir(opts.roomId);
  const config = createSandboxConfig({
    allowlist: opts.allowlist ?? [],
    timeoutMs: opts.timeoutMs,
  });

  console.log();
  console.log(`  Connecting to ${opts.host}...`);

  let token: string;
  try {
    token = await joinRoom(opts.host, opts.roomId, opts.password, opts.name);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`  Connected to room ${opts.roomId} as "${opts.name}"`);
  console.log(`  Mirror dir: ${mirrorDir}`);
  console.log(`  Allowlist: ${config.allowlist.length === 0 ? "any command (open)" : config.allowlist.join(", ")}`);
  console.log(`  Timeout: ${Math.round(config.timeoutMs / 1000)}s`);
  console.log();
  console.log("  Listening for commands... (Ctrl+C to stop)");

  const queue: Array<{ id: string; run: string; sync: boolean; target: string | null }> = [];
  let processing = false;

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const cmd = queue.shift()!;
      await handleCommand(cmd, opts, token, config, mirrorDir);
    }
    processing = false;
  };

  connectSSE(opts.host, opts.roomId, token, (cmd) => {
    queue.push(cmd);
    processQueue();
  });
}
