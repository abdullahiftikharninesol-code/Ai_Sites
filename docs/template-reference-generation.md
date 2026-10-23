# Reference-guided initial generation

Use Template is selection-only. Generate uses the existing `/api/dev/sites`
generation endpoint with the unchanged user brief plus:

```json
{
  "templateReference": { "templateKey": "ecommerce-store", "version": 1 },
  "generationRequestId": "client-generated-uuid"
}
```

Only the key/version are accepted as reference identity. The backend resolves
the exact active catalog record, reads its private artifact through the existing
storage adapter, verifies SHA-256, safely extracts and validates the source, and
checks its manifest identity. Archived references fail with a reselection message;
there is no silent version fallback.

The deterministic `TemplateDesignContext` contains at most 8,000 UTF-8 bytes of
design data: CSS tokens, typography, selected layout/responsive declarations,
component pattern names and advisory reference routes. It contains no ZIP,
complete JSX source, dependency manifests, source object paths, media URLs or
product copy. Fixed guidance adds a small amount of text beyond that bound.
The user's identity, copy, structure and functionality take priority. Generic
scaffold art direction is fallback rather than the selected design direction.

The context reaches Site Coder through its existing workspace-generation context
and token/preflight accounting. The existing planner receives it only when the
unchanged complexity/configuration rules already invoke planning; its cache key
includes the reference context. No new agent or repair allowance is added.
Template-only generation still allows at most two logical
requests (coding and existing build repair); complex generation keeps its existing
three-request ceiling. Existing uploaded-image behavior/budgets remain unchanged.

The neutral managed scaffold is used, not a finished template project. Before
materialization and after build repair, reference-specific checks reject unchanged
reference application hashes, missing explicit business identity, old reference
branding/product content and obviously inert controls. Shared completion/build
checks remain intact. Browser QA remains required and adds rendered identity,
requested storefront sections and supported mock product-interaction checks on
desktop/tablet/mobile. These supplement rather than relax shared QA. These checks
are bounded heuristics, not a proof of every arbitrary natural-language requirement
or pixel-perfect visual fidelity; those still require live acceptance.

Reference runs do not save a draft SiteProject until generation, build and Browser
QA pass. Existing current-source persistence and generation billing are reused.
Later edits still use Targeted Edit. No history, restore or duplicate source
snapshot model is introduced.

Retry identities are owner-scoped in the existing development service. Duplicate
submissions return the same running/completed job, failed runs reuse the same
server-owned candidate, and preview-delivery retries reuse a completed generation
without another inference or charge. Changing the brief after failure starts a
new explicit request. The recovery map is process-local (bounded to 500 reference
attempts); durable recovery across backend restarts is not implemented here.

Offline coverage includes the North & Loom storefront with real production build
and three-viewport Browser QA, size/quantity/cart behavior, old-brand rejection,
HTTP trust boundaries, planner cache isolation, frontend selection/recovery,
generation billing and fresh Mongo-repository current-source reload with in-memory
models. No shared Mongo/GCS writes or live model requests are needed for these tests.

Offline reliability safeguards apply compact real-navigation instructions and
conservative fragment-link checks to both scratch and reference generation.
Unresolved/dynamic components, IDs, hash routers and handled actions remain
Browser QA's responsibility; no fake targets are inserted and missing rendered
fragment destinations still block. Native details QA checks both toggle and
restored state without the filtered-parent selector false positive.

The local development server (never production composition) retains failed
generation Browser QA evidence under
`.sites-runtime/playground/diagnostics/failed-candidates/` (or the configured
development data root). This is outside served artifacts and never returned in
API errors. Up to five 2 MiB JSON diagnostics are retained; files older than
24 hours are removed at startup or the next capture. Cleanup only unlinks
strictly named diagnostic files, never project directories. Successful runs
produce no diagnostic source copies. There are no Mongo/GCS archives, committed
versions, history/restore features, or diagnostic-triggered inference requests.

Diagnostics contain bounded whitelisted source, completion summary and QA
checks. Existing artifact security scanning and secret redaction are applied;
known environment secrets, JWTs, bearer tokens and private keys are scrubbed,
and unsafe/oversized files are omitted. Redacted/partial source is explicitly
marked and may not be rebuildable. Failed workspaces and previews are still
cleaned up normally; diagnostic I/O failure never replaces the original QA error.

The same bounded evidence store now captures parsed Site Coder bundles rejected
by static validation, before materialization/cleanup. Static diagnostics identify
the source/check and mark their source as `submitted-candidate`, not the starter
workspace. Unparsed responses cannot safely supply a source bundle; omitted or
redacted evidence is reported without logging content. Retention and private
local-only storage limits are unchanged.

Development generation telemetry no longer needs a preload: the standard dev
composition emits a strict metadata whitelist for the job, selected template,
context presence/bytes/SHA-256 digest, existing role/model, failure stage and
private diagnostic path. The coder checks context presence in its actual
outgoing message. No prompts, raw responses, source, authentication information
or diagnostic paths are added to public job responses. Production composition
disables this development telemetry. Compact guidance now contrasts semantic
stateful actions (including a Cart drawer) with real route/section navigation;
it does not guarantee live model compliance.

Provably missing fragment destinations (including an unimplemented Size guide)
now use the existing `sites.build-repair` stage before materialization. It returns
small exact patches against the submitted bundle, which is repaired in memory
and revalidated before any generated source is written. The repair must supply
meaningful visible content or a real semantic action, not fake IDs, unrelated
destinations or disabled controls. Normal valid generation still uses one coder
call. Navigation repair consumes the same `maxBuildRepairs` allowance as compiler
repair; by default a coder plus navigation repair cannot trigger a third repair
call if the subsequent build fails. Run-wide logical/physical/token limits and
provider retry policy are unchanged. Unresolved repairs fail closed, retain the
bounded development evidence and do not commit a project or successful charge.

The shared functional interaction architecture, verified managed runtime,
deterministic recovery boundary and offline fixtures are documented in
[functional-generation-reliability.md](functional-generation-reliability.md).
