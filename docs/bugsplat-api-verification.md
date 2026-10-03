# BugSplat contract verification

Checked 2026-10-03 against the published official `@bugsplat/js-api-client` **15.7.0** package (source maps, JS and declarations) and official documentation. Dependencies and transitive versions are pinned in package-lock.json. The Node CJS entry is used because the distributed ESM files use extensionless relative imports.

| Operation | Verified contract | Implementation |
| --- | --- | --- |
| OAuth client credentials | `OAuthClientCredentialsClient.createAuthenticatedClient(clientId, clientSecret)` | Preferred if account has an OAuth integration |
| Password session | `BugSplatApiClient.createAuthenticatedClientForNode(email,password,'https://app.bugsplat.com')` | Optional; SSO compatibility not assumed |
| List | `CrashesApiClient.getCrashes({database,page,pageSize,sortColumn,sortOrder,filterGroups})` returns `rows` | Official client, 50 rows, ascending ID |
| Filtering | `QueryFilterGroup.fromColumnValues`, `fromTimeFrame`, `QueryFilter(value,'GREATER_THAN','id')` | Application, build, UTC range and stable ID keyset |
| Detail | `GET /api/crash/details?database=...&id=...`; official client also implements read-only detail via POST | Raw GET through authenticated client preserves unknown fields |
| Attachments | `dumpfile` is a presigned ZIP containing crash file and attachments | Download ZIP without account headers; inventory its entries |
| Individual attachment-list/download endpoint | No separate operation verified in client | No invented endpoint; selective modes still transfer a ZIP |
| Rate limit | No global request quota verified | Serial bounded work, transient retry/jitter; Retry-After respected when supplied |

Official references: [client](https://github.com/BugSplat-Git/bugsplat-js-api-client), [web endpoints](https://docs.bugsplat.com/api-reference/api), [crash details and ZIP contract](https://docs.bugsplat.com/api-reference/api/crash), [listing](https://docs.bugsplat.com/api-reference/api/crashes).

The original README documentation link has moved. The documentation GET detail contract is preferable to the package's detail conversion, which supplies defaults and drops unknown fields. Signed URLs are used transiently and removed before persisted API details. Archive hashes and report associations are preserved. OAuth tokens stay inside the server SDK client. A 401/403 stops account requests with explicit failed job status; reconnect by correcting local credentials/restarting or resuming a job, which constructs a new client.

The first page preview is a bounded page count, **not a guessed total report count**. The full sweep uses ascending IDs and documented ID filtering instead of relying on mutable offset pages. Checkpoints commit after the page's reports and attachments; resume overlaps the last page. Completed individual work survives a page failure. A full backfill rerun re-fetches details and archives to detect enrichment/changed attachments. `--incremental` uses a 48-hour overlapping timestamp window; older delayed enrichment requires a full reconciliation run. The run's upper timestamp is fixed when created.

## Live acceptance gate: pending

No credentials or actual user crash attachments were supplied. Authentication, live bounded listing, report-detail retrieval, ZIP inventory, one XML and one GPU dump byte verification have **not run**. Unit tests use explicitly synthetic vendor responses, not live integration success. Run a bounded sync against a database you can read, inspect attachment hashes/states and verify the downloaded XML/GPU files before a large backfill. API authorization and attachment-host compatibility remain account-specific. Download hosts are restricted to HTTPS BugSplat and AWS S3 hostnames; other vendor storage hosts need verification before extending the allowlist.
