import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { join } from "node:path";

export interface SandboxConfig {
  allowlist: string[];
  timeoutMs: number;
  jailDir: string | null;
}

export function createSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    allowlist: overrides?.allowlist ?? [],
    timeoutMs: overrides?.timeoutMs ?? 5 * 60 * 1000,
    jailDir: overrides?.jailDir ?? null,
  };
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-\w+\s+)*\/(?!tmp\b)/i, reason: "rm on system path" },
  { pattern: /\bmkfs\b/i, reason: "filesystem format" },
  { pattern: /\bdd\b.*\bof=\/dev/i, reason: "raw device write" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "system power control" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "disk format" },
  { pattern: /\bdel\s+.*\/s/i, reason: "recursive delete" },
  { pattern: /\brmdir\s+.*\/s/i, reason: "recursive rmdir" },
  { pattern: /curl\b.*\|\s*(sh|bash|zsh|powershell)/i, reason: "remote code execution" },
  { pattern: /wget\b.*\|\s*(sh|bash|zsh)/i, reason: "remote code execution" },
  { pattern: /\beval\s+.*\$\(curl/i, reason: "remote code execution" },
  { pattern: /\/etc\/(shadow|sudoers)/i, reason: "system credential access" },
  { pattern: /\.ssh\//i, reason: "SSH key access" },
  { pattern: /\.gnupg\//i, reason: "GPG key access" },
  { pattern: /\.aws\/credentials/i, reason: "AWS credential access" },
  { pattern: /\bnc\s+(-\w+\s+)*-l/i, reason: "network listener" },
  { pattern: /\blaunchctl\s+(load|submit)/i, reason: "persistence mechanism" },
  { pattern: /\bschtasks\s+\/create/i, reason: "persistence mechanism" },
  { pattern: /\bcrontab\s+-/i, reason: "persistence mechanism" },
];

export function isBlocked(command: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

const JAIL_ESCAPE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /~\//i, reason: "home directory access (~/) — use relative paths" },
  { pattern: /\$HOME\b/i, reason: "$HOME access — use relative paths" },
  { pattern: /\/(Users|home|root)\//i, reason: "absolute home path access" },
  { pattern: /\/(etc|var|opt|usr\/local\/etc)\//i, reason: "system config access" },
  { pattern: /\/(tmp|private\/tmp)\//i, reason: "temp directory access outside jail" },
  { pattern: /\.\.\//i, reason: "directory traversal (../)" },
];

export function isJailBreak(command: string, jailDir: string): string | null {
  for (const { pattern, reason } of JAIL_ESCAPE_PATTERNS) {
    if (pattern.test(command)) return reason;
  }

  const absPathMatch = command.match(/(?:^|\s)(\/\S+)/g);
  if (absPathMatch) {
    for (const match of absPathMatch) {
      const path = match.trim();
      const resolved = resolve(path);
      if (!resolved.startsWith(jailDir) && !["/bin", "/usr", "/sbin", "/dev/null"].some(p => resolved.startsWith(p))) {
        return `absolute path outside jail: ${path}`;
      }
    }
  }

  return null;
}

export function isAllowed(command: string, config: SandboxConfig): boolean {
  if (config.allowlist.length === 0) return true;
  return config.allowlist.some((pattern) => command.startsWith(pattern));
}

function buildRestrictedEnv(jailDir: string): NodeJS.ProcessEnv {
  const isWin = process.platform === "win32";
  const env: NodeJS.ProcessEnv = {};

  if (isWin) {
    const systemRoot = process.env.SYSTEMROOT || "C:\\Windows";
    const keepPaths = (process.env.PATH ?? "").split(";").filter(p =>
      /\\(node|npm|git|python)/i.test(p) ||
      p.toLowerCase().includes("\\system32") ||
      p.toLowerCase() === systemRoot.toLowerCase()
    );
    env.PATH = [...new Set(keepPaths)].join(";");
    env.SYSTEMROOT = systemRoot;
    env.COMSPEC = process.env.COMSPEC;
    env.TEMP = jailDir;
    env.TMP = jailDir;
    env.USERPROFILE = jailDir;
    env.APPDATA = join(jailDir, ".appdata");
  } else {
    const keepPaths = (process.env.PATH ?? "").split(":").filter(p =>
      /node|npm|nvm|\.local\/bin/i.test(p) ||
      ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].includes(p)
    );
    env.PATH = [...new Set(keepPaths)].join(":");
    env.TMPDIR = jailDir;
    env.HOME = jailDir;
  }

  env.LANG = process.env.LANG;
  env.TERM = process.env.TERM;
  env.LOCALDROP_SANDBOX = "1";
  return env;
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
    const env = config.jailDir ? buildRestrictedEnv(config.jailDir) : undefined;

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: "pipe",
      ...(env ? { env } : {}),
    });

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
