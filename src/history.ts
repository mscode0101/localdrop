import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface TextMessage {
  type: "text";
  id: string;
  text: string;
  timestamp: number;
}

export interface FileMessage {
  type: "file";
  id: string;
  name: string;
  path: string;
  size: number;
  timestamp: number;
}

export type Message = TextMessage | FileMessage;

const MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 1024 * 1024;

let messages: Message[] = [];
let historyPath: string | null = null;

export async function initHistory(filePath: string): Promise<void> {
  historyPath = filePath;
  await mkdir(dirname(filePath), { recursive: true });

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        // skip corrupted lines
      }
    }
    if (messages.length > MAX_ENTRIES) {
      messages = messages.slice(-MAX_ENTRIES);
      compact();
    }
  }
}

function compact(): void {
  if (!historyPath) return;
  const data = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  writeFileSync(historyPath, data, "utf-8");
}

function appendEntry(msg: Message): void {
  if (!historyPath) return;
  appendFileSync(historyPath, JSON.stringify(msg) + "\n", "utf-8");

  try {
    const stat = existsSync(historyPath)
      ? readFileSync(historyPath).byteLength
      : 0;
    if (stat > MAX_FILE_BYTES) compact();
  } catch {
    // not critical
  }
}

export function getMessages(): Message[] {
  return messages;
}

export function getMessage(id: string): Message | undefined {
  return messages.find((m) => m.id === id);
}

export function addTextMessage(text: string): TextMessage {
  const msg: TextMessage = {
    type: "text",
    id: randomBytes(8).toString("hex"),
    text,
    timestamp: Date.now(),
  };
  messages.push(msg);
  if (messages.length > MAX_ENTRIES) {
    messages.shift();
    compact();
  } else {
    appendEntry(msg);
  }
  return msg;
}

export function addFileMessage(
  name: string,
  path: string,
  size: number,
): FileMessage {
  const msg: FileMessage = {
    type: "file",
    id: randomBytes(8).toString("hex"),
    name,
    path,
    size,
    timestamp: Date.now(),
  };
  messages.push(msg);
  if (messages.length > MAX_ENTRIES) {
    messages.shift();
    compact();
  } else {
    appendEntry(msg);
  }
  return msg;
}

export function deleteMessage(id: string): boolean {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  messages.splice(idx, 1);
  compact();
  return true;
}
