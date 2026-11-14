import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { HarnessSdkError } from "@anureo/sdk";

/** Persist JSON-safe, opaque Claude transcript entries in a host-owned directory.
 * Supply this as sessionStore or let ClaudeNativeAdapter create it under stateDir. The native SDK
 * invokes the SessionStore methods for mirroring, resume and history; no private transcript parsing
 * is required. Keys isolate projects, sessions and subpaths. The host owns retention and must
 * coordinate deletion with writers; construction opens no resources and needs no disposal.
 * Filesystem/JSON failures reject the corresponding operation. */
export class FileSessionStore implements SessionStore {
  /** Retain the storage directory without creating it; writes create it with mode 0700. */
  constructor(readonly directory: string) {}

  /** Commit an opaque batch under a per-key process lock, replacing matching truthy UUIDs in place.
   * Entries without a truthy UUID append in batch order. Resolve after file sync, atomic rename and
   * lock cleanup; a rejection may occur after publication. Lock contention polls every 10 ms and
   * rejects SESSION_STORE_BUSY after 10 seconds unless a dead owner's lock can be reclaimed.
   * The native SDK owns mirror retry policy; callers must supply JSON-safe entries. */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key);
    const lockPath = `${file}.lock`;
    const lockHandle = await acquireSessionLock(lockPath);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const stored = await this.read(file) ?? { key: structuredClone(key), entries: [], mtime: 0 };
      mergeSessionEntries(stored, entries);
      await publishJson({ file, temporary, value: stored });
    } finally {
      await rm(temporary, { force: true });
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }

  /** Load a detached full transcript, or null when the key has no file.
   * The native SDK uses these entries for resume/history; a missing key or non-array entries reject
   * SESSION_STORE_INVALID, and filesystem or JSON parse failures propagate. */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const value = await this.read(this.file(key));
    return value ? structuredClone(value.entries) : null;
  }

  /** List main transcripts for a project in filesystem order, without sorting.
   * mtime is Unix epoch milliseconds, increased by at least one per committed append.
   * A missing directory yields []; unreadable or invalid session files reject the scan. */
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return (await this.all())
      .filter((entry) => entry.key.projectKey === projectKey && !entry.key.subpath)
      .map(({ key, mtime }) => ({ sessionId: key.sessionId, mtime }));
  }

  /** List truthy subpaths for native resume materialization within one project/session.
   * A missing directory yields []; scan failures propagate as in listSessions. */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return (await this.all()).flatMap((entry) => {
      if (entry.key.projectKey !== key.projectKey || entry.key.sessionId !== key.sessionId) return [];
      return entry.key.subpath ? [entry.key.subpath] : [];
    });
  }

  /** Remove only this transcript file, accepting an absent file.
   * Subpaths and turn maps remain; the caller must coordinate this unlocked deletion with writers. */
  async delete(key: SessionKey): Promise<void> { await rm(this.file(key), { force: true }); }

  /** Load the adapter's native-input UUID to AHP turn-ID map, or {} if absent.
   * ClaudeBackendSession.open and boundaryPoint use it to restore verified turn identities;
   * other read/parse failures reject their open or boundary operation. This is separate from
   * the native SessionStore contract and scoped by session ID, not project. */
  async loadTurnMap(sessionId: string): Promise<Record<string, string>> {
    try { return JSON.parse(await readFile(this.turnMapPath(sessionId), "utf8")); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {}; throw cause; }
  }

  /** Replace the adapter's turn map, resolving after sync, atomic rename and temporary-file cleanup.
   * ClaudeBackendSession awaits this during open, input association, native-ID changes and
   * conversation restoration; failures reject those operations into their existing error paths.
   * Concurrent saves are unlocked replacements; callers own ordering, and cleanup can reject
   * after publication. This adapter metadata is separate from the native SessionStore contract. */
  async saveTurnMap(sessionId: string, turns: Record<string, string>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.turnMapPath(sessionId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await publishJson({ file, temporary, value: turns });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private file(key: SessionKey): string { return join(this.directory, `${createHash("sha256").update(JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null])).digest("hex")}.json`); }

  /** Read only our envelope, leaving native entry payloads opaque; absence is distinct from corruption. */
  private async read(file: string): Promise<StoredSession | null> {
    try {
      const value: StoredSession = JSON.parse(await readFile(file, "utf8"));
      if (!value || !value.key || !Array.isArray(value.entries)) throw new HarnessSdkError("SESSION_STORE_INVALID");
      return value;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
  }

  /** Scan only hashed transcript files, excluding turn maps, locks and temporary publications. */
  private async all(): Promise<StoredSession[]> {
    const names = await readdir(this.directory).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return []; throw cause; });
    const entries = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => this.read(join(this.directory, name))));
    return entries.filter((entry): entry is StoredSession => entry !== null);
  }

  private turnMapPath(sessionId: string): string { return join(this.directory, `${createHash("sha256").update(`turns:${sessionId}`).digest("hex")}.turns.json`); }
}

interface StoredSession { key: SessionKey; entries: SessionStoreEntry[]; mtime: number }

/** Acquire append's exclusive lock and record its PID; the caller owns close and lock-file removal.
 * Reclaim only owners proven absent, since age alone cannot distinguish a slow live writer.
 * Contention times out with SESSION_STORE_BUSY; other acquisition/write failures propagate.
 * A failed PID write after open leaves the acquired handle/lock unreleased;
 * ownership transfers to the caller only on success. */
async function acquireSessionLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const expires = Date.now() + 10_000;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(String(process.pid));
    }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
      if (isLockOwnerDefinitelyAbsent(pid)) { await rm(lockPath, { force: true }); continue; }
      if (Date.now() >= expires) throw new HarnessSdkError("SESSION_STORE_BUSY");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return lockHandle;
}

/** Treat only ESRCH for a valid positive PID as proof; permission errors leave the lock intact. */
function isLockOwnerDefinitelyAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Mutate append's locked snapshot, cloning incoming entries and preserving UUID positions.
 * Index new UUIDs immediately so repeats in the same batch also replace in place. */
function mergeSessionEntries(stored: StoredSession, entries: SessionStoreEntry[]): void {
  const entryIndexByUuid = new Map(stored.entries.flatMap((entry, index) => entry.uuid ? [[entry.uuid, index] as const] : []));
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
}

/** Publish JSON only after the exclusive mode-0600 temporary file is synced and closed.
 * append/saveTurnMap supply a unique same-directory path and own its removal on success or failure;
 * write/sync/close/rename failures reject, and a close failure prevents rename. */
async function publishJson({ file, temporary, value }: { file: string; temporary: string; value: unknown }): Promise<void> {
  const temporaryHandle = await open(temporary, "wx", 0o600);
  try {
    await temporaryHandle.writeFile(JSON.stringify(value));
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  await rename(temporary, file);
}
