# Local API

The server listens at 127.0.0.1:4317 by default. All requests require an allowed local Host; browser Origins must match. Retrieve a local session token from `GET /api/session`, then send `X-Crashlab-Token` on every evidence request. Tokens are transient and never exported. No CORS allowance exists.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/doctor` | Explicit dependency/capability states |
| GET | `/api/summary?build=...&gpu=...&driver=...` | Deterministic aggregate views with substring cohort filters |
| GET | `/api/reports` | Current local normalized reports |
| GET | `/api/case?id=database%3AreportId` | Local fields, all evidence candidates and attachment manifest |
| GET | `/api/jobs` | Durable job states/checkpoints/results |
| POST | `/api/jobs` | `{kind,payload}`; kind import/sync/decode/ai/exposure |
| POST | `/api/cancel` | `{id}`; preserves completed work |
| POST | `/api/resume` | `{id}` for cancelled/failed jobs |
| POST | `/api/preview-sync` | Sync options; verified bounded first-page count only |
| GET | `/api/packet?cluster=<signature>` | Reviewed, minimized evidence packet |
| GET | `/api/export?cluster=<signature>&language=en|pl` | ZIP; includes latest validated hypotheses only when packet hash still matches |
| GET/POST | `/api/mappings` | List or verify `{build,repository,commit,...buildMetadata}` |
| GET | `/api/source?build=...&file=Source/Game.cpp&start=1&end=100` | Historical Git source, maximum 201 lines |
| GET | `/api/diff?good=...&bad=...` | Read-only bounded mapped-build source/config diffs |

Import payload: `{path: "C:\\PrivateExports\\reports.json", database: "Permafrost"}`. Decode payload: `{}`. Exposure payload: `{path: "C:\\PrivateExports\\sessions.csv"}`. AI payload: `{cluster,packetId}`; mismatch with current evidence rejects the request. Sync payload: `{database,application?,build?,from?,to?,attachments,maxPages?,incremental?}`. Attachments are metadata/xml-logs/representative/all. Source mappings require a full 40–64-character commit hash and available repository. Source commit verification does not verify executable/PDB identities.

Requests are limited to 1 MiB. Account tokens and signed download URLs are never accepted from the UI or returned by these endpoints. Credential configuration is local .env only.
