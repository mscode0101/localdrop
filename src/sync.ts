import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";

export interface SyncFile {
  path: string;
  content: string;
  deleted?: boolean;
}

export function getChangedFiles(projectDir: string): SyncFile[] {
  const files: SyncFile[] = [];

  const modified = execSync("git diff --name-only HEAD", {
    cwd: projectDir,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const untracked = execSync(
    "git ls-files --others --exclude-standard",
    { cwd: projectDir, encoding: "utf-8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const staged = execSync("git diff --cached --name-only", {
    cwd: projectDir,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const all = [...new Set([...modified, ...untracked, ...staged])];

  for (const rel of all) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) {
      files.push({ path: rel, content: "", deleted: true });
      continue;
    }
    files.push({ path: rel, content: readFileSync(abs, "base64") });
  }

  return files;
}

export function getFullTree(projectDir: string): SyncFile[] {
  const tracked = execSync("git ls-files", {
    cwd: projectDir,
    encoding: "utf-8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const untracked = execSync(
    "git ls-files --others --exclude-standard",
    { cwd: projectDir, encoding: "utf-8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const all = [...new Set([...tracked, ...untracked])];
  const files: SyncFile[] = [];

  for (const rel of all) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    files.push({ path: rel, content: readFileSync(abs, "base64") });
  }

  return files;
}

export function applySync(mirrorDir: string, files: SyncFile[]): void {
  for (const file of files) {
    const dest = join(mirrorDir, file.path);
    if (file.deleted) {
      if (existsSync(dest)) rmSync(dest);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(file.content, "base64"));
  }
}
