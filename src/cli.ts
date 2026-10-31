#!/usr/bin/env node

import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { getLanIp } from "./net.js";
import { createApp } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

const subcommand = argv[0] === "listen" ? "listen" : "host";

if (subcommand === "listen") {
  runListen(argv.slice(1));
} else {
  runHost(argv);
}

function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && args[i + 1]) return args[i + 1];
  }
  return undefined;
}

function hasFlag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a));
}

function runHost(args: string[]): void {
  if (hasFlag(args, "--help", "-h")) {
    console.log(`
localdrop [options]

Share files and text between devices on the same network.
Create password-protected rooms for group sharing.

Options:
  --port,  -p <port>   Server port (default: 7431)
  --dir,   -d <path>   Download directory (default: ~/Downloads/LocalDrop)
  --sync,  -s <path>   Project directory to sync with listeners
  --help,  -h          Show this help

Subcommands:
  listen               Connect to a host and listen for commands
`);
    process.exit(0);
  }

  const port = parseInt(flag(args, "--port", "-p") ?? "7431", 10);
  const dir = resolve(flag(args, "--dir", "-d") ?? resolve(homedir(), "Downloads", "LocalDrop"));
  const syncDir = flag(args, "--sync", "-s");

  const ip = getLanIp();
  const url = `http://${ip}:${port}`;
  const app = createApp(dir, syncDir ? resolve(syncDir) : undefined);

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
    console.log();
    console.log("  LocalDrop is running");
    console.log();
    console.log(`  Saving files to: ${dir}`);
    if (syncDir) console.log(`  Sync dir: ${resolve(syncDir)}`);
    console.log();
    console.log(`  ${url}`);
    console.log();
    qrcode.generate(url, { small: true }, (code: string) => {
      for (const line of code.split("\n")) {
        console.log("  " + line);
      }
      console.log();
      console.log("  Open the URL or scan the QR code on any device.");
      console.log("  Create a room to start sharing.");
      if (syncDir) {
        console.log(`  Sync enabled for: ${resolve(syncDir)}`);
      }
      console.log("  Press Ctrl+C to stop.\n");
    });
  });

}

async function runListen(args: string[]): Promise<void> {
  if (hasFlag(args, "--help", "-h")) {
    console.log(`
localdrop listen [options]

Connect to a LocalDrop host and listen for commands.

Options:
  --host        <url>       Host URL (e.g. http://192.168.1.11:7431)
  --room,    -r <id>        Room ID to join
  --password,-p <pass>      Room password
  --name,    -n <name>      This machine's name (required)
  --allow       <cmd,...>   Comma-separated allowlist of commands
  --timeout     <seconds>   Command timeout (default: 300)
  --full-access             Disable sandbox (full filesystem access)
  --help,    -h             Show this help
`);
    process.exit(0);
  }

  const host = flag(args, "--host");
  const roomId = flag(args, "--room", "-r");
  const password = flag(args, "--password", "-p");
  const name = flag(args, "--name", "-n");
  const allowRaw = flag(args, "--allow");
  const timeoutRaw = flag(args, "--timeout");
  const noSandbox = hasFlag(args, "--full-access");

  if (!host) { console.error("  --host is required"); process.exit(1); }
  if (!roomId) { console.error("  --room is required"); process.exit(1); }
  if (!password) { console.error("  --password is required"); process.exit(1); }
  if (!name) { console.error("  --name is required"); process.exit(1); }

  const allowlist = allowRaw ? allowRaw.split(",").map((s) => s.trim()) : [];
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) * 1000 : undefined;

  const { listen } = await import("./listen.js");
  await listen({ host, roomId, password, name, allowlist, timeoutMs, noSandbox });
}
