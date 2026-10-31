import { spawn } from "node:child_process";

export interface SandboxConfig {
  allowlist: string[];
  timeoutMs: number;
}

const DEFAULT_CONFIG: SandboxConfig = {
  allowlist: [],
  timeoutMs: 5 * 60 * 1000,
};

export function createSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    allowlist: overrides?.allowlist ?? DEFAULT_CONFIG.allowlist,
    timeoutMs: overrides?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
  };
}

export function isAllowed(command: string, config: SandboxConfig): boolean {
  if (config.allowlist.length === 0) return true;
  return config.allowlist.some((pattern) => command.startsWith(pattern));
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execInSandbox(
  command: string,
  cwd: string,
  config: SandboxConfig,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd" : "/bin/sh";
    const shellArgs = isWin ? ["/c", command] : ["-c", command];

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(shell, shellArgs, { cwd, stdio: "pipe" });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 512) stdout = stdout.slice(-1024 * 256);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 512) stderr = stderr.slice(-1024 * 256);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n" + err.message, timedOut: false });
    });
  });
}
