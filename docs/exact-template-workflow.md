# Exact published-template workflow

## Product flow

`Templates -> Preview -> Use Template -> existing editor -> Targeted Edit`

The gallery calls the existing authenticated `POST /api/site-templates/:key/instantiate`
without a version. The server resolves the latest active catalog record, verifies
the published ZIP's SHA-256, safely extracts it, and runs the existing source,
build and Browser QA gates before committing the owner-scoped current project.
No source normalization, regeneration, AI request or credit charge is introduced
by initial template loading. The preview renders the React application, not the
gallery screenshot. Archived versions are not silently selected.

The UI disables duplicate submissions. After a successful instantiation, an
editor-opening failure retains that project's response in memory: selecting the
same template reopens it rather than creating another project. An unrelated
project-list refresh cannot turn a successful editor opening into an error.
There is no fallback from failed template loading to AI generation.

### Use Template failure visibility

The click handler calls `instantiateTemplate`, then loads the returned project
and validated current preview before editor navigation. Merely setting a gallery
selection is not successful instantiation. A failed request previously left its
selection badge displayed, with the actual error below the entire card grid.
The feature now treats selection as transient loading state only, clears it on
failure, and focuses a failure notice above the cards. Backend error code and
HTTP status are retained instead of being discarded by the API client.
GetChatly's top-level `{ message, status }` authentication envelope also retains
its original message; it is not mistaken for a template QA failure. Explicit
template retry uses the template path, never the scratch-generation error action;
an already-created project is reused after editor-opening failure.

Read-only verification on 2026-10-23 captured current Healthcare Clinic v1 and
Ecommerce Store v1 in `.sites-runtime/use-template-active/verified-pTxUOi/`.
Both GCS ZIPs exist and match their current catalog SHA-256. Healthcare has no
published v2 record. Instantiation of that actual v1 ZIP fails `BROWSER_QA` with
`TEMPLATE_INSTANTIATION_QA_FAILED` (HTTP 400 in the unchanged HTTP mapping):
six error-severity internal-links checks across `/services`, `/team` and all
three viewports, caused by missing `#service`, `#bio`, `#careers` destinations.
The focused regression verifies rejection before any project save and no AI or
billing finalization. The QA report is retained under `proof/` in that directory.
This is `PUBLICATION_REQUIRED`; it is not permission to activate local v2.
The original user's browser response was not available for retrospective capture;
this evidence is a fresh catalog read and isolated artifact reproduction.

Ecommerce v1 independently passed exact source/build/real React preview checks,
all routes on three viewports, original published-preview comparison and mock
edit/reload/rollback. UI regressions verify editor navigation, duplicate clicks,
Back, same-project refresh, visible QA/auth failures and retained Targeted Edit.

Customization uses the existing edit endpoint with the current project/revision.
It retains patch/context selection, validation, bounded requirement repair,
successful-edit accounting, current-only replacement and failure rollback. It
does not clone the published ZIP again. No Version History or Restore UI is added.
Start from Scratch remains on the existing normal generation pipeline, including
its functional-generation improvements. Shared reference-generation code remains
available to other consumers; the gallery no longer exposes that competing path.

## Offline verification

`tests/exact-template-workflow.test.ts` uses real local execution/build/preview
and the existing Browser QA runner, an isolated current-only repository, and a
deterministic mock edit provider. It never connects to shared Mongo or GCS.
`SITES_EXACT_TEMPLATE_FIXTURE_ROOT` selects previously downloaded ZIP/catalog
fixtures; without it, the test packages local template directories instead.

An authorized read-only catalog/GCS check captured all eight published ZIPs and
verified every SHA. Corporate Business and Restaurant resolve to v2; the other
six resolve to v1. Their archived v1 records are rejected explicitly.

Ecommerce Store v1 passed exact package-file comparison, original React build,
all five routes across desktop/tablet/mobile QA, and original product quantity,
bag count, disclosure and category-filter interactions. Deterministic WebP
comparison with the three actual published previews produced zero pixel delta
on all three viewports. These checks cover the original template's behavior,
not newly promised ecommerce functionality or every decorative control.

The mock customization renamed it to North & Loom and changed hero copy/colors.
Its build, all-route responsive QA, interactions, current-source reload and one
successful billing finalization passed. A deliberately invalid subsequent patch
preserved the working current source and preview, with no second finalization.
The immutable original ZIP hash remained unchanged. No real credits were used.
The separate mocked scratch-generation regression also passed.

Frontend feature tests cover direct/preview entry, no initial AI/quota update,
unversioned active resolution, duplicate blocking, workspace readiness, safe
reopening, loading errors, normal editing, failed edits and scratch separation.
Existing backend suites cover authenticated instantiation, current-only Mongo
adapter semantics, requirement-repair limits and billing/rollback behavior.

## Published v1 defects identified before finalization

These failures were reproduced from unchanged, SHA-verified published v1 ZIPs using
the real instantiation QA. They are not reasons to weaken QA or silently rewrite
the loaded source.

| Active artifact | Blocking evidence | Minimal separate source correction |
| --- | --- | --- |
| Creative Agency v1 | `src/components/SiteShell.jsx:132` returns `window.scrollTo(...)` from a React effect. Chromium returns a Promise; React cleanup raises `destroy is not a function`. Runtime-page-error fails on five routes at all three viewports. | Use a block-bodied effect that does not return the scroll result. |
| Real Estate v1 | `src/App.jsx:18` has `href="#read"` and a handler that only prevents default. The destination is absent; internal-links fails on `/` at all three viewports. | Supply meaningful story destinations/actions. |
| Healthcare Clinic v1 | `src/App.jsx:23,25` has absent `#service`, `#bio`, `#careers` destinations and handlers that only prevent default. Internal-links fails on `/services` and `/team` at all three viewports. | Supply meaningful service/bio/careers destinations/actions. |

That is 24 blocking check results across three artifacts. Modern SaaS v1,
Personal Portfolio v1, Corporate Business v2, Ecommerce Store v1 and Restaurant
v2 reached successful instantiation under the existing advisory-warning policy.
`PASS_WITH_WARNINGS` is accepted by that policy; error-severity failures are not.

The subsequent finalization task authorized the three local source corrections.
Creative Agency now uses a block-bodied effect. Real Estate opens actual story
content in accessible native dialogs. Healthcare opens service information,
role-specific fictional clinician profiles and an honest careers information
state (no live vacancies or applications). Close buttons use native `close()`;
Escape and focus restoration are regression-tested. Existing routes and baseline
layout are retained. Only these three local manifests are advanced to v2/draft.
Published artifacts/catalog entries remain unchanged pending explicit publication
approval. Existing v1 objects must not be overwritten.

## Other validation boundary

Backend build/typecheck and frontend typecheck pass. Scoped lint reports zero
errors (four existing frontend hook-dependency warnings). The full GetChatly
frontend production build now passes without core source/configuration changes.
The prior `/api/ffmpeg-core/[file]` error came from incomplete shared `.next`
artifacts: a concurrent dev server's manifest contained only the catch-all page.
Stopping that dev server and moving `.next` to a recoverable backup before a clean
build resolved it. The compiled route served both real assets with HEAD 200,
rejected an unsupported filename with 404, and served a 16-byte WASM range with
206. A newly started dev process subsequently rewrote the manifest to `{}`,
confirming why dev and production builds must not share `.next` concurrently.
No source/configuration workaround or route removal is needed. The original
generated directory is retained as `.next-exact-template-backup-20261023-145229`
in the frontend repository. No source was deleted.

## Final offline acceptance and pending publication

Final candidate bundle:
`.sites-runtime/exact-template-finalization/prepared-DS1yMS/`

Eight exact-template instances passed production build, source/ZIP integrity,
all declared routes on desktop/tablet/mobile, zero blocking findings and zero
runtime-page-error findings. Advisory warnings remain under unchanged QA policy.
The five working templates use the original published ZIPs byte-for-byte.
Creative Agency v2, Real Estate v2 and Healthcare Clinic v2 use the repaired
candidate ZIPs. Their additional actual-control regressions also pass.

The initial complete run caught the dialog focus issue; after correction only
the two affected candidates were rerun. The other six accepted ZIP hashes match
the final bundle. Evidence is consolidated under `proof/`. Ecommerce's original
three published previews still matched exactly; its mock North & Loom edit,
functional interactions, current-source reload and failed-edit rollback passed.
101 frontend Sites tests and 36 focused backend instantiation/billing/bounded
requirement-repair checks passed. Test-owned execution environments were cleaned.

`scripts/prepare-exact-template-finalization.mjs` uses the existing publisher in
dry-run mode, with every shared storage/repository/cache port throwing on access.
It retains full source ZIPs, nine WebP previews, publication QA reports, integrity
metadata and `publication-plan.json` locally. Each repaired publication passed
five routes on three viewports. Homepage comparisons with actual original GCS
previews were unchanged for Real Estate/Healthcare and within the existing
deterministic tolerance for Creative Agency (maximum mean RGB delta < 0.2/255).
Only the approved source files differ from v1; no assets/files were removed.

The read-only catalog/object check confirmed eight logical active templates and
all twelve proposed v2 paths absent. Shared active versions are still Modern
SaaS 1, Creative Agency 1, Personal Portfolio 1, Corporate Business 2, Ecommerce
Store 1, Restaurant 2, Real Estate 1 and Healthcare Clinic 1.

Publication remains NOT STARTED and approval is PENDING. The proposed write scope
is exactly `creative-agency`, `real-estate`, `healthcare-clinic` v2: each receives
`sites/templates/<key>/v2/source/template.zip` and
`sites/templates/<key>/v2/previews/{desktop,tablet,mobile}.webp` (12 create-only
objects total). The precise byte hashes are pinned in `publication-plan.json`.
After explicit approval, recheck version/object conflicts, publish only those
pinned artifacts using existing safe tooling, verify every object/hash, create
inactive candidate metadata and activate only complete verified versions while
archiving their previous v1 metadata. Preserve v1 objects and all five other
templates; invalidate only the relevant catalog cache namespace and verify one
active version per key/eight logical cards. Stop/report partial failures without
activating incomplete candidates or retrying unsafe writes.

All task verification used zero live AI calls, zero real credits, zero shared
Mongo writes, zero GCS writes and zero catalog mutations. Offline acceptance is
8/8; shared active-template acceptance remains 5/8 until the three repaired
immutable versions are approved, published, verified and activated. Status:
`READY_FOR_TEMPLATE_PUBLICATION_APPROVAL`, not production acceptance.
