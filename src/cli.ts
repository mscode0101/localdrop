#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { getLanIp, generateToken } from "./net.js";
import { initHistory, addFileMessage } from "./history.js";
import { createApp } from "./server.js";

function parseArgs(argv: string[]): {
  files: string[];
  port: number;
  dir: string;
} {
  const files: string[] = [];
  let port = 7431;
  let dir = resolve(homedir(), "Downloads", "LocalDrop");

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const val = argv[++i];
      if (val) port = parseInt(val, 10);
    } else if (arg === "--dir" || arg === "-d") {
      const val = argv[++i];
      if (val) dir = resolve(val);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
localdrop [files...] [options]

Share files between devices on the same network.

Options:
  --port, -p <port>   Server port (default: 7431)
  --dir,  -d <path>   Download directory (default: ~/Downloads/LocalDrop)
  --help, -h          Show this help
`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      files.push(resolve(arg));
    }
  }

  return { files, port, dir };
}

const { files, port, dir } = parseArgs(process.argv.slice(2));

for (const f of files) {
  if (!existsSync(f)) {
    console.error(`File not found: ${f}`);
    process.exit(1);
  }
}

const historyFile = resolve(homedir(), ".localdrop", "history.jsonl");
await initHistory(historyFile);

for (const f of files) {
  const name = basename(f);
  const size = statSync(f).size;
  addFileMessage(name, f, size);
}

const token = generateToken();
const ip = getLanIp();
const url = `http://${ip}:${port}/?t=${token}`;

const app = createApp(token, dir);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log();
  console.log("  LocalDrop is running");
  console.log();
  if (files.length > 0) {
    console.log(`  Sharing ${files.length} file(s)`);
  }
  console.log(`  Receiving to: ${dir}`);
  console.log();
  console.log(url);
  console.log();
  qrcode.generate(url, { small: true }, (code: string) => {
    for (const line of code.split("\n")) {
      console.log("  " + line);
    }
    console.log();
    console.log("  Scan the QR code or open the URL on your phone.");
    console.log("  Press Ctrl+C to stop.\n");
  });
});
