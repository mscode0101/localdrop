import { createHash, randomBytes } from "node:crypto";

export interface TextMessage {
  type: "text";
  id: string;
  text: string;
  sender: string;
  timestamp: number;
}

export interface FileMessage {
  type: "file";
  id: string;
  name: string;
  path: string;
  size: number;
  sender: string;
  timestamp: number;
}

export type Message = TextMessage | FileMessage;

type SSEClient = {
  send: (event: string, data: string) => void;
  close: () => void;
};

interface TokenInfo {
  nickname: string;
  createdAt: number;
}

interface Room {
  id: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  tokens: Map<string, TokenInfo>;
  messages: Message[];
  sseClients: Set<SSEClient>;
}

const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hash(pw: string, salt: string): string {
  return createHash("sha256").update(salt + pw).digest("hex");
}

const rooms = new Map<string, Room>();

const joinAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function checkJoinRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = joinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    joinAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export function createRoom(
  name: string,
  password: string,
  nickname: string,
): { id: string; token: string } {
  const id = randomBytes(4).toString("hex");
  const token = randomBytes(16).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const tokens = new Map<string, TokenInfo>();
  tokens.set(token, { nickname, createdAt: Date.now() });
  rooms.set(id, {
    id,
    name: name.trim(),
    passwordHash: hash(password, salt),
    salt,
    createdAt: Date.now(),
    tokens,
    messages: [],
    sseClients: new Set(),
  });
  return { id, token };
}

export function listRooms(): Array<{
  id: string;
  name: string;
  online: number;
  createdAt: number;
}> {
  return Array.from(rooms.values()).map((r) => ({
    id: r.id,
    name: r.name,
    online: r.sseClients.size,
    createdAt: r.createdAt,
  }));
}

export function joinRoom(id: string, password: string, nickname: string): string | null {
  const room = rooms.get(id);
  if (!room || room.passwordHash !== hash(password, room.salt)) return null;
  const token = randomBytes(16).toString("hex");
  room.tokens.set(token, { nickname, createdAt: Date.now() });
  return token;
}

export function validateToken(roomId: string, token: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  const info = room.tokens.get(token);
  if (!info) return false;
  if (Date.now() - info.createdAt > TOKEN_MAX_AGE_MS) {
    room.tokens.delete(token);
    return false;
  }
  return true;
}

export function getNickname(roomId: string, token: string): string {
  return rooms.get(roomId)?.tokens.get(token)?.nickname ?? "Anonymous";
}

export function getRoomName(roomId: string): string | undefined {
  return rooms.get(roomId)?.name;
}

export function addSSEClient(roomId: string, client: SSEClient): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  room.sseClients.add(client);
  broadcast(roomId, "presence", { online: room.sseClients.size });
  return true;
}

export function removeSSEClient(roomId: string, client: SSEClient): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.sseClients.delete(client);
  broadcast(roomId, "presence", { online: room.sseClients.size });
}

export function broadcast(roomId: string, event: string, data: unknown): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const json = JSON.stringify(data);
  for (const client of room.sseClients) {
    client.send(event, json);
  }
}

export function stripPath(
  m: Message,
): Omit<TextMessage, never> | Omit<FileMessage, "path"> {
  if (m.type === "file") {
    const { path: _, ...rest } = m;
    return rest;
  }
  return m;
}

export function addTextMessage(
  roomId: string,
  text: string,
  sender: string,
): TextMessage | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg: TextMessage = {
    type: "text",
    id: randomBytes(8).toString("hex"),
    text,
    sender,
    timestamp: Date.now(),
  };
  room.messages.push(msg);
  return msg;
}

export function addFileMessage(
  roomId: string,
  name: string,
  path: string,
  size: number,
  sender: string,
): FileMessage | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg: FileMessage = {
    type: "file",
    id: randomBytes(8).toString("hex"),
    name,
    path,
    size,
    sender,
    timestamp: Date.now(),
  };
  room.messages.push(msg);
  return msg;
}

export function getMessages(roomId: string): Message[] {
  return rooms.get(roomId)?.messages ?? [];
}

export function getMessage(
  roomId: string,
  msgId: string,
): Message | undefined {
  return rooms.get(roomId)?.messages.find((m) => m.id === msgId);
}

export function deleteMessage(roomId: string, msgId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  const idx = room.messages.findIndex((m) => m.id === msgId);
  if (idx === -1) return false;
  room.messages.splice(idx, 1);
  return true;
}
