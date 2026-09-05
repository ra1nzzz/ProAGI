# M1 Implementation Audit and Fix Closure

> This is a post-stitch implementation audit, **not Review Round 6**. The document review sequence remains exactly five rounds.

## Review scope

Three independent YT-Review passes inspected code quality, efficiency/concurrency, and architecture plus blind spots. Findings were evidence-ranked and then fixed by priority. Scores are omitted because the five-round document review score trend is already frozen and 8/10 is not a hard gate.

## P0 closure

| Finding | Closure | Regression evidence |
|---|---|---|
| `Delete Insight` used whole-database clear | Routed the command through the existing fenced target-lineage deletion plan/enumerate/chunk/PURGE/audit/finalize/verify path. Unrelated behavior events remain. The runtime and React projection release the deleted claim before audit and after reload. | `tests/e2e/app.spec.ts` targeted deletion case, desktop + 320 |
| Same source key could persist conflicting facts | IndexedDB schema v2 adds unique `payload.dedupeKey`; identical key/fact retries converge and conflicting facts abort with `ERR_DUPLICATE_CONFLICT`. Upgrade no longer resets meta. | `tests/integration/indexedDbM1b.test.ts` |
| Deletion root coverage omitted the active application root | `BrowserInsightRuntime` registers its canonical in-process root; target deletion cannot finalize while the target ID/hash remains reachable. | privacy root audit + real-browser targeted deletion |
| Whole clear could report success with caches uncleared | Application enumerates/deletes/re-verifies CacheStorage when present and passes an explicit attestation. Adapter defaults missing attestation to blocked and only reports success after empty reopen. | privacy clear contract; application implementation |

## P1/P2 fixes completed

- Preview staging and ImportSession creation now validate ACTIVE mode, recovery mode, cursor/epoch in the same `meta + system` transaction.
- Preview creation is serialized; UI disables the action immediately; raw preview copies have per-item/aggregate bounds and opportunistic expiry cleanup.
- Ambiguous commit-response loss is reconciled against the durable idempotency ledger instead of deleting a consumed receipt.
- Correction persistence no longer stores transient commands. It atomically writes terminal correction, immutable claim revision, KnowledgeVersion and CAS KnowledgeHead; hydration reads canonical lineage.
- Canonicalization rejects NFC-normalized key collisions; semantic IDs are deterministic RFC 4122 version-5 UUIDs.
- Fixture timestamps validate real UTC calendar instants.
- Worker errors preserve allowlisted protocol codes; a backpressured transferred chunk is returned to its owner; strict fixture allowlisting validates accepted worker candidates; stream/count/line limits are bounded.
- Projection heads cannot advance past canonical meta cursor.
- Recovery work bytes are charged against the 5 MiB reserve during enumeration.
- IndexedDB first-open calls share one promise and each connection closes its own handle on version change.
- Shadow sink registry covers all 13 frozen browser effects and real Chromium spies assert zero calls.
- CSP and CI tiers are executable; CI installs Chromium, preserves the verification log, creates evidence, and uploads with bounded retention.
- axe runs on empty and populated canonical states; approved local-sensitive copy remains outside accessible names/live regions.

## Remaining conditional limitations

These are not hidden or converted to PASS:

1. NVDA smoke, human visual approval, and hosted CI are `NOT_RUN`.
2. Cross-tab privacy preview fencing is verified, but cross-tab state propagation and deletion/PURGE coordination are not complete.
3. Deletion page enumeration still uses whole-store materialization internally; it is acceptable for the tiny bundled M1 fixture but not a large-store production implementation.
4. The frozen full `PortRequestContext + DomainResult` surface, complete closed lifecycle/artifact root registry, and every extended SPEC schema field remain broader than the runnable synthetic slice.
5. The byte-worker protocol is contract-tested but the bundled one-fixture UI path remains synchronous and synthetic-only.
6. The independent evaluator covers the M1 rule fixture, not the complete future provenance graph or real-user value.

## Verification conclusion

- Required suites: 11 non-empty suites.
- Vitest: 14 files, **57/57 passed**.
- Playwright Chromium: **16/16 passed** across desktop and 320 projects.
- Typecheck, ESLint, CSP check, dependency audit, and production build: passed.
- Gate 1: **CONDITIONAL**, never PASS, because required manual/hosted and broader cross-tab evidence is absent.
- Final evidence run: `evidence/M1/2026-09-04T17-38-02-616Z/`.
