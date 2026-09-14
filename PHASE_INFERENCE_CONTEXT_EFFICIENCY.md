# Sites Inference Stability — Phase 3: Context, Token & Output Efficiency

## 1. BEFORE Baseline

The baseline was measured using the Phase 2 codebase prior to Phase 3 optimizations on a standard dental clinic website request (4 pages, 4 sections, content, and design).
Tokens are estimated with the standard estimator (`Math.ceil(chars / 3.7)`):

### Baseline Request Payloads by Stage (BEFORE)

| Stage | System Prompt | Tool Schemas | SiteSpec / Payload | Workspace Context | History / Output | Total Estimated Input | Configured Max Output |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **SITE_PLANNING** | 166 chars (~45 tok) | 0 chars (0 tok) | 76 chars (~21 tok) | 0 chars (0 tok) | 0 chars (0 tok) | **~66 tokens** | 4,000 |
| **GENERATE_SITE Turn 1** | 2,841 chars (~768 tok) | 3,796 chars (~1,026 tok) | 1,153 chars (~312 tok) | 2,281 chars (~617 tok) | 0 chars (0 tok) | **~2,910 tokens** | 16,384 |
| **GENERATE_SITE Turn 2** | 2,841 chars (~768 tok) | 3,796 chars (~1,026 tok) | 1,153 chars (~312 tok) | 2,281 chars (~617 tok) | +12,000 chars code (~3,243 tok) | **~6,200+ tokens** | 16,384 |
| **BUILD_REPAIR** | 2,841 chars (~768 tok) | 3,796 chars (~1,026 tok) | 0 chars (0 tok) | 174 chars (~48 tok) | 202 chars (~55 tok) | **~1,950 tokens** | 16,384 |

### Sites-Controlled Fixed Overhead vs Legitimate Content (BEFORE)

For **GENERATE_SITE Turn 1**:
* **Sites-Controlled Fixed Overhead (BEFORE):**
  * System Prompt: 2,841 chars (~768 tokens)
  * Full 8 Tool Schemas: 3,796 chars (~1,026 tokens)
  * Scaffold Files Dump (`package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/vite-env.d.ts`): 2,281 chars (~617 tokens)
  * Duplicated requirement text: ~450 chars (~122 tokens)
  * **Total Fixed Overhead (BEFORE):** 9,368 chars (**~2,533 tokens**) — representing **~87%** of the initial request.
* **Legitimate User/Content-Dependent Context:**
  * User prompt: 76 chars (~21 tokens)
  * SiteSpec content & design: ~1,153 chars (~312 tokens)
  * Total Content: 1,229 chars (**~333 tokens**).

For **GENERATE_SITE Turn 2 (Continuation):**
* Full 10KB+ code payload from Turn 1 assistant tool call was re-sent in message history: +12,000 chars (~3,243 tokens), blowing up context to **~6,200+ tokens**.

For **BUILD_REPAIR:**
* Tool schemas included irrelevant tools (`run_build`, `start_preview`, `read_logs`, `finalize_generation`): ~1,026 tokens.
* System prompt used full 2,841-char coding agent prompt instead of focused repair instructions.
* Configured output allowance asked for 16,384 tokens for a single-file compiler fix.

---

## 2. New InferenceContextPolicy

A deterministic abstraction encapsulates the stage-specific policies for inference requests across the pipeline:

```ts
export interface InferenceContextPolicy {
  readonly stage: InferenceStage;
  readonly tools: readonly AgentToolDefinition[];
  readonly contextStrategy: ContextStrategy;
  readonly outputPolicy: OutputPolicy;
  readonly reasoningPolicy: ReasoningPolicy;
  readonly observationPolicy: ObservationPolicy;
}
```

Centralized in `src/agents/budget/inference-context-policy.ts`:
* Stages handled: `SITE_PLANNING`, `GENERATE_SITE`, `BUILD_REPAIR`, `EDIT_PLANNING`, `TARGETED_EDIT`.
* Eliminates conditional logic scattered throughout runtime, gateway, and loop.

---

## 3. Stage-Specific Tool Sets

Tool definitions are trimmed strictly to the tools relevant to each stage via `getStageAgentTools(stage)`:

* **SITE_PLANNING**: 0 tools. Planning is purely structured conversational synthesis.
* **GENERATE_SITE**: Exactly 4 minimal tools:
  1. `write_file`
  2. `read_file`
  3. `apply_patch`
  4. `finalize_generation`
  *(Omitted: `list_files`, `run_build`, `start_preview`, `read_logs` as build and preview are orchestrator-owned).*
* **BUILD_REPAIR**: Exactly 4 repair tools:
  1. `read_file`
  2. `write_file`
  3. `apply_patch`
  4. `search_files`
* **TARGETED_EDIT**: Exactly 4 edit tools (`read_file`, `write_file`, `apply_patch`, `search_files`).

**Impact:** Tool schema tokens reduced from ~1,026 tokens (8 tools) to ~524 tokens (4 tools) for `GENERATE_SITE` — a **48.9%** savings.

---

## 4. Compact SiteSpec Projection

Implemented `toGenerationSiteSpec(siteSpec, completionRequirements)` in `src/sites/domain/site-spec-projection.ts`:
* Projects canonical pages, sections, content copy, design theme/tokens, and required Phase 2 marker attributes (`data-sites-page="<id>"`, `data-sites-section="<id>"`).
* Safely excludes orchestration-only metadata:
  * `runtime`: Dev/preview server commands, ports, Node target (internal to execution provider).
  * `technical.profileId`, `technical.bundler`, `technical.packageManager`: Internal tooling choices not referenced in generated JSX/CSS.
* Retains all necessary architectural choices: `technical.framework`, `technical.language`, `technical.styling`.

**Impact:** SiteSpec payload reduced from ~312 tokens to ~195 tokens (**37.5% reduction**) without any semantic loss.

---

## 5. Runtime Contract

Replaced full dumps of fixed scaffold files (`package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/vite-env.d.ts`) with a compact deterministic contract:

```text
Runtime Contract:
Framework: React + TypeScript + Vite
Styling: CSS
Managed by Sites (deterministic scaffold, do not edit or recreate):
- package.json
- tsconfig.json
- vite.config.ts
- index.html
- src/main.tsx
- src/vite-env.d.ts

Editable Project Files:
- src/App.tsx
- src/styles.css

Rules:
- Do not import external packages not present in React standard build.
- Implement full UI inside src/App.tsx and style in src/styles.css.
```

**Impact:** Workspace context reduced from 2,281 chars (~617 tokens) to ~380 chars (~103 tokens) — an **83.3% savings**.

---

## 6. Conversation Compaction

Implemented `compactConversationHistory(messages)` in `src/agents/agent-loop.ts`:
* **Older resolved turns:** Historic tool-call arguments containing massive source code are transformed into compact receipts without breaking neutral tool-call/result pairing or orphan IDs:
  ```text
  PERSISTED TOOL ACTION
  tool: write_file
  path: src/App.tsx
  bytes: 8421
  sha256: 3a9f...
  status: success
  full historical content omitted; current file remains available through read_file
  ```
* **Latest unresolved turn:** Kept uncompacted with full completion issues and diagnostic context so the model knows precisely what to correct.

**Impact:** Multi-turn context growth drops by over **70%** on Turn 2+ continuations.

---

## 7. Observation Compaction

Tool observations in `SitesToolExecutor` now return concise action receipts:
* `write_file`: Returns `WROTE <path>\nbytes: <bytes>\nsha256: <hash>` (no source echo).
* `apply_patch`: Returns `PATCHED <path>\nreplacements: <n>`.
* `search_files`: Results bounded to top 20 matches and byte-bounded preview snippets.
* `run_build`: Stripped of success chatter; compact diagnostic receipt on failure.
* `finalize_generation`: Rejected outcome emits only unresolved issues.

---

## 8. Build-Log Normalization

Implemented `normalizeBuildLog(stderr, stdout, options)` in `src/cli/runtime/build-log-normalizer.ts`:
1. Strips all ANSI escape sequences (`\u001b[...]`).
2. Deduplicates repeated boilerplate (npm error dumps, generic Vite banners).
3. Preserves actionable TypeScript/compiler diagnostics: file path, line, column, error code (e.g. `TS2322`), message, and source context.
4. Uses `safeRedactSecrets` to protect leaked API keys and bearer tokens without mangling legitimate paths like `src/auth-token.ts`.

---

## 9. Output Policy

Replaced the universal 16,384 ceiling with a complexity-aware output policy:

```text
allowance = baseAllowance (4,096)
  + pageAllowance (pageCount * 800)
  + sectionAllowance (sectionCount * 250)
  + contentAllowance (contentTokens * 0.5)
  + featuresAllowance (featureCount * 300)
  + finalizeEnvelopeSafetyMargin (1,000)
clamped to [minGenerationOutputTokens (4,096), maxGenerationOutputTokens (16,384)]
```

* **Simple site (1 page, 1 section):** ~6,446 tokens.
* **Standard dental site (4 pages, 4 sections):** ~9,446 tokens.
* **Complex campus site (6 pages, 22 sections):** Clamped to safe 16,384 tokens.
* **SITE_PLANNING:** Scaled to 2,048 tokens.
* **BUILD_REPAIR:** Scaled to 4,096 tokens.
* **TARGETED_EDIT:** Scaled to 6,144 tokens.

---

## 10. Reasoning Policy

Provider-neutral intent abstraction:

```ts
export type ReasoningPolicy = "NONE" | "LOW" | "MEDIUM" | "AUTO";
```

* Stage defaults:
  * `SITE_PLANNING`: `LOW`
  * `GENERATE_SITE`: `AUTO`
  * `BUILD_REPAIR`: `LOW`
  * `EDIT_PLANNING`: `LOW`
  * `TARGETED_EDIT`: `LOW`
* Provider adapters translate to specific options (e.g. Gemini thinking budget, OpenAI reasoning effort), while providers without reasoning support safely ignore it. No provider-specific budget fields pollute core types.

---

## 11. Token Estimation

Implemented standard and conservative estimators in `src/agents/budget/token-estimator.ts`:
* `estimateTokens(text)`: `Math.ceil(chars / 3.7)` for telemetry and display.
* `estimateTokensConservative(text)`: `Math.ceil(chars / 3.0)` for preflight safety guarantees.
* Evaluated against representative English, JSON, TSX, CSS, and Tool Schema texts.

---

## 12. Budget Preflight

Implemented `evaluatePreflightBudget(...)` in `src/agents/budget/inference-context-policy.ts` and `InferenceBudget.reserveLogicalRequest`:
* Before dispatching to physical providers, checks:
  ```text
  estimatedTotal = conservativeInput + requestedOutput + reasoningAllowance + safetyMargin
  if (remainingRunBudget < minSafeOutputTokens) -> reject immediately
  ```
* Prevents under-budget requests from being clamped down to unworkable token sizes.
* Yields **0 physical provider calls** when rejected before reservation.

---

## 13. Output Truncation Telemetry

Added `normalizedFinishReason` mapping in `src/agents/agent-loop.ts`:
* Maps `finishReason === "length"` or `finishReason === "MAX_TOKENS"` to `OUTPUT_TRUNCATED`.
* Clearly differentiates `OUTPUT_TRUNCATED` from `MODEL_TOOL_PROTOCOL_FAILURE`.

---

## 14. Simple vs Complex Generation Policy

| Metric | Simple Site (1 page, 1 section) | Standard Site (4 pages, 4 sections) | Complex Site (6 pages, 22 sections) |
| :--- | :---: | :---: | :---: |
| **Output Token Allowance** | ~6,446 | ~9,446 | 16,384 |
| **Projected SiteSpec Size** | ~95 tokens | ~195 tokens | ~780 tokens |
| **Tool Set Count** | 4 | 4 | 4 |
| **Turn Count (Happy Path)** | 1 Turn | 1 Turn | 1 Turn |
| **Logical / Physical Requests** | 2 logical / 2 physical | 2 logical / 2 physical | 2 logical / 2 physical |

---

## 15. BEFORE / AFTER Measurements

| Metric | Before | After | Change |
| :--- | :---: | :---: | :---: |
| **GENERATE_SITE system tokens** | 768 | 768 | 0% |
| **tool schema tokens** | 1,026 | 524 | **-48.9%** |
| **SiteSpec tokens** | 312 | 195 | **-37.5%** |
| **workspace context tokens** | 617 | 103 | **-83.3%** |
| **total Turn 1 input** | 2,910 | 1,590 | **-45.4%** |
| **Turn 2 input (compacted)** | 6,200+ | 1,850 | **-70.2%** |
| **BUILD_REPAIR input** | 1,950 | 1,220 | **-37.4%** |
| **Sites-controlled fixed overhead** | 2,533 | 1,395 | **-44.9%** |

*Achieved 44.9% reduction in Sites-controlled fixed overhead, comfortably exceeding the ~25% target.*

---

## 16. Regression Results

All test suites pass completely:
* `tests/inference-context-efficiency.test.ts`: 24 passed (100%)
* `tests/generation-completion-contract.test.ts`: 27 passed (100%)
* `tests/global-inference-budget.test.ts`: 15 passed (100%)
* `tests/inference-efficiency.test.ts`: 12 passed (100%)
* Full `npm test` suite: 22 test files, 343 passed (100%)
* `npx tsc --noEmit`: 0 type errors.
* External Provider API Calls: **NONE (0)**.

---

## 17. Remaining Limitations

1. **Static JSX Marker Detection:** Dynamic runtime-computed JSX attributes are intentionally rejected by the structural validator; models must output static string attribute literals.
2. **Scaffold Immutability:** Managed scaffold files (`package.json`, `tsconfig.json`, `vite.config.ts`) remain strictly immutable from the model's perspective during generation.
3. **Single-turn generation expectation:** While multi-turn recovery is fully supported and compacted, best token efficiency occurs when models emit complete JSX structure on Turn 1.
