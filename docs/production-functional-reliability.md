# Functional generation reliability

Generation uses one deterministic checklist of requested capabilities and their page/section ownership. Extraction scans the full prompt, deduplicates requirements, handles Markdown exclusions, and rejects explicit include/exclude conflicts before planning or project creation. An arbitrary prompt is not guaranteed to be supported: existing backend/transaction restrictions still apply.

The initial Site Coder request now receives the same compact capability API contract as repairs. Only requested capabilities are listed. The contract documents the managed controllers, main content, standard anchor props, event-listener cleanup, and working tab/menu relationships. `PageContent` and `SiteLink` are available from `./sites-ui/functional`; existing cart, filters, tabs, forms, gallery, accordion and dialog APIs remain available. Custom implementations remain supported.

Static evidence keeps three states: recognized, proven missing, and uncertain. Recognized syntax still requires behavioral proof; uncertain implementations go to Browser QA. Proven missing required behavior can use the existing repair allowance. No state bypasses source validation, production build, or required behavioral QA.

Behavior probes prefer semantic landmarks but do not mistake a missing `main` tag for absent page content. Navigation must reach meaningful visible page content beyond header/footer boilerplate. Tab probes prove local meaningful panel changes and restoration, rejecting selection-only or unrelated counter updates. Menu probes prove newly reachable real links and their disappearance on close. Explicit `aria-controls` relationships must resolve correctly; a broken relationship is not ignored. Bounded hydration waits avoid inspecting an empty React root immediately after navigation. Accessibility checks retain their existing severities.

Static navigation/control failures, proven missing functionality, compiler errors and eligible Browser QA functional failures share the **existing one Build Repair allowance**. A functional repair patches the exact source snapshot, then repeats source validation, build and complete Browser QA. If compilation already spent the allowance, QA cannot create another slot. Infrastructure/timeouts and nonfunctional blockers do not trigger functional model repair. There are no new roles, provider retries, successful-job billing rules, or template mutations.

Browser QA runs before acceptance. Success commits current source and finalizes billing once. Failed candidates cannot become an accepted current version and have no successful-job charge. Private development diagnostics can retain the original and one repaired candidate under the existing global file/size/age bounds; repeated capture does not overwrite the first evidence for that attempt. This does not add user version history.

Runtime page/console error checks run after interaction probes so uncaught exceptions from buttons and forms are included in the final report, not only startup errors. Existing error severities are unchanged.

Menu toggles are bound to stable control identity, not repeatedly resolved by a mutable accessible name: `Menu` becoming `Close` is valid. Controlled-panel relationships still must resolve, real links must become reachable, and closing must hide them. Dialog probes test each enabled visible dismissal control separately, including two Close controls or duplicate Close labels, and prove the panel disappears after each. Neither selector ambiguity nor a cosmetic state change counts as functional success. QA failures retain their actual `BROWSER_QA` classification instead of being logged again as static failures.

Run the focused offline suite:

```powershell
npm run test:functional-production
```

The runner keeps temporary projects/browser profiles, Node compile cache and npm logs beneath the checkout's `.sites-runtime` directory (D: on this workstation). It uses offline npm mode and existing installed dependencies/browser binaries. It does not migrate global Windows settings or run a live AI request. Individual suites can be passed to the runner directly.

Regressions cover short/long prompts, the live no-main/custom-panel/div-menu pattern, working and broken native/custom controls, mandatory route QA, a successful functional repair, exhausted compiler repair, failed repair with no third request, current-source persistence and synthetic once-only billing. Live model quality still requires a separately authorized acceptance test; offline fixtures do not establish success for every possible prompt.

## Universal generation hardening: offline acceptance gate

The 2026-10-29 failure was pipeline `f5a347bc-8bd9-453b-80c2-c64e0a9e0488`
(outer request `86c32e17-0e90-4aee-8657-f73a8d577599`). It was a platform
scaffold collision, not a provider outage or an arbitrary-selector false alarm.
The generated navbar and the Sites-managed floating theme switch both used
`.theme-toggle`. Managed CSS positioned both at the same fixed coordinates;
the later button's SVG intercepted the earlier button's normal pointer actions.
The hidden-responsive-control hypothesis was not supported: both buttons were
visible, and the same collision occurred on both routes at all three widths.

Before changing product code, the exact retained candidate built successfully
and reproduced the six original blocking failures. The small collision fixture
also failed at desktop, tablet and mobile widths. The managed switch now uses
its own class and `[data-sites-managed="theme-toggle"]` styles. Regenerating
only those Sites-owned scaffold pieces, while preserving generated App and
portfolio CSS bytes, produced **63 passed, 0 failed, 27 skipped**. The skipped
checks are checks without an applicable requested capability; no failed check
was disabled. Private before/after reports remain under
`.sites-runtime/route-aware-tests/retained-theme-{before,after}.json`.

The capability-specific checks continue to use requirement-to-route mappings
and semantic controls. `functional.controls` intentionally audits a bounded
set of visible buttons in addition to those capability-specific checks; it is
not used as proof that an accordion, search or cart requirement is complete.
Own-child SVGs and hidden responsive alternatives pass normal pointer checks.
An unrelated subtree covering a button remains blocking. Neither `force:true`
nor longer hover deadlines are used.

## Request and implementation contracts

The expanded suite also reproduced an independent false rejection: the tab
probe required four words in changed content. A valid three-word service
description and a short price failed. Content must now be visible, distinct
from tab labels, nonempty and meaningful, actually change on selection, and
restore on the original selection. Explicit panel relations and locality remain
required; label-only, punctuation-only, unchanged, wrong-panel and decorative
implementations remain rejected. No generated copy is lengthened to appease QA.

The deterministic corpus covers portfolio, agency, ecommerce, restaurant,
corporate consulting, SaaS, education, real estate, editorial, healthcare,
dashboard and mixed-content requests. Each case has independent expected
capabilities and is checked with short and long prompt variants. Additional
cases cover optional features, negative constraints, explicit contradictions,
alternate route names, vague inspiration and unsupported real transactions.
This corpus tests deterministic interpretation; it is not twelve live model
generations or a measurement of model success rates.

Optional suggestions are recorded separately from mandatory completion gates.
An optional clause cannot erase a separate required feature. Explicit exclusions
remain available to generation guidance. Unsupported live payment/booking work
fails before planner/provider calls or draft creation. The existing complexity
patterns are unchanged; they operate on affirmative requirements so a ban on
checkout does not itself request a transaction planner. The original prompt
still reaches generation. Brand/content/design planning, optional Site Planner,
route ownership and conservative recognized/missing/uncertain source analysis
remain the existing mechanisms.

The initial Site Coder receives only relevant functional APIs and route
guidance, plus a compact instruction that the managed theme control already
exists and reserved controls must not be restyled. No extra model role or
inference allowance is added. The exact published-template instantiation path,
Targeted Edit scope/patch resolution, source snapshot/digest repair safety,
current-project persistence, rollback and billing formula are preserved.

## Failure categories and deadlines

Behavior probes throw a typed functional assertion only when their observed
postcondition fails. Arbitrary checker exceptions are not proof of a model
defect. Reports and bounded private diagnostics retain `failureKind` for:

- Functional failure, navigation failure and browser runtime error.
- Browser/selector infrastructure failure and unknown check execution errors.
- Pointer actionability timeout, readiness timeout and individual check timeout.
- Route deadline exceeded and total run deadline exceeded.

Every such blocking failure keeps the website unaccepted. Timeouts and checker
infrastructure errors cannot spend a functional model repair request. Only a
proven functional failure can use the existing shared repair allowance. For
older reports without typed metadata, the existing conservative timeout guard
remains in place. No third coder/repair call or new retry loop is introduced.

| Boundary | Existing limit / behavior |
| --- | --- |
| Configured provider | 180000 ms in the reported live configuration; unchanged |
| Runtime generation task | Task limit or 600000 ms; unchanged |
| Production build | Task limit or 60000 ms; actual compiler/bundler rerun after repair |
| Local preview startup | Execution adapter configuration, default 15000 ms; unchanged |
| Browser launch | 30000 ms, at most one existing timeout retry |
| Route navigation | 15000 ms, also bounded by remaining route/run budget |
| Pointer actions | Existing 800 ms; unchanged |
| Generic/required functional checks | Existing 8000/12000 ms, capped by remaining route budget |
| Route | Existing 30000 ms, now actually enforced |
| Complete QA run | Existing 120000 ms, enforced within a route as well as between routes |

A route context closes on deadline, cancelling outstanding browser actions.
Shorter inner check deadlines reserve up to 250 ms for cleanup/reporting.
Probe pages close after failed/timed-out checks. Browser counters are released
even if browser shutdown rejects. Browser-launch failure produces an explicit
blocking infrastructure report rather than an unclassified generation failure.
This is bounded fail-closed behavior, not an unlimited wait for arbitrary pages.

## Release gate

Offline validation completed on 2026-10-29: **448 unique test cases passed
across focused runs and corrective reruns**. One explicitly opt-in published
Healthcare v1 check was skipped; this is not a live shared-catalog
verification. The final portfolio and typed-repair regressions were rerun after
the tab/diagnostic corrections. Earlier stale-worker results were superseded by
fresh-process runs of the affected tests.

| Coverage | Passed cases |
| --- | ---: |
| Diverse intent corpus, route/source contracts, core/behavioral QA, accordions, menus, dialogs, deadlines | 193 |
| Functional generation, real build/QA pipelines and bounded functional/compiler repair | 79 |
| Build-repair snapshot, anchor, revision and rollback safety | 28 |
| Exact-template workflow, Targeted Edit scope and ambiguity regressions | 71 |
| Authentication/owner isolation and billing | 77 |
| Total | 448 |

Backend/test typecheck, backend production build, scoped lint and
`git diff --check` passed. The retained original portfolio reproduces six
failures before the managed-scaffold correction and zero after it. The short
tab-description regression fails before the content-evidence correction and
passes afterward. No provider request or shared write was used for validation.

Offline acceptance requires the retained-source reproduction, positive and
negative pointer tests, diverse prompt corpus, route-aware and dynamic React
regressions, real production build/QA pipeline fixtures, repair limits,
rollback/current-source persistence and once-only mock billing tests, plus
typecheck, backend build, scoped lint and `git diff --check`.

Tests use deterministic mocked providers and isolated local repositories. Their
production builds and Chromium checks are real; external AI calls, paid jobs,
shared Mongo/GCS writes and catalog/template mutations are zero. Temporary
workspaces and browser profiles are directed to D: through
`scripts/run-functional-reliability-tests.mjs`.

Passing this gate establishes offline regression coverage, not unrestricted
production readiness or a promise that all arbitrary generated code will work.
Representative manually authorized live acceptance and concurrent production
capacity/timeout testing remain separate release gates. Existing finite call
and QA budgets intentionally reject unvalidated output rather than falsely
reporting success. No live acceptance is executed by this task.

## OrbitDesk navigation recognition corrections (2026-10-30)

Retained jobs `982cf29c-bff3-4b27-883d-7f9585be834f` and
`c8aa6527-5146-45ae-af81-cdf7a12e8174` exposed two QA recognition defects:
the exact menu-name pattern rejected the working `Menu ＋` controller, and
navigation readiness required an `h1` despite meaningful pages titled with `h2`.
Menu discovery now considers accessible naming and navigation relationships;
the existing real opening, destination-link and closing assertions remain.
The accordion probe shares that discovery so a decorated navigation toggle is
not mistaken for a question. Navigation requires the correct destination and
visible semantic headings plus meaningful content. Missing primary headings
are recorded by the existing advisory accessibility check.

Full replays also exposed excessive generic button-probe overhead. Eligibility
metadata reads are batched, skipped controls no longer cause redundant reloads,
and normal Playwright hover supplies its existing scroll/actionability checks.
Every tested independent button still starts from a reset page. The twelve
control positions, eight-second control deadline, complete QA deadline, error
severities and generation/repair budgets are unchanged.

`tests/fixtures/orbit-qa-failures.ts` contains exact retained editable source
with digest assertions. Original project prompts are no longer available; the
replay prompt is explicitly reconstructed from the retained route/requirement
evidence. This is offline source replay, not a new live generation or a recovered
original prompt. Real production builds and responsive Browser QA pass without
changing either original App source and without a mock repair request:

| Fixture | Build | Passed checks | Blocking failures | Advisory warnings | QA time |
| --- | --- | ---: | ---: | ---: | ---: |
| Original decorated menu | PASS | 181 | 0 | 0 | 95.226 s |
| Original h2 page titles | PASS | 172 | 0 | 9 | 105.513 s |

Both cover `/`, `/features`, `/pricing`, `/resources`, `/contact` at desktop,
tablet and mobile, with zero browser page errors. Each verifies unchanged saved
App source, accepted current-source persistence, once-only mock billing,
one mock coder response, zero repair calls and browser/environment/port cleanup.
There are 44 explicitly inapplicable skipped checks per fixture; skips are not
treated as behavior proof. The existing pipeline omits the broken-images check
when no asset manifest is supplied; this replay does not certify uploaded assets.

Private local reports are `.sites-runtime/orbit-qa-proof/orbit-menu.json` and
`orbit-heading.json`. Focused positive/negative browser regressions include
conditional and localized menu discovery, wrong panels, nonclosing menus,
unreachable/wrong routes, hidden/empty/heading-only pages and primary-heading
warnings. No provider calls, shared Mongo/GCS writes, credits, service restarts,
frontend changes or published template changes are used for these corrections.

Final verification: 120 behavior/route/accordion test cases passed; both real
build/QA source replays passed; 120 focused QA/runner/contract regressions passed.
The affected generic-control suite was then rerun with its two new independence
and broken-last-control cases (35 passed). These runs overlap and are not a
combined unique-test count. Backend/test typecheck, backend build, scoped lint
including the fixture, and `git diff --check` passed. The older two-pass complex
release gate was not rerun for this focused correction. Test-owned temporary
previews/browsers were closed; user-run backend/frontend services were untouched.
