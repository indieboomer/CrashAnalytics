# Validation record

Validated 2026-10-03 on Windows with Node 24.14.1 and npm 11.19.1.

- `npm run typecheck`: passed.
- `npm test`: **18 tests passed**, no vendor credentials required.
- `npm run build`: production React/Vite build passed.
- `git diff --check`: passed (Git reports expected line-ending conversion).
- `git check-ignore .env .local/data/crashlab.db`: both ignored.
- Live localhost smoke: UI HTTP 200, empty real-data directory, missing-credential/missing-decoder capability states, API without token HTTP 403, invalid Host HTTP 403.

Regression coverage includes immutable/database-scoped/idempotent reports; repeated machine incidents; nested XML queues and unknown statuses; empty text breadcrumbs; driver conflicts; duplicate attachment filenames/byte deduplication; DTD/nesting/traversal/decompression rejection; separate signatures and unknowns; minimized/pseudonymized packets; invalid hypothesis citations; failed sync page retention/resume; keyset overlap; delayed attachments; signed-URL refresh; HTTP 429 Retry-After; nonretrying auth errors; log line provenance; compatible exposure denominators; subprocess crash/timeout isolation; and rejection of unmapped historical source.

An isolated localhost application test imports only synthetic fixtures into a temporary private directory and exports a Polish packet. A synthetic local provider tests reviewed evidence tools, tool audit records, validation and caching. These are **not live vendor/paid-model validation**. Browser rendering/interactions were not exercised with an automated graphical browser; production compilation and HTTP workflow were checked.

Native build subsequently verified with the supplied SDK on 2026-10-03 using Visual Studio 2026/MSVC 19.51 and bundled CMake 4.3.1. The executable's runtime probe returned `crashlab-decoder/1 SDK API 539`.

Pending external checks: BugSplat authentication and account permissions, real report/archive retrieval, real XML/GPU bytes; successful decoding of a real dump; resolved shader mapping and visual comparison in Nsight; historical executable/PDB/shader identity verification; paid provider output quality. See decoder-compatibility.md and bugsplat-api-verification.md for exact prerequisites.
