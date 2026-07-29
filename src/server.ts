import { Hono } from "hono";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { saveUpload } from "./files.js";
import {
  getMessages,
  getMessage,
  addTextMessage,
  addFileMessage,
  deleteMessage,
  type FileMessage,
} from "./history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type SSEClient = { send: (event: string, data: string) => void; close: () => void };
const sseClients = new Set<SSEClient>();

function broadcast(event: string, data: unknown): void {
  const json = JSON.stringify(data);
  for (const client of sseClients) {
    client.send(event, json);
  }
}

function stripPath(m: ReturnType<typeof getMessage>) {
  if (!m) return m;
  if (m.type === "file") {
    const { path: _p, ...rest } = m;
    return rest;
  }
  return m;
}

export function createApp(token: string, outputDir: string): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const t = c.req.query("t") ?? c.req.header("x-token");
    if (t !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/", (c) => {
    let html: string;
    try {
      html = readFileSync(join(__dirname, "ui", "index.html"), "utf-8");
    } catch {
      html = readFileSync(
        join(__dirname, "..", "src", "ui", "index.html"),
        "utf-8",
      );
    }
    html = html.replace("__TOKEN__", token);
    return c.html(html);
  });

  app.get("/api/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const client: SSEClient = {
          send(event, data) {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            } catch { /* client gone */ }
          },
          close() {
            try { controller.close(); } catch { /* already closed */ }
          },
        };
        sseClients.add(client);
        controller.enqueue(encoder.encode(": connected\n\n"));

        const keepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(keepalive); }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(keepalive);
          sseClients.delete(client);
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

  app.get("/api/messages", (c) => {
    const msgs = getMessages().map((m) => stripPath(m));
    return c.json({ messages: msgs });
  });

  app.post("/api/messages/text", async (c) => {
    const body = await c.req.json<{ text: string }>();
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return c.json({ error: "expected { text: string }" }, 400);
    }
    const msg = addTextMessage(body.text);
    broadcast("message", stripPath(msg));
    return c.json({ message: msg });
  });

  app.post("/api/messages/file", async (c) => {
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
            const msg = addFileMessage(savedName, savedPath, size);
            broadcast("message", stripPath(msg));
            results.push({ id: msg.id, name: msg.name, size: msg.size });
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

  app.get("/api/download/:id", (c) => {
    const msg = getMessage(c.req.param("id"));
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

  app.delete("/api/messages/:id", (c) => {
    const id = c.req.param("id");
    if (!deleteMessage(id)) {
      return c.json({ error: "not found" }, 404);
    }
    broadcast("delete", { id });
    return c.json({ ok: true });
  });

  return app;
}
