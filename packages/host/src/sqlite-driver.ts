export type SqliteValue = string | number | bigint | Uint8Array | null

export interface SqliteConnection {
  exec(sql: string): unknown
  query(sql: string): {
    get(...values: SqliteValue[]): unknown
    all(...values: SqliteValue[]): unknown[]
    run(...values: SqliteValue[]): unknown
  }
  transaction<Result>(run: () => Result): () => Result
  close(): void
}

export type OpenSqlite = (file: string, readOnly?: boolean) => SqliteConnection
