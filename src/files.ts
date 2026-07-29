import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface SharedFile {
  id: string;
  name: string;
  path: string;
  size: number;
}

const sharedFiles = new Map<string, SharedFile>();

export function getSharedFiles(): SharedFile[] {
  return Array.from(sharedFiles.values());
}

export function getSharedFile(id: string): SharedFile | undefined {
  return sharedFiles.get(id);
}

export function addSharedFile(filePath: string): SharedFile {
  const id = randomBytes(8).toString("hex");
  const name = basename(filePath);
  const size = statSync(filePath).size;
  const file: SharedFile = { id, name, path: filePath, size };
  sharedFiles.set(id, file);
  return file;
}

function sanitizeFilename(raw: string): string {
  let name = basename(raw);
  name = name.replace(/[/\\:*?"<>|]/g, "_");
  name = name.replace(/^\.+/, "_");
  if (name.length === 0) name = "upload";
  if (name.length > 200) {
    const ext = extname(name);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

function resolveCollision(dir: string, name: string): string {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 1;
  do {
    candidate = join(dir, `${base} (${i})${ext}`);
    i++;
  } while (existsSync(candidate));

  return candidate;
}

export async function saveUpload(
  stream: Readable,
  filename: string,
  outputDir: string,
): Promise<{ savedPath: string; savedName: string }> {
  await mkdir(outputDir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const dest = resolveCollision(outputDir, safe);
  const ws = createWriteStream(dest);
  await pipeline(stream, ws);
  return { savedPath: dest, savedName: basename(dest) };
}
