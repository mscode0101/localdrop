import { createHash, randomBytes } from "node:crypto";

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

type SSEClient = {
  send: (event: string, data: string) => void;
  close: () => void;
};

interface Room {
  id: string;
  name: string;
  passwordHash: string;
  createdAt: number;
  tokens: Set<string>;
  messages: Message[];
  sseClients: Set<SSEClient>;
}

function hash(pw: string): string {
  return createHash("sha256").update(pw).digest("hex");
}

const rooms = new Map<string, Room>();

export function createRoom(
  name: string,
  password: string,
): { id: string; token: string } {
  const id = randomBytes(4).toString("hex");
  const token = randomBytes(16).toString("hex");
  rooms.set(id, {
    id,
    name: name.trim(),
    passwordHash: hash(password),
    createdAt: Date.now(),
    tokens: new Set([token]),
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

export function joinRoom(id: string, password: string): string | null {
  const room = rooms.get(id);
  if (!room || room.passwordHash !== hash(password)) return null;
  const token = randomBytes(16).toString("hex");
  room.tokens.add(token);
  return token;
}

export function validateToken(roomId: string, token: string): boolean {
  return rooms.get(roomId)?.tokens.has(token) ?? false;
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
): TextMessage | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg: TextMessage = {
    type: "text",
    id: randomBytes(8).toString("hex"),
    text,
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
): FileMessage | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const msg: FileMessage = {
    type: "file",
    id: randomBytes(8).toString("hex"),
    name,
    path,
    size,
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
