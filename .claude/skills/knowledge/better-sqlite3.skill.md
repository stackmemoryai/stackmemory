---
name: better-sqlite3
version: 2025.12.1
domain: database
expires: 2026-12-01
activates_on: [sqlite, better-sqlite3, database, db, query, fts, fts5, pragma, wal, transaction]
sources:
  - https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
context7: WiseLibs/better-sqlite3
---

# better-sqlite3

## Basics
- Open: `new Database(path)` or `new Database(':memory:')`
- **Synchronous API** — no async/await, no callbacks
- Prepare + run: `db.prepare('SELECT * FROM t WHERE id = ?').get(id)`
- All rows: `.all(params)` | Single row: `.get(params)` | Execute: `.run(params)`
- Params: positional `?` or named `$name` / `:name` / `@name`

## Transactions
```js
const insert = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
const insertMany = db.transaction((items) => {
  for (const item of items) insert.run(item.a, item.b);
});
insertMany(items); // atomic, auto-rollback on error
```
- `db.transaction()` returns a reusable function — best pattern for batch ops
- Nested transactions: use `.deferred()`, `.immediate()`, `.exclusive()`

## FTS5 (Full-Text Search)
- Create: `CREATE VIRTUAL TABLE t_fts USING fts5(content, tokenize='porter unicode61')`
- Search: `SELECT * FROM t_fts WHERE t_fts MATCH 'query'`
- Rank: `SELECT *, rank FROM t_fts WHERE t_fts MATCH 'query' ORDER BY rank`
- BM25: `SELECT *, bm25(t_fts) as score FROM t_fts WHERE t_fts MATCH ?`
- Highlight: `highlight(t_fts, 0, '<b>', '</b>')`

## WAL Mode
- Enable: `db.pragma('journal_mode = WAL')` — concurrent reads, single writer
- Always enable for production — significant performance improvement
- `db.pragma('busy_timeout = 5000')` — wait up to 5s for write lock

## Performance
- `db.pragma('cache_size = -64000')` — 64MB cache
- `db.pragma('synchronous = NORMAL')` — faster writes (WAL mode safe)
- `db.prepare()` caches the statement plan — reuse prepared statements
- Batch inserts: always wrap in `db.transaction()` — 100x faster than individual inserts

## ESM Import
- CJS native addon: `import Database from 'better-sqlite3'`
- Mark as `external` in esbuild — can't bundle native `.node` files
- Prebuilt binaries: `npm install` downloads correct platform binary

## Gotchas
- Synchronous — blocks event loop on large queries; use worker_threads for heavy ops
- `.get()` returns `undefined` if no row (not `null`)
- `.run()` returns `{ changes, lastInsertRowid }` — not the row itself
- Column names are case-sensitive in result objects
- VACUUM: locks entire DB — run during maintenance windows only
