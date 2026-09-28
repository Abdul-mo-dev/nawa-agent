# Analytics database locking fix

The `nawa:analytics` handler could fail with `database is locked` because each worker repeated WAL/schema setup and analytical queries wrote saved result receipts concurrently with imports. The old constructor also configured SQLite's busy timeout after its first locking operation.

The service now lets one worker initialize the database and waits for its readiness message before admitting other workers. Later metadata workers open read-only connections and skip schema setup. Up to two metadata readers can still run alongside a WAL writer.

Import, review, clear, query, analyze, and drill-down jobs share one database write slot. Queries remain read-only from the agent's perspective; their internal receipt persistence requires this slot. Waiting jobs have a bounded queue, an explicit timeout, and cancellation. A running worker keeps its slot until termination completes. A failed initializer releases its slot so a later request can retry initialization.

SQLite's busy timeout is set before initialization, failed setup closes its connection, and receipt insertion and retention run in one transaction. Existing databases and source files are preserved.

Verification:

- `npm run test -w @genoffice/shell -- tests/analytics-service.test.ts tests/analytics-store.test.ts tests/preload-analytics.test.ts tests/settings-analytics.test.ts`: 18 passing tests, including admission, initialization failure, cancellation, read-only access during an uncommitted write, and receipt rollback.
- `node tools/analytics/test.mjs`: 65 passing core and real-worker tests, including fresh database concurrency and overlapping import/status/query requests with durable receipts.
- `npm run typecheck -w @genoffice/shell`: passed.
- `npm run build -w @genoffice/shell`: passed; rebuilt main process, analytics worker, preload, and renderer.

Restart Nawa after rebuilding so the main process and worker use the same updated protocol. Requests that need to save a result wait for an active import/review; status and catalog reads remain available.
