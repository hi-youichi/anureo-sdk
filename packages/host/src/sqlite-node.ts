import { DatabaseSync } from 'node:sqlite'
import type { OpenSqlite } from './sqlite-driver'
import { SqliteHostStore, type SqliteStoreHooks } from './store'

const open: OpenSqlite = (file, readOnly) => {
  const db = new DatabaseSync(file, { readOnly })
  let depth = 0
  return {
    exec: sql => db.exec(sql),
    query: sql => db.prepare(sql),
    transaction: run => () => {
      const savepoint = depth ? `anureo_transaction_${depth}` : undefined
      db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      depth++
      try {
        const result = run()
        db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK')
        throw error
      } finally {
        depth--
      }
    },
    close: () => db.close(),
  }
}

export class HarnessStore extends SqliteHostStore {
  constructor(file: string, hooks?: SqliteStoreHooks) {
    super(file, open, hooks)
  }
}

export function createSqliteHostStorage(file: string): SqliteHostStore {
  return new HarnessStore(file)
}
