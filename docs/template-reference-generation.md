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
includes the reference context. No new agent, provider call or repair allowance
is added. Template-only normal generation still allows at most two logical
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
