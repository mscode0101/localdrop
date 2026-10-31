import { Hono } from "hono";
import { createReadStream, readFileSync, statSync } from "node:fs";
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

export function createApp(outputDir: string): Hono {
  const app = new Hono();

  // --- Lobby (no auth) ---

  app.get("/", (c) => c.html(readUI("lobby.html")));

  // --- Room chat page ---

  app.get("/room/:id", (c) => {
    const roomId = c.req.param("id");
    const name = getRoomName(roomId);
    if (!name) return c.redirect("/");
    const html = readUI("index.html").replace(
      "__ROOM_NAME__",
      name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    );
    return c.html(html);
  });

  // --- Room API (no auth for listing / creating / joining) ---

  app.get("/api/rooms", (c) => c.json({ rooms: listRooms() }));

  app.post("/api/rooms", async (c) => {
    const body = await c.req.json<{ name: string; password: string }>();
    if (!body.name?.trim() || !body.password) {
      return c.json({ error: "name and password required" }, 400);
    }
    if (body.name.trim().length > 50) {
      return c.json({ error: "name too long" }, 400);
    }
    const result = createRoom(body.name, body.password);
    return c.json(result);
  });

  app.post("/api/rooms/:id/join", async (c) => {
    const body = await c.req.json<{ password: string }>();
    if (!body.password) {
      return c.json({ error: "password required" }, 400);
    }
    const token = joinRoom(c.req.param("id"), body.password);
    if (!token) {
      return c.json({ error: "wrong password or room not found" }, 401);
    }
    return c.json({ token });
  });

  // --- Room-scoped routes (need token) ---

  function checkAuth(
    c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } },
    roomId: string,
  ): boolean {
    const t = c.req.query("t") ?? c.req.header("x-token");
    return !!t && validateToken(roomId, t);
  }

  app.get("/api/rooms/:id/events", (c) => {
    const roomId = c.req.param("id");
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);

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
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const msgs = getMessages(roomId).map(stripPath);
    return c.json({ messages: msgs });
  });

  app.post("/api/rooms/:id/messages/text", async (c) => {
    const roomId = c.req.param("id");
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ text: string }>();
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "expected { text: string }" }, 400);
    }
    const msg = addTextMessage(roomId, body.text);
    if (!msg) return c.json({ error: "room not found" }, 404);
    broadcast(roomId, "message", stripPath(msg));
    return c.json({ message: stripPath(msg) });
  });

  app.post("/api/rooms/:id/messages/file", async (c) => {
    const roomId = c.req.param("id");
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);

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
            const msg = addFileMessage(roomId, savedName, savedPath, size);
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
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);

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

  app.delete("/api/rooms/:id/messages/:msgId", (c) => {
    const roomId = c.req.param("id");
    if (!checkAuth(c, roomId)) return c.json({ error: "unauthorized" }, 401);
    const msgId = c.req.param("msgId");
    if (!deleteMessage(roomId, msgId)) {
      return c.json({ error: "not found" }, 404);
    }
    broadcast(roomId, "delete", { id: msgId });
    return c.json({ ok: true });
  });

  return app;
}
