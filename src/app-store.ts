import fs = require("node:fs");
import path = require("node:path");
import crypto = require("node:crypto");
import { assertSafeBundlePath } from "./app-bundle";

export function createAppStore() {
  const appLocks = new Map<string, { action: string; startedAt: string }>();

  function readSession(dir: string) {
    const sessionPath = path.join(dir, "session.json");
    if (!fs.existsSync(sessionPath)) return {};
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      return session && typeof session === "object" ? session : {};
    } catch { return {}; }
  }

  function writeSession(dir: string, patch: Record<string, unknown>) {
    if (!dir || !fs.existsSync(dir)) return;
    const sessionPath = path.join(dir, "session.json");
    fs.writeFileSync(sessionPath, JSON.stringify({ ...readSession(dir), ...patch, updatedAt: new Date().toISOString() }));
  }

  function updateSessionWorkflow(dir: string, patch: Record<string, unknown>) {
    const session = readSession(dir);
    writeSession(dir, { workflow: { ...(session.workflow || {}), ...patch } });
  }

  function appendSessionConversation(dir: string, entries: unknown[]) {
    if (!dir || !fs.existsSync(dir)) return;
    const session = readSession(dir);
    const conversation = Array.isArray(session.conversation) ? session.conversation : [];
    writeSession(dir, { conversation: [...conversation, ...entries].slice(-160) });
  }

  function acquireAppLock(id: string, action: string) {
    const current = appLocks.get(id);
    if (current) {
      const error = new Error(`应用 ${id} 正在执行 ${current.action}，请稍后重试`);
      (error as any).statusCode = 409;
      throw error;
    }
    const lock = { action, startedAt: new Date().toISOString() };
    appLocks.set(id, lock);
    return () => {
      const existing = appLocks.get(id);
      if (existing && existing.action === action && existing.startedAt === lock.startedAt) appLocks.delete(id);
    };
  }

  async function withAppLock<T>(id: string, action: string, fn: () => Promise<T>) {
    const release = acquireAppLock(id, action);
    try { return await fn(); } finally { release(); }
  }

  function atomicWriteFiles(dir: string, files: Record<string, string>) {
    const tempDir = fs.mkdtempSync(path.join(dir, ".patch-"));
    try {
      for (const [relativePath, content] of Object.entries(files)) {
        const tempPath = path.join(tempDir, assertSafeBundlePath(relativePath));
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, content);
      }
      for (const relativePath of Object.keys(files)) {
        const safePath = assertSafeBundlePath(relativePath);
        const targetPath = path.join(dir, safePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.renameSync(path.join(tempDir, safePath), targetPath);
      }
    } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  }

  function backupBundleFiles(dir: string, files: string[], version: number) {
    const versionDir = path.join(dir, "versions", "v" + version);
    fs.mkdirSync(versionDir, { recursive: true });
    for (const relativePath of files) {
      const safePath = assertSafeBundlePath(relativePath);
      const sourcePath = path.join(dir, safePath);
      if (!fs.existsSync(sourcePath)) continue;
      const targetPath = safePath === "index.html" ? path.join(dir, "versions", "v" + version + ".html") : path.join(versionDir, safePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
    return versionDir;
  }

  function versionHistoryPath(dir: string) { return path.join(dir, "version-history.json"); }
  function readVersionHistory(dir: string) {
    const filePath = versionHistoryPath(dir);
    if (!fs.existsSync(filePath)) return [];
    try { const history = JSON.parse(fs.readFileSync(filePath, "utf8")); return Array.isArray(history) ? history : []; } catch { return []; }
  }
  function bundleDigest(files: Record<string, string>) {
    const hash = crypto.createHash("sha256");
    for (const filePath of Object.keys(files).sort()) hash.update(filePath + "\0" + files[filePath] + "\0");
    return hash.digest("hex").slice(0, 12);
  }
  function recordVersion(dir: string, { version, action, message, prompt = null, changes = [], validation = null }: any) {
    const history = readVersionHistory(dir);
    const previous = history[history.length - 1] || null;
    const files: Record<string, string> = {};
    for (const filePath of ["index.html", "manifest.json", "sw.js", "icon.svg"]) {
      const fullPath = path.join(dir, filePath);
      if (fs.existsSync(fullPath)) files[filePath] = fs.readFileSync(fullPath, "utf8");
    }
    const entry = { commitId: "c" + String(history.length + 1).padStart(6, "0"), parent: previous ? previous.commitId : null, version, action, message, prompt, changes, validation, digest: bundleDigest(files), createdAt: new Date().toISOString() };
    history.push(entry);
    fs.writeFileSync(versionHistoryPath(dir), JSON.stringify(history, null, 2));
    return entry;
  }
  function finalizeAppCommit(dir: string, data: any) {
    const commit = recordVersion(dir, data);
    writeSession(dir, { version: data.version, title: data.title, history: data.history, conversation: data.conversation, head: commit.commitId, workflow: { ...(data.workflow || {}), state: "idle", editMode: data.workflow?.editMode, validation: data.workflow?.validation } });
    return commit;
  }
  return { readSession, writeSession, updateSessionWorkflow, appendSessionConversation, acquireAppLock, withAppLock, atomicWriteFiles, backupBundleFiles, readVersionHistory, recordVersion, finalizeAppCommit };
}
