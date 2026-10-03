# Windows setup and launch

Requires Windows 10/11 and Node.js **24.14 or newer**. Optional source retrieval requires Git. No Python, Docker, Redis or external database is required. The app uses Node's SQLite API, currently marked experimental by Node.

From this repository in PowerShell:

```powershell
Copy-Item .env.example .env # only if .env does not already exist
npm ci
npm run check
.\launch.cmd
```

Open **http://127.0.0.1:4317**. `launch.cmd` creates a blank .env if absent, installs dependencies if missing, builds the React UI and starts the server. `npm start` runs a previously built UI; `npm run dev` runs the same server with TypeScript source. Stop with Ctrl+C. Change `CRASHLAB_PORT` in .env if required.

Choose a data directory with `CRASHLAB_DATA_DIR` in .env and restart. The default is `.local/data`. The database, artifact objects, private machine-pseudonym key and job records are local. Choose an NTFS directory accessible only to your Windows user. The .env file is git-ignored and never served or exported; .env.example contains only placeholders. Never put credentials in React configuration, source files, URLs, fixture files or reports. Values containing spaces can be quoted. Existing process environment values take precedence over .env. Local configuration is plaintext protected by your Windows filesystem permissions, not an OS credential vault.

## Offline use

```powershell
npm run cli -- doctor
npm run cli -- import 'C:\PrivateCrashExports\reports.json' --database Permafrost
npm run cli -- import 'C:\PrivateCrashExports\attachment-folder' --database Permafrost
npm run cli -- summary
npm run cli -- investigate --cluster <signature>
npm run cli -- export --cluster <signature> --language en --output '.local\investigation.zip'
```

Import supports arrays and objects with `rows`, `reports` or `crashes`, standalone report objects, XML with CrashGUID, directories and ZIPs. Identity is database plus report ID; absent IDs use CrashGUID or a content hash. Report ID folders and CrashGUID support association. Ambiguous attachments are retained as unassociated objects and explicitly reported. Review conflicts and missing fields in Cases. Unknown export shapes/field aliases require a parser extension with fixtures; raw data stays preserved.

To try labeled invented data:

```powershell
npm run cli -- import fixtures/synthetic/reports.json --database synthetic
```

The app does not auto-load demo data. Demo reports use application `SyntheticDemo` and database `synthetic`; these must not be treated as live Permafrost findings.

## BugSplat

Set `BUGSPLAT_CLIENT_ID` and `BUGSPLAT_CLIENT_SECRET` locally using an integration supported by your account. Alternatively set `BUGSPLAT_EMAIL`/`BUGSPLAT_PASSWORD` for supported password accounts. SSO-only accounts may require OAuth credentials; do not assume password login works. Restart the app, select database/filters and preview a bounded first page before sync.

```powershell
npm run cli -- sync --database Permafrost --attachments all --max-pages 1
npm run cli -- sync --database Permafrost --attachments all --from 2026-09-01T00:00:00Z --to 2026-10-03T00:00:00Z
npm run cli -- sync --database Permafrost --attachments all --incremental
npm run cli -- jobs
npm run cli -- sync --database Permafrost --resume <job-id>
```

Stop the UI server before CLI sync jobs use the same data directory; one durable worker owns a directory. Read-only CLI commands remain usable. A page-budget stop is resumable. Metadata mode does not download ZIPs. XML/log and representative modes transfer the ZIP to inventory it, retain the raw archive, and materialize selected files. Reconciliation may transfer identical archives again; SHA-256 deduplicates their storage. `CRASHLAB_QUOTA_MB` caps artifact storage, not SQLite overhead. Refresh failed jobs in the UI; completed artifacts are retained. No remote report mutations exist in the adapter.

## NVIDIA decoder

See [decoder compatibility](decoder-compatibility.md). Without the SDK/wrapper, imports and investigation packets still work and dump status remains explicit.

## Optional AI

The provider adapter expects a Chat Completions-compatible API with function tools. Set `AI_BASE_URL` to its API base (for example a provider's documented base ending in `/v1`), `AI_API_KEY`, and `AI_MODEL`. No model is hardcoded; a ChatGPT subscription is not treated as API access. External providers require HTTPS; localhost HTTP is supported. Provider credentials stay server-side.

Review the packet in Investigate before clicking **Send reviewed packet**. Evidence changes invalidate the reviewed packet and cached analysis. Packet size is capped at 128 KiB, output at 4,000 tokens maximum, tool rounds at three, calls per round at eight, total time at 60 seconds. `AI_MAX_REQUESTS_PER_DAY` defaults to 10 HTTP calls, including failed attempts; `AI_MAX_OUTPUT_TOKENS` defaults to 2,000. These bound use, not a currency guarantee because provider pricing is configurable. Read-only evidence tools access only reviewed evidence IDs; requests and results are logged locally. Mechanical validation checks schema and supplied evidence IDs; it cannot prove the semantic correctness of a model's claim.

No key is needed for ZIP packet export. Unzip and open report.md/packet.json in Codex. Binary dumps, raw reports, account credentials and player text are excluded. The packet uses stable project-local machine pseudonyms. Review redacted excerpts before sharing.

## Optional exposure CSV

```powershell
npm run cli -- exposure 'C:\PrivateCrashExports\successful-sessions.csv'
```

Required columns: `period_start,period_end,build,gpu,driver`; at least `sessions` or `distinct_machine_ids`; optional `gameplay_hours`. Periods require UTC offsets and use start-inclusive/end-exclusive matching. Cohorts match exact build/GPU/raw driver labels. Overlapping cohorts are rejected. Repeated incidents are not counted as separate machines. Rates are reported incident/exposure ratios, not calibrated individual crash probabilities. An example is in fixtures/synthetic/exposure.csv.

## Troubleshooting

- Missing UI: run `npm run build`.
- Failed password authentication: check account/SSO support and use supported OAuth integration credentials.
- Expired attachment URL: the adapter refetches report details once; resume a failed job if needed.
- Quota: increase `CRASHLAB_QUOTA_MB` or choose a larger private data directory; restart.
- SDK DLL failure: check AFTERMATH_SDK_PATH points to the matching SDK root; the app adds its lib/x64 or lib DLL directory to the process PATH. Restart after changing .env.
- A worker is already running: use the existing UI or stop that server before starting CLI jobs. A stale process lock is recovered on startup.
- No XML association: preserve report-ID folders/CrashGUID; ambiguous mappings are intentionally not guessed.
- Driver discrepancies: inspect all evidence candidates; display and internal labels are not converted.
- Large provider packet: select a narrower family; exported packets remain available without AI.
