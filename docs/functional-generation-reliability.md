# Functional generation reliability

## Investigated failure

The retained development diagnostic `candidate-3df2c7ec538b85faba2e100fc26f6774.json`
contains `src/App.tsx:34`:

```tsx
<button type="button" aria-label="Search" onClick={() => window.alert("Search is available in this demo store.")}>Search</button>
```

This is an alert-only placeholder (classification B), not a working search or a
static-validator false positive. `Header` receives only `cartCount`; it has no
search state, query input, results, or search handler. The app chooses Home or
ProductDetail using `window.location.pathname === "/product"`. It has product
size/quantity state and an aggregate cart counter, but its Bag link incorrectly
goes to `/product`, not a cart view. These are source observations, not claims
about the model's internal reasoning.

The diagnostic's internal pipeline job is `02bc6943-2b80-4776-8dda-c848cd12cac2`.
Its error matches the user-supplied failed request exactly. The outer development
request ID `beb4d9f3-f90e-4a01-bf66-009eb33bea8f` is not recorded in this diagnostic;
an independent outer-to-inner mapping is therefore not asserted.

## Proven architectural gaps

- The structured coding contract ensured files/compilation, not a deterministic
  per-request functional API contract. The coder had to recreate state wiring.
- Design context and static checks alone did not supply executable behavior.
- The managed Button dropped native event/ARIA props, and ContactSection used an
  unhandled native form. Both now use real event propagation/demo form behavior.
- Scratch deterministic planning missed an explicitly requested product-detail
  route; it now declares `/product` in the same engine.
- Explicit frontend-mock contact requests previously acquired persistent
  submission collections. Mock-only forms now remain frontend-only; normal
  runtime form planning is unchanged.

## Implementation and guarantees

`analyzeRequestProfile` now extracts a fixed, deterministic functional contract
without changing complexity/planner routing. Only relevant APIs are advertised
in Site Coder's existing capability context. The provider sees small signatures
and requirements, not the managed runtime source. Nothing adds a model request,
agent role, inference budget, provider retry, or billing formula.

`src/sites-ui/functional.tsx` is managed application support supplied through the
existing UI scaffold/import boundary. It contains React-only controllers and
layout-neutral components for:

- product/size-keyed cart items, quantity totals, a real cart panel, removal and
  same-tab mock cart continuity via guarded, project-scoped sessionStorage;
- quantities, size selection, active gallery images and category/search filters;
- mobile menus, tabs, native accordions and native dialogs;
- validated contact/newsletter forms with explicit demo-only visible feedback.

Generated code supplies the brand, products, content, pages and CSS. The helper
does not clone or instantiate the selected template. Custom working React
implementations remain supported. No helper sends network requests, simulates
payment/account/booking success, or claims remote form persistence. Explicit
unsupported real transactions fail instead of being silently downgraded to demo
success; supported existing runtime/auth contracts remain the backend boundary.
Known demo-only form components are also rejected when the corresponding
requested form requires a real backend, even if a backend is configured.

Deterministic recovery runs before materialization/static validation. Its sole
current correction requires all of: explicit `data-sites-action="cart.open"`,
an exact managed `useCart` import, a local const controller, a corresponding
rendered managed CartPanel in that component, no shadowed hook/panel bindings,
and an empty/alert-only/missing action. It wires `cart.openCart()` and is
idempotent. It never guesses from a label or changes an ambiguous Search/Add to
Cart handler. All remaining invalid candidates are rejected precisely.

The existing bounded navigation/compiler repair allowance is unchanged. Safe
functional recovery itself is deterministic and consumes **zero** model calls.

### Live inert-control follow-up

The next retained North & Loom candidate failed `interaction.controls`: nine
button definitions (story, size guide, collection, checkout, support and social
controls) lacked actions. This was a generator defect, not a frontend crash or a
validator false positive. The missing-fragment recovery boundary previously
ignored these findings and rejected catalog-reference candidates immediately.

Static navigation and control failures now share the **same existing** Build
Repair allowance with compiler failures. The repair receives all bounded
findings (not just the five-item public summary), relevant uncommitted source,
and the requested managed functional API contract. Exact patches are applied in
memory and all static/completion checks run again before materialization. A
remaining defect fails; a subsequent compiler failure cannot acquire another
repair slot. Disabled repair remains disabled, and success still requires the
normal build, responsive Browser QA, persistence and billing gates. This adds
no role, budget or live request during implementation; a future failing job may
spend its previously reserved repair request on controls instead of compilation.

The regression fixture reproduces the nine control definitions without copying
private source. Reference and scratch fixtures verify meaningful actions after
the bounded repair; unresolved, partial, alert-only, no-effect, managed-file and
compiler-breaking repairs remain rejected without a third provider call or a
successful project/billing outcome. This does not promise arbitrary live-model
repair compliance, and no previous failed job is automatically resubmitted.

### Browser-QA follow-up (23 October 2026)

Request `161fd11c-76e7-4d25-96c9-bb45fcc9fcf7`, pipeline job
`981ab104-0d94-4959-800f-f110bce9b83e`, reached build success and then failed
Browser QA. Its retained candidate proved several distinct problems:

- Independent probes shared an open custom cart drawer. Its backdrop intercepted
  unrelated later clicks. Each interaction/form check now gets a fresh observed
  page; each generic button probe resets to the same route. Actual Close controls
  are exercised and must work; no force clicks, hidden overlays or severity
  downgrades are used. Failed/timed-out probes cannot continue clicking the next
  check's page, and accumulated page errors remain visible to runtime checks.
- Working button-based category filters and named text search inputs were
  rejected by dropdown/searchbox-only selectors. QA now accepts those forms but
  still requires actual product/result changes, not merely active styling.
- Size selection checks disagreed about plain S/M/L buttons. They now share the
  same accessible, state-changing selector. Deterministic semantic recovery adds
  aria-pressed only where an unshadowed React state comparison and its setter
  prove the selected state; it similarly connects a proven mobile nav toggle and
  marks a proven clamped quantity decrement disabled at its actual lower bound.
  Type-only callback parameters do not count as runtime shadowing. No handler or
  product data is invented. Hidden desktop mobile toggles are not clicked.
- Nested grid intrinsic widths clipped tablet controls. A low-specificity
  min-width guard lets nested content shrink without changing the intended grid
  column layout or hiding a failed interaction.
- `gallery placeholders` now produces gallery capability guidance and an active
  image probe. The retained candidate's thumbnail selection did not change its
  main image: that is a genuine source defect, not an excuse to weaken QA.
  A narrowly gated deterministic correction handles an explicitly requested
  placeholder gallery only when a proven numeric index state controls a literal
  `[0,1,...]` thumbnail selector and every view repeats the same image. It uses
  distinct SVG views visibly and accessibly labelled as placeholders, preserving
  the existing gallery layout and handlers. Real-photo requests, negated
  placeholders, unknown index/data, distinct photos and ambiguous bindings are
  left untouched. This adds no inference request and does not fabricate photos.
- A read-only reproduction traced the Node 24 listener warning to teeny-request's
  SDK stream pipeline. Template ZIP reads now use the same ADC client's buffered
  binary transport and verify CRC32C; catalog SHA verification remains unchanged.
  The same existing object returned identical bytes/SHA with zero listener
  warnings after this fix. No listener limit was raised or warning suppressed.

Regression coverage includes custom auto-opening cart dialogs, button filters,
text search, responsive size/navigation controls, dead Close controls, decorative
filters, unchanged images, retained interaction errors, typed/shadowed React
bindings, binary corruption, and storage authentication/not-found behavior.

## Validation and evidence

Both reference and scratch candidates receive strict static control checks.
Browser QA probes requested observable behavior and a bounded sample of visible
buttons, including cart count deltas, meaningful cart contents, selected options,
filters, galleries, tabs, menus, dialogs and honest mock form feedback. Mock-form
probes block navigation/fetch/XHR so QA cannot submit real data. Native button
event/ARIA state, computed theme changes and custom cart count status elements
are observed rather than relying only on handler syntax.

Controlled-menu selectors accept React `useId()` values (including colons).
Browser event snapshots are refreshed between checks, and runtime checks run
after interaction probes so interaction-triggered errors cannot escape the gate.

Private failed-candidate evidence now includes functional requirements and
reference presence/byte-count/digest metadata for static/build/QA failures.
Build diagnostics retain the first source/line/compiler finding. The original
5 files / 2 MiB each / 24-hour, development-only, sanitized local retention bounds
are unchanged. No history/restore, shared Mongo archive, or GCS source archive is
introduced. No raw prompts, credentials or source are logged publicly.

## Offline verification and limits

The later `Dismiss suggestion` failure exposed two separate issues: generated
state hid only the icon, and the generic QA snapshot did not observe icon-only
visibility changes. QA now observes rendered control presence without accepting
arbitrary class/data mutations. For identifiable dismissible notices it also
requires the associated content to actually disappear (including CSS visibility,
not just a `hidden` attribute). Both scratch and reference coding context explain
whole-region dismissal. A conservative AST correction moves an exclusive,
unshadowed boolean from a self-hiding dismiss button to its explicitly named
notice, preserving its original handler. Ambiguous/shared state, extra controls,
unknown regions and CSS/JS spreads are left untouched and must still pass QA.
No provider request, repair slot or QA severity is added or changed.
The same replay also exposed an initially masked task-completion probe: visible
strikethrough changed while the text stayed identical. QA observes completion
decoration and accessible checked state, after settling hover/focus so rollover
styling cannot satisfy the action gate. No-op and decorative-only handlers remain
blocking failures.
The corrected retained candidate was rebuilt offline and checked across its five
original routes on desktop/tablet/mobile: 195 passed, zero failed, zero warnings,
30 not-applicable skips. The final focused control suite passed 33 tests; scoped
recovery/repair-limit regressions passed 21 tests. This was not a new generation
or a committed/persisted user project, and does not establish arbitrary live-model
success.

Real local builds and desktop/tablet/mobile Browser QA use representative generated
Ecommerce (reference and scratch), corporate and portfolio fixtures. Browser tests
check product navigation, size/quantity/image changes, item-specific cart contents,
cart continuity after reload, category filtering, mobile menus, tabs, accordions,
dialogs, native form validity and honest demo feedback. Adversarial fixtures cover
the retained Search alert, empty/dead controls, missing state, no-effect handlers,
false newsletter success and interaction-triggered exceptions. Tests use mock
providers, local previews and in-memory persistence/billing, not shared services.

This guarantees tested helper behavior, a deterministic relevant contract,
conservative recovery and rejection of detected defects. It does **not** prove
arbitrary generated code, every natural-language requirement, or live-model
compliance. Extraction is conservative, page-scoped semantic probes are bounded,
and dynamic/custom behavior may still fail build/QA. The actual visual fidelity
and live output still require one separately authorized acceptance run. No live
generation is part of this task.
