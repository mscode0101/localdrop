import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ListenerConfig {
  allowlist: string[];
  sandbox: boolean;
  timeout: number;
}

const CONFIG_DIR = join(homedir(), ".localdrop");
const CONFIG_PATH = join(CONFIG_DIR, "listener.json");

const DEFAULTS: ListenerConfig = {
  allowlist: [],
  sandbox: true,
  timeout: 300,
};

export function loadConfig(): ListenerConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const data = JSON.parse(raw);
    return {
      allowlist: Array.isArray(data.allowlist) ? data.allowlist : DEFAULTS.allowlist,
      sandbox: typeof data.sandbox === "boolean" ? data.sandbox : DEFAULTS.sandbox,
      timeout: typeof data.timeout === "number" ? data.timeout : DEFAULTS.timeout,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: ListenerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addToAllowlist(command: string): void {
  const config = loadConfig();
  if (!config.allowlist.includes(command)) {
    config.allowlist.push(command);
    saveConfig(config);
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
