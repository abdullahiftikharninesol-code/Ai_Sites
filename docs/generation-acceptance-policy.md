# Initial generation acceptance: usable website

This policy applies to initial generation, including the backend's existing
design-reference generation path. It does not change the exact-template
instantiation workflow, template publication gates, or Targeted Edit requirements.
Reference-specific feature/branding completeness is also advisory. Returning
the exact unchanged reference application remains blocking.

## Blocking gates

- Valid structured source, safe editable paths, imports, dependency and asset
  policies, and existing source/deployment security checks.
- Successful production build and ready preview.
- Visible page content, successful route loading, and no uncaught browser errors.
- Working displayed primary navigation. A linked missing page remains a defect;
  a requested page that was never implemented or linked is an advisory.
- Required resource loading, blocked unauthorized network activity, unexpected
  popups/downloads, and inability to complete the critical QA run.

## Advisory findings

Missing requested pages, sections, or capabilities do not reject an otherwise
usable result. Source analysis retains missing/uncertain requirement findings.
An omitted uploaded image is also a content-coverage advisory; unsafe asset
references and invalid asset data keep their separate blocking checks.
Empty or inert non-primary controls and non-primary missing fragments are
recorded without spending an AI repair request. Unsafe links still block.

Browser control, responsive, form-label, console, and accessibility findings are
advisory for generation. Original check status, message, evidence and failure kind
are preserved in the QA report; severity determines acceptance. An uncaught
JavaScript error raised by a minor control is still blocking. Network and safety
event checks run after interactions so those events cannot be missed.

The initial-generation path uses generic existing-control probes, rather than
requiring every requested capability to pass its own behavioral checklist. The
strict capability validators remain available and unchanged for their existing
other uses and regression tests. This policy does not certify 100% prompt
completion or exhaustive functionality.

## Output and accounting

Normal accepted results open through the existing editor/current-project path.
No new draft/Needs changes state, historical source storage, or frontend warning
flow is introduced. The original prompt remains available in existing project
metadata. Advisory findings are stored in the existing private QA artifacts.

Normal successful-job billing and atomic current-source persistence are unchanged:
an accepted usable result is a success under this policy and uses the normal
successful-generation charge. A blocking QA/build failure does not commit an
accepted current source or receive a successful-job charge. No extra template
fee, inference role, provider retry, or repair allowance is introduced.

## Bounded coverage

Desktop/tablet/mobile, the existing 120-second complete QA budget, existing
per-route/check deadlines and generation/repair call limits remain unchanged.
Browser QA checks implemented routes, not unimplemented routes inferred from the
prompt. Generic controls remain limited to twelve button positions; primary
navigation follows up to twelve unique displayed local destinations from `/`.
This is bounded automation, not an exhaustive crawl or full accessibility audit.

The generator's system instructions prioritize coherent buildable pages, real
primary navigation, working reusable controls and honest local/demo behavior.
Prompts remain guidance; deterministic build, security and browser checks remain
the acceptance authority.

## Offline verification

`tests/usable-generation-policy.test.ts` exercises advisory classification,
strict-validator isolation, actual builds and desktop/tablet/mobile QA, unchanged
saved source, once-only mock successful billing, and no commit/charge on build,
blank-page, unsafe-link, broken-navigation and interaction-crash failures.
Providers and billing are mocked; repositories/artifacts are isolated locally on
D:. No external AI requests, shared Mongo/GCS writes or service restarts are used.

Earlier reports in `production-functional-reliability.md` describe the previous
strict initial-generation acceptance policy. This document supersedes those
requirement-completeness gates for initial generation.

Validation on 2026-10-30: 30 new policy cases passed (29 in the final complete
policy run plus the subsequently added real-upload coverage/integrity case),
101 strict source/Targeted Edit/QA-runner regressions passed, six selected
multi-page/compiler/pointer pipeline cases passed across focused and corrective
runs, and the reference-context fixture passed with one mock coder response and
no repair. Source typecheck, backend build, scoped lint and `git diff --check`
passed. Early stale assertions were updated for the new policy. An initial
combined run exhausted local Windows memory; serial/isolated reruns passed
without weakening infrastructure failure handling or increasing budgets.

The full repository suite and the two-pass complex release gate were not rerun.
No live generation was submitted. Test-owned preview/browser processes were
closed and user-run services were not restarted.
