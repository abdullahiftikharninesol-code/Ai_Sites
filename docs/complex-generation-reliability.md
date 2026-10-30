# Complex generation reliability: forensic findings and release gate

This task uses one agent, no external model requests, no paid jobs, no shared
Mongo/GCS writes, no deployment and no live generation. Temporary builds,
Chromium profiles and private diagnostic files use D:. Existing user services
are not restarted. Existing unrelated worktree changes are preserved.

## 1. Actual job findings

The development outer-request registry is in memory. Its original direct
outer-request-to-pipeline mapping was not retained. The following correlations
use the unique exact persisted error and the failed-job timestamps, rather
than claiming a recovered direct mapping.

| Outer request supplied by user | Correlated persisted pipeline job | Persisted project |
| --- | --- | --- |
| `67070e5c-3ad6-4122-bc6d-1a4a66a38aec` | `cb52d5a0-fb48-4a98-8c49-a2ada0eb00d4` | `20557c0e-d4f3-43cb-ab81-c9ca0262bfd3` |
| `19573897-ad7e-4e77-9903-4b3fe9070462` | `f19417bd-56a6-4c4d-919a-1b7da83f7b4f` | `e09ac85b-249b-4cf3-8807-fb7a5ffbc9ca` |

### Job 1

The persisted terminal exception is `VALIDATION_FAILED`: **Build repair find
text was not found in src/App.tsx; supply a unique verbatim source anchor**.
The terminal stage is PATCH_APPLICATION. The rejected find/replace operation
and the exact repair-request source snapshot were not retained. Therefore it
is not possible to establish whether that historical anchor was invented,
stale, formatted differently or otherwise incorrect. No unseen patch is
reconstructed or claimed fixed.

Two upstream platform defects are independently reproducible from the original
request and retained candidate:

* `## Page N — Name` declarations were not recognized. The three-page request
  lost page ownership; incidental Agents/FAQ mentions became planned routes
  and Contact was omitted from the planned QA routes.
* The source route analyzer did not understand the candidate's trailing-slash
  normalization, `window.location.pathname.replace(/\/$/, '') || '/'`, followed
  by sequential page assignments. It recorded only Home. QA therefore searched
  Home for tabs that were implemented on Services.

The unchanged candidate reproduces the original three tabs failures using the
recorded contract. With corrected parsing and routing, tabs pass on Services,
but the candidate correctly fails the Contact accordion requirement on all
three viewports. Its FAQ exists on a separate `/faq` page, while the original
request explicitly required it on Contact. The source remains incomplete;
incorrect planning/ownership contributed to the bad contract. This task does
not silently accept that omission or patch the retained candidate.

### Job 2

The persisted terminal error reports an absent dialog trigger across candidate
routes and all three viewports. The request explicitly required project cards
to open project details. The post-repair candidate implements a real Work page
with content-rich project-card buttons and a conditionally rendered native
`<dialog open aria-labelledby=...>`, useful detail content and two working close
controls. Those buttons' accessible names contain the project content, rather
than the probe's expected “View/Open/Details” wording. The QA discovery rule was
too narrow; the implemented dialog was missed.

The unchanged candidate reproduces the original dialog failures before the
fix. After the discovery correction those failures disappear. Full replay also
exposed a separate, reproducible mobile form actionability failure: a pointer
left by an earlier probe caused a hover transform transition, and automated
scrolling placed the submit button beneath the sticky header. Three offline
replays failed before pointer/transition preparation and three passed afterward.
The form's validation and honest local confirmation are still exercised by a
normal, unforced click. Source, CSS, handlers and QA severity are unchanged.

The retained candidate records a prior TS18048/TS2345 compiler repair around an
optional link destination. Its applied patch has digest/location metadata, but
the original pre-repair source and raw repair proposal were not retained. The
dialog finding concerns the retained, successfully built post-repair source.

## 2. Available and missing evidence

Recovered privately through read-only queries: original prompts, persisted job
accounting/errors/timestamps and draft project commit state. Existing local
artifacts provide retained source, functional requirement records, summarized
resolved contracts, QA reports/screenshots and available repair metadata.

Original prompt SHA-256 identities:

* Job 1: `9cfb5e03e733a75dbff49923d5e268d99f5e10b1e1f8514808331c42481c71fa`
* Job 2: `cdd9dd1a8a13f8dc799bc7a4a4f3ac9ed4fe663139e2a644810655e8dc62e5ec`

Private investigation evidence is under
`.sites-runtime/diagnostics/complex-generation/`. Retained candidate identities
are `candidate-37d89231736cf34ec9f2c0b003f9458a.json` and
`candidate-80d593a714a657f8e9eebba72ba5fd4b.json` under the playground diagnostics
directory. These files are not published artifacts or API responses.

Missing: durable original outer-to-pipeline correlation, complete original
SiteSpec/planner transcript, original provider transcripts, Job 1's exact failed
repair snapshot/proposal, and Job 2's original pre-repair source/proposal. A
summary of the resolved contract omits target details; replay restores those
from the retained complete requirement records. The corrected contract is
explicitly a deterministic reconstruction from the recovered prompt, not a
claim that the original SiteSpec was recovered.

The earlier capture used the same diagnostic identity for original QA failure
and subsequent failed repair. Exclusive creation correctly avoided overwriting
the original, but also lost the later repair evidence. Failed repair capture
now uses attempt 2, separately preserving attempt 1. Capture includes bounded,
whitelisted source-context/proposal text and digests, with security scanning,
environment-secret/JWT/credential redaction and existing limits of five files,
24 hours and 2 MiB per file. Oversize text is omitted, with identities retained.
The server-generated outer request ID is now forwarded to private capture.
Raw repair source/proposals are not attached to public error metadata.

## 3. Platform defects versus generated-source defects

| Finding | Attribution | Result |
| --- | --- | --- |
| Numbered page headings lost | Platform requirement extraction | Fixed generically |
| Normalized pathname/sequential routing lost | Platform AST route analysis | Fixed for verified supported normalization |
| Equivalent FAQ wording lost page ownership | Platform intent/placement drift | Existing capability intent reused for ownership |
| Valid project-card dialog missed | Platform behavioral discovery | Fixed, real open/content/close proof retained |
| Mobile form hover/scroll interference | QA action preparation | Fixed with pointer/transition preparation and normal click |
| Contact FAQ absent in Job 1 source | Actual incomplete candidate with incorrect upstream contract | Correctly rejected |
| Job 1 rejected repair anchor provenance | Missing historical evidence | UNKNOWN; fail-closed behavior retained |

## 4. Source-editing strategy

The existing verified resolver is retained: exact anchors, verified line-ending
equivalence, AST-checked safe indentation, source revision/excerpt checks,
ambiguity/overlap/cascade rejection, atomic preflight and write rollback.
No anchor is guessed, no required operation is dropped and no arbitrary
duplicate occurrence is replaced. Its matching algorithm is not changed in
this task. New repair evidence makes future anchor mismatches attributable.

| Alternative | Reliability and risk | Calls, latency, tokens and resources | Decision |
| --- | --- | --- | --- |
| A: verified contextual text patches | Safe when source/excerpt identity and unique matching are proven; rejects unsafe proposals | Existing bounded repair call, small text parsing cost | Retained |
| B: structured/AST transformations | Useful for narrow syntactic facts; arbitrary semantic rewrites still need a proven change contract | Local AST work adds no provider request | Used for route recognition; no unjustified general source rewriter |
| C: source-hash-guarded whole-file replacement | Hash proves the starting file, not that unrelated behavior was preserved; compilation alone cannot prove intended scope | Potentially larger output/tokens and more validation; no measured live cost | Not implemented without evidence and scope proof |
| D: autonomous iterative agent | Larger uncontrolled change surface; no evidence it is required for these defects | Extra iterations increase latency, token use and resource consumption | Not implemented; budgets unchanged |

## 5. Dialog and functional-contract changes

Mandatory capabilities keep their stable IDs, page/section ownership, actual
resolved routes, source assessment and behavioral expectation. Numbered page
declarations support alternate separators and explicit nested route names;
nested FAQ/Team headings stay sections of their declared page. Existing
exclusion, optional-intent, contradiction and unsupported-transaction behavior
is exercised by the release corpus rather than replaced with a new model call.

Dialog discovery prioritizes managed/ARIA hints, semantic names and content
cards, then examines a bounded set of other buttons. It verifies control
identity after page reset, requires an actual accessible native/ARIA dialog,
checks meaningful content and independently tests every visible enabled Close
control. Unexamined controls after budget exhaustion remain a QA execution
failure, not fabricated evidence of absence. Missing, decorative, empty and
broken-close dialogs remain blocking. Forced clicks and DOM-invoked handlers
are not used.

Form preparation moves the pointer away, scrolls the submit control into the
viewport centre and waits at most 800 ms for its transform transition to
settle. The normal click retains its 800 ms timeout and interception checks.
Covered controls still fail; network submissions are still blocked and honest
on-page demo feedback is still required. Existing route/run deadlines remain.

## 6. Files changed for this task

Earlier universal-hardening changes in the dirty worktree are not attributed
to this task or reverted.

* Parsing/ownership: `src/sites/generation/requested-pages.ts`,
  `functional-route-contract.ts`, `functional-source-contract.ts`.
* Behavioral QA: `src/browser-qa/dialog-behavior.ts`,
  `functional-capability-checks.ts`, `functional-route-probes.ts` (bounded
  diagnostic head/tail preservation).
* Private evidence/correlation: `src/sites/generation/failed-candidate-evidence.ts`,
  `local-site-generation-pipeline.ts`, `src/cli/runtime/build-repair-patch-resolver.ts`
  (private evidence fields only), `local-cli-agent-runtime.ts`,
  `src/dev-server/playground-service.ts`.
* Release coverage: `tests/complex-generation-reliability.test.ts`,
  `tests/complex-generation-pipeline.test.ts`,
  `tests/fixtures/complex-generation-sites.ts`,
  `scripts/run-complex-generation-release.mjs`, `package.json`,
  `eslint.config.js`, `.gitignore`, and this report.

No frontend, billing formula, agent registry, template catalog, published source
or persistence/history architecture is changed by this task.

## 7. Real build and browser coverage

The release gate runs nine positive site fixtures: portfolio, multipage agency,
ecommerce, SaaS, education, restaurant, directory, dashboard and a long mixed
request. These use deterministic mock-provider output and reusable components;
they test the actual compiler/Vite, static validation, browser interactions and
pipeline persistence/finalization, not AI output quality or visual diversity.
Each uses real desktop/tablet/mobile Browser QA and verifies current-source
commit, once-only mock billing, closed browser contexts, destroyed environments
and closed preview ports. Local repositories replace shared persistence.

A tenth pipeline fixture intentionally supplies behaviorally identical tab
panels, then returns an invented repair anchor. It must fail first for missing
tab behavior and finally for PATCH_APPLICATION/MISSING_FIND_TEXT, retain both
diagnostic attempts, make exactly two mocked requests, leave no accepted source
and never finalize successful-job billing.

Additional suites cover real TS2322 build/repair, malformed/missing repair
anchors, duplicate/contextual/unsafe patches, rollback, Targeted Edit scope,
once-only billing, unusual/nested routes, vague/negative/contradictory prompts,
unsupported transactions and bounded QA failures. Native-open/native-modal and
ARIA dialogs, role buttons and explicit dialog anchors are tested alongside
genuinely broken implementations. Redaction and bounded repair evidence have
a focused regression.

The separately selected exact-template workflow regressions for Ecommerce Store
v1, Corporate Business v2 and Restaurant v2 all pass with real builds/three-
viewport QA and their existing mock Targeted Edit checks. Published source is
loaded byte-for-byte; no catalog/GCS access or shared project creation is used.
These template QA reports are `PASS_WITH_WARNINGS`, with **zero blocking
failures** and 15 advisory warnings each. Ecommerce includes 15 advisory failed
checks; they are not claimed as zero total findings. Existing warning severities
and acceptance policy are preserved.

Final retained-source replay: Job 1 builds and passes source validation, with
178 QA checks passed and three correct Contact FAQ failures (44 inapplicable
checks skipped). Job 2 builds, passes source validation and has **289 QA checks
passed, zero failures**, with 71 inapplicable checks skipped, across every actual
route and desktop/tablet/mobile. Both replay assertions verify source files
remain byte-for-byte unchanged. Job 2's focused Contact mobile replay also
passes three consecutive runs after the readiness correction.

## 8. Repeatable release command and results

Run `npm run test:complex-release` (`npm.cmd` in PowerShell). It runs the selected
suites twice, serializes Vitest workers, uses D: temp/cache/profile paths, clears
provider keys, uses mocked providers and disables shared database endpoints.
It fails on test errors, missing/invalid reports or fixture metrics, incomplete
fixture counts, detected cleanup leaks, inconsistent pass/fail outcomes, or
source/config/test changes during the run. JSON reports retain per-test states
and per-fixture build/QA/cleanup metrics in `.sites-runtime/complex-release/`.

Final gate: **PASS**, 273 tests passed in each of two runs (546 passing test
executions), zero unexpected failures, 100% pass rate and zero observed flaky
outcomes. The three additional selected template-workflow tests also pass;
their ten unselected tests were intentionally filtered out, not executed.

| Measurement | Pass 1 | Pass 2 |
| --- | --- | --- |
| Passing / failing tests | 273 / 0 | 273 / 0 |
| Instrumented pipeline fixtures | 10 | 10 |
| Instrumented build time | 28.926 s | 33.720 s |
| Instrumented Browser QA time | 242.208 s | 286.768 s |
| Sum of suite durations | 420.979 s | 489.195 s |
| Browser/environment/preview-port cleanup failures | 0 | 0 |

Build/QA timing rows cover the ten instrumented complex pipeline fixtures, not
every build in the other suites. These are local development timings, not a
production latency benchmark. The exact-template checks and retained-candidate
replay also used local resources during validation.

The fingerprint of source, tests, runners and selected execution configuration
was identical before and after both passes:
`36fc4d7c6792d314539569a7512accba9c6c558ca98e066f29f23b71913993ff`.
No owned release/replay Vitest workers or test-profile Chromium processes
remained in the final process inspection. Every instrumented preview TCP port
was closed and its environment destroyed.

Machine-readable evidence:
`.sites-runtime/complex-release/2026-10-30T04-58-18-793Z/release-summary.json`,
with `run-1.json`, `run-2.json` and per-fixture JSONL metrics alongside it.
Backend/test typecheck, backend production build, scoped lint (zero errors), and
`git diff --check` all pass. No live evaluation was run.

## 9. Failure counts by stage

Historical candidates with their recorded contracts: Job 1 reproduces three
functional tabs failures; Job 2 reproduces three dialog failures. Both build.
Corrected contracts must continue to reject Job 1's missing Contact FAQ.
Expected negative-fixture failures are recorded separately from unexpected
release-test failures. They are required assertions, not a waived QA failure.

Across the ten instrumented pipeline fixtures per pass, positive fixtures have
zero failed static/build/QA/persistence stages. The deliberately invalid tabs
fixture records three FUNCTIONAL_FAILURE findings per pass (one per viewport),
then one PATCH_APPLICATION rejection per pass. Totals: six expected functional
findings, two expected patch rejections and **zero unexpected test failures**.
The other suites separately assert compiler/validation/ambiguity negatives;
those assertions are not included in this instrumented-stage count.

## 10. Provider accounting and billing safety

| Persisted job | Model | Logical / physical / retries | Input / output / reasoning tokens | Credits | Accepted source |
| --- | --- | --- | --- | --- | --- |
| Job 1 | gpt-5.6-luna | 2 / 2 / 0 | 9027 / 8666 / 568 | 0, NOT_CHARGED | None; draft/version 0 |
| Job 2 | gpt-5.6-luna | 2 / 2 / 0 | 11273 / 9437 / 353 | 0, NOT_CHARGED | None; draft/version 0 |

Reasoning tokens are an output subcategory, not additional billable totals.
Cached input tokens were zero; total tokens were 17693 and 20710 respectively.
The original full billing ledger was not needed to invent an alternative
charge: these values are the actual persisted job accounting/commit state.

Investigation/implementation external provider requests: **0**. Real credits:
**0**. Shared writes: **0**. Inference limits, repair roles, successful-job billing
formula, exact-template loading, Targeted Edit and current-version-only commit
behavior remain unchanged. Billing tests use isolated doubles and repositories.

## 11. Remaining risks

Offline fixtures cannot establish the pass rate of arbitrary model output.
The exact historical missing anchor cannot be attributed without its absent
proposal/snapshot. Bounded diagnostics can omit secret-bearing/oversize source
or expire; they are development-only and not a durable production audit log.
Dialog discovery has a finite control budget and correctly reports uncertainty
when exhausted. Only verified routing expressions are statically recognized;
unrecognized custom behavior still requires behavioral proof. High-concurrency
production capacity and real-provider output variance require separate tests.

Existing user services were intentionally left running with their existing
loaded code. A later authorized restart is required to load these source changes.

## 12. Controlled live evaluation recommendation

After offline gates pass, obtain separate explicit authorization for nine
manual positive jobs, one per fixture category. Include short/vague and
long/nested variants within those nine rather than adding unbounded jobs.
Check negative/unsupported requests through preflight; unsupported transactions
should reject before model calls. Stop the evaluation on the first unexpected
failure. Record outer/pipeline IDs, contract digest, roles,
physical calls/tokens, source revision, compiler/QA stages, cleanup and actual
billing. Inspect real responsive behavior and current-source reload. Preserve
the existing budgets; stop on failure and inspect retained evidence instead of
automatically submitting another job. Compare per-category failure rates and
latency, then separately evaluate concurrency before production deployment.

No part of that paid/live evaluation is executed by this task.

Status: **COMPLEX_GENERATION_RELIABILITY_READY_FOR_EVAL**.
