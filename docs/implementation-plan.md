# Implementation plan

1. Verify official vendor contracts; keep live acceptance gates pending without credentials/SDK/fixtures.
2. Build immutable content-addressed storage, SQLite migrations, provenance-aware JSON/XML/tree/ZIP import and deterministic analysis.
3. Add localhost API and React workflow, durable resumable sync/decode jobs, bounded subprocess execution and native SDK wrapper.
4. Add minimized evidence packets, optional validated provider analysis, English/Polish ZIP export and read-only historical build mapping.
5. Run regression tests, typecheck and production build; document exact launch instructions and remaining external gates.

Credentials live only in ignored .env. Private artifacts, SQLite, pseudonym key and job logs live in ignored .local by default. No live or synthetic success is substituted for a vendor acceptance check.
