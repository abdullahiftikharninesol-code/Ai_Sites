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
