import { Database } from 'bun:sqlite'
import { SqliteHostStore, type SqliteStoreHooks } from './store'

export class HarnessStore extends SqliteHostStore {
  constructor(file: string, hooks?: SqliteStoreHooks) {
    super(file, (path, readonly) => new Database(path, readonly ? { readonly: true } : { create: true }), hooks)
  }
}

export function createSqliteHostStorage(file: string): SqliteHostStore {
  return new HarnessStore(file)
}
