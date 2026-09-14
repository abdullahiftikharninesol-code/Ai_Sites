# Phase 1: Global Run-Wide Inference Budget & Physical Request Accounting

## 1. Overview & Architecture

Prior to this phase, inference budgeting in Sites was fragmented across pipelines:
- Planning operated directly on the raw orchestrator provider without budget tracking.
- `LocalCliAgentRuntime.run()` created its own localized `BudgetedAgentProvider`.
- Visual QA review bypassed budgeting entirely.
- Visual repair instantiated a separate budget.
- Provider retries (`withProviderRetries`) executed multiple physical network attempts under a single logical request count, masking actual network consumption.
- SDK clients internally performed automatic retries, concealing physical attempts from Sites' accounting.

### Unified Architecture

Sites now establishes a single, run-wide `InferenceRunContext` created at pipeline entry (`generate()` or `edit()`) that owns both logical and physical request accounting across all execution stages:

```
Sites Operation (generate / edit)
 │
 ├── Sites Planning (SITE_PLANNING / EDIT_PLANNING)
 │     └── RunScopedAgentProvider
 ├── Runtime Generation / Edit (GENERATE_SITE / TARGETED_EDIT)
 │     └── RunScopedAgentProvider
 ├── Build Repair Loop (BUILD_REPAIR)
 │     └── RunScopedAgentProvider
 └── Visual QA & Repair (VISUAL_REVIEW / VISUAL_REPAIR)
       └── RunScopedAgentProvider
```

All stages share the exact same `InferenceBudget` instance.

---

## 2. Request Lifecycle & Physical Accounting

Every inference attempt follows an atomic check-and-reserve lifecycle:

```
Sites Operation / Retry Loop
  │
  ├─► 1. Assert Circuit Breaker (before physical reservation; breaker trip consumes 0 physical attempts)
  │
  ├─► 2. Synchronous Atomic Logical Reservation (checkLogicalLimit -> increment, 0 await)
  │
  ├─► 3. Synchronous Atomic Physical Reservation (checkPhysicalLimit -> increment, 0 await)
  │
  ├─► 4. Exactly 1 Physical SDK / HTTP Attempt (SDK-internal retries strictly disabled)
  │
  ├─► 5. Inspect Result & Capture Rate-Limit Metadata (status, retry-after, error code)
  │
  └─► 6. If Retryable Error and Budget Permits:
            Schedule next attempt -> Step 1 (re-reserves 1 physical request per network attempt)
```

### Atomic Reservations

Both logical and physical reservations are strictly synchronous:
```typescript
public reserveLogicalRequest(stage: InferenceStage): void {
  this.assertLimits();
  if (this._usage.logicalRequests >= this._limits.maxLogicalRequests) {
    throw new InferenceBudgetExceededError(...);
  }
  this._usage.logicalRequests += 1;
  this._usage.requestsByStage[stage] = (this._usage.requestsByStage[stage] ?? 0) + 1;
}

public reservePhysicalRequest(stage: InferenceStage, attempt: number): void {
  this.assertLimits();
  if (this._usage.physicalRequests >= this._limits.maxPhysicalRequests) {
    throw new InferenceBudgetExceededError(...);
  }
  this._usage.physicalRequests += 1;
  this._usage.physicalRequestsByStage[stage] = (this._usage.physicalRequestsByStage[stage] ?? 0) + 1;
}
```
There is no `await` between checking the limit and incrementing the counter, preventing race conditions.

---

## 3. SDK-Internal Retries Disabled

To ensure that Sites completely owns the physical retry loop and that 1 transport reservation corresponds to at most 1 physical network attempt, built-in automatic retries have been explicitly disabled across all provider SDK clients:

1. **OpenAI SDK** (`src/agents/openai/openai-agent.provider.ts`):
   ```typescript
   this.client = new OpenAI({ apiKey: this.apiKey, maxRetries: 0 });
   ```
2. **Anthropic SDK** (`src/agents/anthropic/anthropic-agent.provider.ts`):
   ```typescript
   this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 0 });
   ```
3. **OpenAI-Compatible SDK** (`src/agents/openai-compatible/chat-completions.provider.ts` - Groq, OpenRouter, DeepSeek, XAI, Kimi):
   ```typescript
   this.client = new OpenAI({ baseURL: this.baseUrl, apiKey: this.apiKey, maxRetries: 0 });
   ```
4. **Google GenAI / Gemini** (`src/agents/gemini/gemini-agent.provider.ts`):
   ```typescript
   // Passed in request options or GoogleGenAI client config:
   retryOptions: { attempts: 1 }
   ```

---

## 4. Canonical Inference Stages

All telemetry, runtime execution, and budgeting use the canonical `InferenceStage` enum:

```typescript
export enum InferenceStage {
  SITE_PLANNING = "SITE_PLANNING",
  GENERATE_SITE = "GENERATE_SITE",
  BUILD_REPAIR = "BUILD_REPAIR",
  EDIT_PLANNING = "EDIT_PLANNING",
  TARGETED_EDIT = "TARGETED_EDIT",
  VISUAL_REVIEW = "VISUAL_REVIEW",
  VISUAL_REPAIR = "VISUAL_REPAIR",
}
```

Legacy `CODE_GENERATION` is deprecated and mapped to `GENERATE_SITE`.

---

## 5. Independent Budget Limits & Legacy Mapping

Logical and physical request limits are configured separately and are not coupled by mathematical multipliers (e.g. `* 2`):

- **Default Limits**:
  - `maxLogicalRequests`: `4`
  - `maxPhysicalRequests`: `6`
  - `maxDurationMs`: `180_000` (3 minutes)
  - `maxEstimatedTotalTokens`: `200_000`
  - `maxEstimatedOutputTokens`: `32_000`

- **Legacy Mapping**:
  Existing caller-supplied `maxModelRequests: 3` previously governed only code generation, repair, and continuation (excluding planning). When resolving legacy config:
  ```typescript
  if (config?.maxModelRequests !== undefined) {
    // Explicitly add +1 for planning to preserve generation capacity
    resolvedLogical = config.maxModelRequests + 1; // e.g. 3 -> 4
  }
  ```
  Physical limits default independently to `resolvedLogical + 2` (or explicit `maxPhysicalRequests`), avoiding arbitrary multiplier explosions.

---

## 6. Telemetry & Rate-Limit Metadata

Rate-limit metadata is extracted on a best-effort basis from error payloads and headers:
- **Core Fields**: HTTP status, provider error code/category, `retry-after` duration, retry attempt telemetry.
- **Extended Fields**: Request limits, remaining requests, token limits, reset timestamps.

Telemetry collector maintains an immutable record of all attempts, including duration, tokens consumed, provider name, model name, and error taxonomy, exposed via `runContext.getSummary()`.

---

## 7. Verification & Test Suite

The implementation is verified via `tests/global-inference-budget.test.ts` (15 passing tests) covering Scenarios A through L:

- **Scenario A**: Normal generation tracks 1 planning + 1 generation across all counters.
- **Scenario B**: Build failure with repair consumes 1 planning + 1 generation + 1 repair = 3 logical and 3 physical requests.
- **Scenario C**: Provider retries consume 1 logical request and 2 physical requests.
- **Scenario D**: Budget exhaustion at planning immediately aborts before code generation.
- **Scenario E**: Budget exhaustion before repair halts the pipeline and throws `InferenceBudgetExceededError`.
- **Scenario F**: Visual repair uses the same shared budget.
- **Scenario G**: Targeted edit shares budget without re-running site planning.
- **Scenario H**: Output token limits correctly clamp `maxTokens` on requests.
- **Scenario I**: Telemetry collector records per-stage breakdown, duration, tokens, and rate-limit metadata.
- **Scenario J**: Circuit breaker trip aborts before physical reservation, consuming 0 physical requests.
- **Scenario K**: Failed network requests still consume their physical reservations.
- **Scenario L (Required Amendment)**: Hidden SDK retry prevention verifies that SDK internal retries are disabled (1 transport reservation = 1 network attempt), and Sites' own retry loop increments physical requests attempt-by-attempt with zero hidden sub-requests.
