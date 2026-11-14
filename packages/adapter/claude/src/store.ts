import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { HarnessSdkError } from "@anureo/sdk";

/** Persist JSON-safe, opaque Claude transcript entries in a host-owned directory.
 * Supply this as sessionStore to ClaudeNativeAdapter. With a configured state directory and no
 * supplied store, the adapter creates one in its ahp-session-store subdirectory and also uses it
 * to persist turn IDs for boundary lookup. The native SDK invokes the SessionStore methods for
 * mirroring, resume and history. Transcript keys include the project, session and optional
 * subpath. The host owns retention and coordinates deletion with writers. Construction opens no
 * resources and requires no disposal. */
export class FileSessionStore implements SessionStore {
  /** Use directory for transcripts and turn maps. Writes create missing directories with mode 0700. */
  constructor(readonly directory: string) {}

  /** Commit a batch of JSON-safe entries under the lock for this transcript key.
   * A truthy UUID replaces its existing entry in place. New UUIDs and entries without a truthy
   * UUID append in batch order. Resolve after file sync, atomic rename and lock cleanup.
   * An unreclaimable lock that is still contended at the 10-second retry deadline rejects with
   * SESSION_STORE_BUSY. Transcript read, write and cleanup failures also reject, including
   * cleanup after publication. ClaudeBackendSession.observedStore awaits successful
   * main-transcript appends before scheduling a title refresh for the active query. Rejections
   * return to the native SDK. */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.transcriptPath(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const releaseLock = await acquireSessionLock(`${file}.lockdir`);
    try {
      const stored = await this.readTranscript(file) ?? { key: structuredClone(key), entries: [], mtime: 0 };
      mergeSessionEntries(stored, entries);
      await publishJson({ file, temporary, value: stored });
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        await releaseLock();
      }
    }
  }

  /** Load a detached full transcript, or null when the requested file is absent.
   * An envelope without a truthy key or an entries array rejects with SESSION_STORE_INVALID.
   * Other filesystem and JSON parse failures propagate. ClaudeBackendSession.boundaryPoint and
   * structuredHistory also read these entries to include opaque records omitted by native history
   * in fork/revert cutoffs and structured output in history pages, respectively. */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const stored = await this.readTranscript(this.transcriptPath(key));
    return stored ? structuredClone(stored.entries) : null;
  }

  /** List transcripts with no truthy subpath for a project in filesystem order.
   * An explicit empty subpath has a distinct on-disk key and is listed as a root transcript.
   * When both root keys exist, the session ID appears twice, and listSubkeys omits the empty key.
   * The stored mtime is in Unix epoch milliseconds and advances on every committed append.
   * A missing directory yields an empty list. Read and envelope errors anywhere in the
   * transcript scan reject the listing. */
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return (await this.scanTranscripts())
      .filter((entry) => entry.key.projectKey === projectKey && !entry.key.subpath)
      .map(({ key, mtime }) => ({ sessionId: key.sessionId, mtime }));
  }

  /** List nonempty transcript subpaths for a project and session in filesystem order.
   * A missing directory yields an empty list. Scan failures propagate as in listSessions. */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return (await this.scanTranscripts()).flatMap((entry) => {
      if (entry.key.projectKey !== key.projectKey || entry.key.sessionId !== key.sessionId) return [];
      return entry.key.subpath ? [entry.key.subpath] : [];
    });
  }

  /** Remove the exact transcript when a subpath is supplied. For an omitted subpath, remove
   * all transcripts for this project and session, including the explicit empty subpath.
   * Accept absent files and retain turn maps. The caller must coordinate deletion with writers.
   * Scan and removal failures reject. */
  async delete(key: SessionKey): Promise<void> {
    if (key.subpath === undefined) {
      for (const { key: storedKey } of await this.scanTranscripts()) {
        if (storedKey.projectKey === key.projectKey && storedKey.sessionId === key.sessionId && storedKey.subpath !== undefined) {
          await rm(this.transcriptPath(storedKey), { force: true });
        }
      }
    }
    await rm(this.transcriptPath(key), { force: true });
  }

  /** Load adapter boundary metadata mapping native input UUIDs to AHP turn IDs by native session ID.
   * Return the parsed JSON as stored, or an empty map when the file is absent. Other read and
   * parse failures reject.
   * ClaudeBackendSession.open restores the map for the active session or reads it from the fork
   * source. ClaudeBackendSession.boundaryPoint uses the map to resolve AHP turn IDs to candidates
   * that it verifies in native history. */
  async loadTurnMap(sessionId: string): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.turnMapPath(sessionId), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw cause;
    }
  }

  /** Replace the adapter's turn map for a native session ID.
   * Resolve after file sync, atomic rename and temporary-file cleanup. Callers must order
   * concurrent replacements if publication order matters. Cleanup can reject after publication.
   * ClaudeBackendSession.open and restoreConversation await the save before starting a query.
   * Saves during input association or a native ID change can fail the query pump. */
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

  /** Keep each transcript at its stable hashed path. Omitted subpaths use the null slot in the
   * tuple, preserving the on-disk key format and keeping an explicit empty string distinct. */
  private transcriptPath(key: SessionKey): string {
    return join(this.directory, `${createHash("sha256")
      .update(JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]))
      .digest("hex")}.json`);
  }

  /** Read a transcript envelope for load, append or a scan. Return null on absence and reject
   * malformed JSON or a missing key/entries array so append cannot overwrite those records. */
  private async readTranscript(file: string): Promise<StoredSession | null> {
    try {
      const value: StoredSession = JSON.parse(await readFile(file, "utf8"));
      if (!value || !value.key || !Array.isArray(value.entries)) throw new HarnessSdkError("SESSION_STORE_INVALID");
      return value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }

  /** Scan the hashed transcript filenames for both listing methods. Preserve directory order and
   * skip files removed before they can be read. Directory absence also yields an empty result.
   * Other read or envelope errors reject before the caller filters by project or session. */
  private async scanTranscripts(): Promise<StoredSession[]> {
    const names = await readdir(this.directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    const transcripts = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const entries = await Promise.all(transcripts.map((name) => this.readTranscript(join(this.directory, name))));
    return entries.filter((entry): entry is StoredSession => entry !== null);
  }

  /** Keep boundary metadata at its stable session-ID path, outside the transcript filename pattern. */
  private turnMapPath(sessionId: string): string {
    return join(this.directory, `${createHash("sha256").update(`turns:${sessionId}`).digest("hex")}.turns.json`);
  }
}

interface StoredSession {
  /** Retain the full key so listings can filter hashed files by project and subpath. */
  key: SessionKey;
  entries: SessionStoreEntry[];
  /** Record append order for this transcript even when the wall clock repeats or moves backward. */
  mtime: number;
}

/** Publish a populated directory atomically. A competing rename cannot replace a nonempty lock.
 * The owner name includes a nonce so delayed recovery can only remove the owner it inspected.
 * The directory lock uses a different path from legacy PID files. */
async function acquireSessionLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 10_000;
  const owner = `${process.pid}-${randomUUID()}`;
  const staged = `${lockPath}-${owner}`;
  await mkdir(staged, { mode: 0o700 });
  try {
    await mkdir(join(staged, owner), { mode: 0o700 });
    while (true) {
      try {
        await rename(staged, lockPath);
        return () => removeSessionLockOwner(lockPath, owner);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        // Windows can report access denied when a rename targets an existing directory.
        const windowsContention = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && !windowsContention) throw cause;
      }
      await recoverSessionLock(lockPath);
      if (Date.now() >= deadline) throw new HarnessSdkError("SESSION_STORE_BUSY");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (cause) {
    await rm(staged, { recursive: true, force: true });
    throw cause;
  }
}

/** Recover an exited owner or finish removing an already empty lock. */
async function recoverSessionLock(lockPath: string): Promise<void> {
  const owners = await readdir(lockPath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
  });
  if (!owners) return;
  const [owner] = owners;
  if (owner === undefined) {
    await removeEmptyLockDirectory(lockPath);
  } else if (owners.length === 1 && isLockOwnerDefinitelyAbsent(Number(owner.split("-", 1)[0]))) {
    await removeSessionLockOwner(lockPath, owner);
  }
}

async function removeSessionLockOwner(lockPath: string, owner: string): Promise<void> {
  await rmdir(join(lockPath, owner)).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
  });
  await removeEmptyLockDirectory(lockPath);
}

/** A replacement lock is already populated, so rmdir cannot remove it. */
async function removeEmptyLockDirectory(lockPath: string): Promise<void> {
  await rmdir(lockPath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT" && cause.code !== "ENOTEMPTY" && cause.code !== "EEXIST") throw cause;
  });
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

/** Publish JSON by renaming an exclusive mode-0600 temporary file after sync and close.
 * append and saveTurnMap supply a unique path in the destination directory for atomic rename
 * and own path cleanup. File and serialization failures reject, and the temporary handle closes
 * before the destination can be replaced. */
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
