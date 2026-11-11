import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { HarnessSdkError } from "@anureo/sdk";

interface StoredSession { key: SessionKey; entries: SessionStoreEntry[]; mtime: number }

function isLockOwnerDefinitelyAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Uses the official opaque SessionStore contract; never parses Claude's private transcript files. */
export class FileSessionStore implements SessionStore {
  constructor(readonly directory: string) {}
  private file(key: SessionKey): string { return join(this.directory, `${createHash("sha256").update(JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null])).digest("hex")}.json`); }
  private async read(file: string): Promise<StoredSession | null> {
    try {
      const value: StoredSession = JSON.parse(await readFile(file, "utf8"));
      if (!value || !value.key || !Array.isArray(value.entries)) throw new HarnessSdkError("SESSION_STORE_INVALID");
      return value;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const file = this.file(key); const lockPath = `${file}.lock`;
    const expires = Date.now() + 10_000; let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        await lockHandle.writeFile(String(process.pid));
      }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        // A crashed writer's lock can be removed only after proving its process is absent.
        const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
        if (isLockOwnerDefinitelyAbsent(pid)) { await rm(lockPath, { force: true }); continue; }
        if (Date.now() >= expires) throw new HarnessSdkError("SESSION_STORE_BUSY");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const stored = await this.read(file) ?? { key: structuredClone(key), entries: [], mtime: 0 };
      const entryIndexByUuid = new Map(stored.entries.flatMap((entry, index) => entry.uuid ? [[entry.uuid, index] as const] : []));
      // Replace matching UUIDs in place; otherwise append, indexing new UUIDs for later entries in this batch.
      for (const entry of entries) {
        const existingIndex = entry.uuid ? entryIndexByUuid.get(entry.uuid) : undefined;
        if (existingIndex !== undefined) {
          stored.entries[existingIndex] = structuredClone(entry);
        } else {
          if (entry.uuid) entryIndexByUuid.set(entry.uuid, stored.entries.length);
          stored.entries.push(structuredClone(entry));
        }
      }
      stored.mtime = Math.max(Date.now(), stored.mtime + 1);
      const temporaryHandle = await open(temporary, "wx", 0o600);
      try {
        await temporaryHandle.writeFile(JSON.stringify(stored));
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> { const value = await this.read(this.file(key)); return value ? structuredClone(value.entries) : null; }
  private async all(): Promise<StoredSession[]> {
    const names = await readdir(this.directory).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return []; throw cause; });
    const entries = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => this.read(join(this.directory, name))));
    return entries.filter((entry): entry is StoredSession => entry !== null);
  }
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> { return (await this.all()).filter((entry) => entry.key.projectKey === projectKey && !entry.key.subpath).map(({ key, mtime }) => ({ sessionId: key.sessionId, mtime })); }
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> { return (await this.all()).filter((entry) => entry.key.projectKey === key.projectKey && entry.key.sessionId === key.sessionId && entry.key.subpath).map((entry) => entry.key.subpath!); }
  async delete(key: SessionKey): Promise<void> { await rm(this.file(key), { force: true }); }
  private turnMapPath(sessionId: string): string { return join(this.directory, `${createHash("sha256").update(`turns:${sessionId}`).digest("hex")}.turns.json`); }
  async loadTurnMap(sessionId: string): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(this.turnMapPath(sessionId), "utf8")); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {}; throw cause; }
  }
  async saveTurnMap(sessionId: string, turns: Record<string, string>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); const path = this.turnMapPath(sessionId); const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const temporaryHandle = await open(temporary, "wx", 0o600);
      try {
        await temporaryHandle.writeFile(JSON.stringify(turns));
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
