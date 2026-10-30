# Vertex JSX build failure: correction and regression evidence

The live failed request is `ecb411f7-a84b-4cab-90f6-16d0654c24e7`, pipeline
`ee21358d-4f4f-47c6-b7de-3c55a1b9b068`, project
`88066eae-7a9c-418b-8aa4-b16a070e3934`.

## Proven failure

Site Coder produced one redundant consecutive `</div>` in Contact's return
expression, `src/App.tsx:96`. The initial compiler reported TS17002 for the
enclosing section/main, followed by cascading TS1005/TS1109 errors. The single
model repair matched its source exactly once and applied, but retained the
same erroneous ending. It also removed company, service and budget fields.
Build failed again and the existing allowance was exhausted. Browser QA was
not reached; persisted billing is NOT_CHARGED, credits 0, draft version 0 and
no accepted source.

This is neither the earlier ambiguous-anchor failure nor the earlier dialog
discovery problem. The new private capture retained the exact proposal,
snapshot/context identity, both compiler messages and direct outer request ID.

The original generated source was reconstructed through the uniquely recorded
inverse patch and verified against snapshot SHA-256:
`c9b055354c26b19ac482c93611bce079a1d2d8ec1d80e32721361845036ffaae`.
The recovered original prompt is 3243 UTF-8 bytes with SHA-256
`da3ef880b3bbfa775a5dbf09d48e13be100857c7a5ebaff64907c968e6ecea65`.
The fixture was scanned for secrets before inclusion; diagnostic-only digest
properties were stripped from the recorded proposal to restore its provider
schema. These are real retained inputs, not a guessed failed patch.

## Generic correction

`build-repair-source-safety.ts` recognizes a deliberately narrow parser-proven
case: a mismatched JSX closing element immediately following another closing
element of the same name, separated only by whitespace. It tries at most eight
mismatched closing candidates on files no larger than 256 KiB. A correction is
accepted only when exactly one distinct output has zero syntax diagnostics and
retains the original form-control contract. It deletes only the redundant
closing token; every other byte stays unchanged. It never guesses an opening
wrapper, renames tags, rewrites content or selects between valid alternatives.
Valid nesting, strings/comments, multiple unrelated errors and non-proven
structures remain unchanged.

Generation opts into this correction through the existing deterministic
build-repair stage, before spending a model repair request. Managed files are
excluded. Targeted Edit does not opt into the new transform.

Generation's model compiler repairs now preflight all staged files before any
write. TypeScript/JSX must parse successfully. Existing native form controls
are compared as a multiset scoped to their owning component, field identity
and input type. Required validation, value/checked bindings and submit/change
handlers must remain. Controls cannot be newly disabled, hidden or made
read-only. Constraint-preserving matching handles repeated field names without
depending on declaration order. Unsafe proposals reject atomically with
REPAIR_SOURCE_SYNTAX_INVALID or REPAIR_FORM_CONTROL_REMOVED and remain available
in bounded private diagnostics.

The existing repair request explicitly asks for a narrow delimiter correction
and preservation of all fields, including optional fields. The deterministic
guard enforces this; instructions alone are not the fix. Agent registry,
system-prompt version, inference/timeout limits, billing and QA severity are
unchanged. This task does not add a whole-file replacement, a new role or an
extra provider retry.

## Offline reproduction and tests

The exact recovered request/source runs through the real generation pipeline
with a mocked provider and the real deterministic planner, static checks,
TypeScript/Vite build and Browser QA. All five routes (`/`, `/services`, `/work`,
`/about`, `/contact`) pass desktop/tablet/mobile QA: **181 checks pass, zero
failures, zero warnings**, with 44 inapplicable checks skipped. All six Contact
fields remain. The accepted App source equals the original source with only
the single redundant closing token removed. The pipeline saves current source
and finalizes the isolated billing double exactly once.

That replay makes one mocked initial coder request and zero repair requests.
No external model request or real credit charge is used by the test. The bad
live repair is provided as a mock response but is never needed on this path.

A second real pipeline regression injects a genuine TS2322 compiler error,
then returns a compiling repair that removes fields. The repair is rejected
before source writes, no accepted project source is committed and successful
billing is never finalized. Existing missing/ambiguous anchors, source revision,
overlap/cascade and write rollback tests remain active.

Focused source/patch safety coverage: 49 passing tests. The existing
`npm run test:complex-release` command includes both new real pipeline cases
and the focused regressions, in addition to the earlier diverse generation,
responsive QA, Targeted Edit scope/ambiguity and billing suites. It runs twice
against a stable source fingerprint. Both passes finished successfully:

| Check | Pass 1 | Pass 2 |
| --- | --- | --- |
| Passing / failing tests | 296 / 0 | 296 / 0 |
| Instrumented complex pipeline fixtures | 10 | 10 |
| Instrumented build time | 23.434 s | 21.992 s |
| Instrumented QA time | 226.158 s | 222.909 s |
| Sum of suite durations | 475.660 s | 469.507 s |
| Detected browser/environment/preview-port leaks | 0 | 0 |

There are 592 passing test executions, zero observed flaky outcomes and no
source changes during the gate. The instrumented timing rows cover the ten
complex pipeline fixtures; the two new retained-source/field-preservation cases
are additional cases in the compiler-repair suite, not part of those timing
totals. These are local timings, not a production performance benchmark.

Release evidence:
`.sites-runtime/complex-release/2026-10-30T06-29-27-436Z/release-summary.json`.
Verified source fingerprint:
`07913b3601f376f4c6d91e3d962b45986a4c5f468c53d3cf49fe34dba72dc54c`.
Backend/test typecheck, backend build, scoped lint and `git diff --check` pass.

Files changed for this correction: `src/cli/runtime/build-repair-source-safety.ts`,
`build-repair-patch-resolver.ts`, `site-coder-file-bundle.ts`,
`local-cli-agent-runtime.ts`, `src/sites/generation/deterministic-autofix.ts`,
the two existing build-repair test files, the new `vertex-jsx-failure.ts`
fixture, `.gitignore` and this report. Earlier unrelated worktree changes are
preserved.

## Runtime activation

After the gate passed, the preflight confirmed matching source, Mongo PING,
Redis PONG and zero active jobs. Only stale Sites backend PID 24108 and its
owned preview children were stopped. The freshly compiled backend is PID 5104,
owning ports 4310, 4311 and 8090. There is one backend and no orphaned Vite
preview process. GetChatly frontend PID 21176 was left running; `/login`
returns HTTP 200. Sites health returns HTTP 200 with Mongo connected.

Sanitized job/token/QA-context/billing capture remains enabled in
`.sites-runtime/live-eval/sanitized-backend.log`. The configured model remains
gpt-5.6-luna with provider timeout 180000 ms. Existing inference/repair budgets
are unchanged. Saved projects are retained; already-open previews may need to
be reopened after the backend restart. No live generation is submitted.

Detailed retained-site QA:
`.sites-runtime/build-repair-offline-tests/vertex-live-jsx-regression.json`.
The original failed job is not retried or modified by these local tests.

## Limits

This corrects the reproduced syntax pattern and rejects the demonstrated
destructive repair class. It does not promise that arbitrary future AI output
is valid. Unknown syntax, dynamic/custom controls that cannot be proven
statically, semantic type errors and behavioral defects still require the
existing bounded repair and complete build/Browser QA. Native control
preservation is a structural safety check, not proof of all application
semantics. Unvalidated output must continue to fail rather than appear as a
successful website.

External AI calls during implementation: 0. Real credits: 0. Shared project,
billing or GCS writes during offline tests: 0. No new generation is submitted.

Status: **VERTEX_JSX_BUILD_REPAIR_FIXED**.
