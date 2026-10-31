#!/usr/bin/env node

import { resolve } from "node:path";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import qrcode from "qrcode-terminal";
import { getLanIp } from "./net.js";
import { createApp } from "./server.js";

function parseArgs(argv: string[]): { port: number; dir: string } {
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
localdrop [options]

Share files and text between devices on the same network.
Create password-protected rooms for group sharing.

Options:
  --port, -p <port>   Server port (default: 7431)
  --dir,  -d <path>   Download directory (default: ~/Downloads/LocalDrop)
  --help, -h          Show this help
`);
      process.exit(0);
    }
  }

  return { port, dir };
}

const { port, dir } = parseArgs(process.argv.slice(2));
const ip = getLanIp();
const url = `http://${ip}:${port}`;

const app = createApp(dir);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log();
  console.log("  LocalDrop is running");
  console.log();
  console.log(`  Saving files to: ${dir}`);
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
    console.log("  Press Ctrl+C to stop.\n");
  });
});
