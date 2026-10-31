import { Hono } from "hono";
import { createReadStream, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { saveUpload } from "./files.js";
import {
  createRoom,
  listRooms,
  joinRoom,
  validateToken,
  getNickname,
  getRoomName,
  addSSEClient,
  removeSSEClient,
  broadcast,
  addTextMessage,
  addFileMessage,
  getMessages,
  getMessage,
  deleteMessage,
  stripPath,
  checkJoinRateLimit,
  addSystemCommand,
  addSystemResult,
  updateCommandStatus,
  getSystemMessages,
  setSyncDir,
  getSyncDir,
  type FileMessage,
} from "./rooms.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readUI(filename: string): string {
  try {
    return readFileSync(join(__dirname, "ui", filename), "utf-8");
  } catch {
    return readFileSync(join(__dirname, "..", "src", "ui", filename), "utf-8");
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return map;
}

export function createApp(outputDir: string, defaultSyncDir?: string): Hono {
  const app = new Hono();

  // --- CORS: only allow same-origin requests ---
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin) {
      const host = c.req.header("host");
      const allowed = host ? `http://${host}` : null;
      if (origin !== allowed) {
        return c.json({ error: "CORS rejected" }, 403);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type");
      c.header("Access-Control-Allow-Credentials", "true");
    }
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    await next();
  });

  // --- Pages ---

  app.get("/", (c) => {
    const html = readUI("index.html")
      .replace("__ROOM_ID__", "")
      .replace("__ROOM_NAME__", "");
    return c.html(html);
  });

  app.get("/room/:id", (c) => {
    const roomId = c.req.param("id");
    const name = getRoomName(roomId);
    if (!name) return c.redirect("/");
    const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const html = readUI("index.html")
      .replace("__ROOM_ID__", roomId)
      .replace("__ROOM_NAME__", escaped);
    return c.html(html);
  });

  // --- Room API (no auth for listing / creating / joining) ---

  app.get("/api/rooms", (c) => c.json({ rooms: listRooms() }));

  app.post("/api/rooms", async (c) => {
    const body = await c.req.json<{ name: string; password: string; nickname: string }>();
    if (!body.name?.trim() || !body.password) {
      return c.json({ error: "name and password required" }, 400);
    }
    if (!body.nickname?.trim()) {
      return c.json({ error: "nickname required" }, 400);
    }
    if (body.name.trim().length > 50) {
      return c.json({ error: "name too long" }, 400);
    }
    if (body.nickname.trim().length > 30) {
      return c.json({ error: "nickname too long" }, 400);
    }
    const result = createRoom(body.name, body.password, body.nickname.trim());
    if (defaultSyncDir) setSyncDir(result.id, defaultSyncDir);
    c.header("Set-Cookie", `ld_${result.id}=${result.token}; HttpOnly; SameSite=Strict; Path=/`);
    return c.json(result);
  });

  app.post("/api/rooms/:id/join", async (c) => {
    const ip = c.req.header("x-forwarded-for") ?? "unknown";
    if (!checkJoinRateLimit(ip)) {
      return c.json({ error: "too many attempts, try again in a minute" }, 429);
    }
    const body = await c.req.json<{ password: string; nickname: string }>();
    if (!body.password) {
      return c.json({ error: "password required" }, 400);
    }
    if (!body.nickname?.trim()) {
      return c.json({ error: "nickname required" }, 400);
    }
    if (body.nickname.trim().length > 30) {
      return c.json({ error: "nickname too long" }, 400);
    }
    const roomId = c.req.param("id");
    const token = joinRoom(roomId, body.password, body.nickname.trim());
    if (!token) {
      return c.json({ error: "wrong password or room not found" }, 401);
    }
    c.header("Set-Cookie", `ld_${roomId}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return c.json({ token });
  });

  // --- Room-scoped routes (need token) ---

  function getToken(
    c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } },
    roomId: string,
  ): string | null {
    const t = c.req.query("t")
      ?? c.req.header("x-token")
      ?? parseCookies(c.req.header("cookie")).get(`ld_${roomId}`)
      ?? null;
    if (t && validateToken(roomId, t)) return t;
    return null;
  }

  app.get("/api/rooms/:id/events", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const client = {
          send(event: string, data: string) {
            try {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
              );
            } catch {
              /* client gone */
            }
          },
          close() {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };
        addSSEClient(roomId, client);
        controller.enqueue(encoder.encode(": connected\n\n"));

        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(keepalive);
          }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          removeSSEClient(roomId, client);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  app.get("/api/rooms/:id/messages", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const msgs = getMessages(roomId).map(stripPath);
    return c.json({ messages: msgs });
  });

  app.post("/api/rooms/:id/messages/text", async (c) => {
    const roomId = c.req.param("id");
    const token = getToken(c, roomId);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ text: string }>();
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "expected { text: string }" }, 400);
    }
    const sender = getNickname(roomId, token);
    const msg = addTextMessage(roomId, body.text, sender);
    if (!msg) return c.json({ error: "room not found" }, 404);
    broadcast(roomId, "message", stripPath(msg));
    return c.json({ message: stripPath(msg) });
  });

  app.post("/api/rooms/:id/messages/file", async (c) => {
    const roomId = c.req.param("id");
    const token = getToken(c, roomId);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const sender = getNickname(roomId, token);

    const contentType = c.req.header("content-type");
    if (!contentType?.includes("multipart/form-data")) {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }

    const raw = c.req.raw;
    if (!raw.body) return c.json({ error: "no body" }, 400);

    const results: Array<{ id: string; name: string; size: number }> = [];

    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({ headers: { "content-type": contentType } });
      let pending = 0;
      let finished = false;

      bb.on("file", (_field, stream, info) => {
        pending++;
        const filename = info.filename || "upload";
        saveUpload(stream as unknown as Readable, filename, outputDir)
          .then(({ savedPath, savedName }) => {
            const size = statSync(savedPath).size;
            const msg = addFileMessage(roomId, savedName, savedPath, size, sender);
            if (msg) {
              broadcast(roomId, "message", stripPath(msg));
              results.push({ id: msg.id, name: msg.name, size: msg.size });
            }
            pending--;
            if (finished && pending === 0) resolve();
          })
          .catch(reject);
      });

      bb.on("finish", () => {
        finished = true;
        if (pending === 0) resolve();
      });
      bb.on("error", reject);

      const reader = raw.body!.getReader();
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              bb.end();
              return;
            }
            bb.write(value);
            pump();
          })
          .catch(reject);
      };
      pump();
    });

    return c.json({ uploaded: results });
  });

  app.get("/api/rooms/:id/download/:msgId", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);

    const msg = getMessage(roomId, c.req.param("msgId"));
    if (!msg || msg.type !== "file") {
      return c.json({ error: "not found" }, 404);
    }
    const file = msg as FileMessage;

    let total: number;
    try {
      total = statSync(file.path).size;
    } catch {
      return c.json({ error: "file missing from disk" }, 404);
    }

    const range = c.req.header("range");
    const encodedName = encodeURIComponent(file.name).replace(/%20/g, "+");
    const disposition = `attachment; filename="${file.name.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodedName}`;

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) return c.json({ error: "bad range" }, 416);
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total) {
        return c.json({ error: "range not satisfiable" }, 416);
      }
      const stream = createReadStream(file.path, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": "application/octet-stream",
          "Content-Disposition": disposition,
        },
      });
    }

    const stream = createReadStream(file.path);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Content-Type": "application/octet-stream",
        "Content-Disposition": disposition,
      },
    });
  });

  // --- System channel (commands / results) ---

  app.get("/api/rooms/:id/system", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ messages: getSystemMessages(roomId) });
  });

  app.post("/api/rooms/:id/system/command", async (c) => {
    const roomId = c.req.param("id");
    const token = getToken(c, roomId);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ run: string; target?: string; sync?: boolean; fullSync?: boolean }>();
    if (typeof body.run !== "string" || !body.run.trim()) {
      return c.json({ error: "expected { run: string }" }, 400);
    }
    const sender = getNickname(roomId, token);
    const cmd = addSystemCommand(roomId, body.run, sender, body.target ?? null, body.sync ?? false, body.fullSync ?? false);
    if (!cmd) return c.json({ error: "room not found" }, 404);
    broadcast(roomId, "system", cmd);
    return c.json({ command: cmd });
  });

  app.post("/api/rooms/:id/system/result", async (c) => {
    const roomId = c.req.param("id");
    const token = getToken(c, roomId);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{
      commandId: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>();
    if (!body.commandId) {
      return c.json({ error: "expected { commandId: string }" }, 400);
    }
    const sender = getNickname(roomId, token);
    const result = addSystemResult(
      roomId, body.commandId, sender,
      body.exitCode ?? null, body.stdout ?? "", body.stderr ?? "",
    );
    if (!result) return c.json({ error: "room not found" }, 404);
    broadcast(roomId, "system", result);
    return c.json({ result });
  });

  app.post("/api/rooms/:id/system/status", async (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ commandId: string; status: string }>();
    const valid = ["pending", "running", "done", "error", "denied"] as const;
    if (!body.commandId || !valid.includes(body.status as typeof valid[number])) {
      return c.json({ error: "invalid status" }, 400);
    }
    if (!updateCommandStatus(roomId, body.commandId, body.status as typeof valid[number])) {
      return c.json({ error: "not found" }, 404);
    }
    broadcast(roomId, "system", { type: "status", commandId: body.commandId, status: body.status });
    return c.json({ ok: true });
  });

  app.post("/api/rooms/:id/sync-dir", async (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ dir: string }>();
    if (!body.dir?.trim()) return c.json({ error: "dir required" }, 400);
    setSyncDir(roomId, body.dir);
    return c.json({ ok: true });
  });

  app.get("/api/rooms/:id/sync-dir", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ dir: getSyncDir(roomId) });
  });

  app.get("/api/rooms/:id/sync-files", async (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const dir = getSyncDir(roomId);
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "no sync dir configured" }, 404);
    }
    const { getChangedFiles, getFullTree } = await import("./sync.js");
    const full = c.req.query("full") === "1";
    const files = full ? getFullTree(dir) : getChangedFiles(dir);
    return c.json({ files });
  });

  // --- Chat message deletion ---

  app.delete("/api/rooms/:id/messages/:msgId", (c) => {
    const roomId = c.req.param("id");
    if (!getToken(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const msgId = c.req.param("msgId");
    if (!deleteMessage(roomId, msgId)) {
      return c.json({ error: "not found" }, 404);
    }
    broadcast(roomId, "delete", { id: msgId });
    return c.json({ ok: true });
  });

  return app;
}
