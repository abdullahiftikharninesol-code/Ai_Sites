# Phase 3.1: Provider-Neutral Structured Response Contracts & Adapter Boundary Telemetry

## Executive Summary

During the initial real Gemini end-to-end site generation validation, the pipeline successfully reached Google's Gemini provider over HTTP 200 with `finishReason = STOP`. However, local site planning failed because Gemini wrapped its valid JSON output in a Markdown code fence:
````text
```json
{
  ...
}
```
````
while downstream planning logic performed a strict, unwrapped `JSON.parse(response.message.content)`.

Phase 3.1 resolves this issue and establishes a provider-neutral structured response contract architecture across all supported LLM providers while:
1. Maintaining authoritative local domain validation as the single source of truth.
2. Providing deterministic, zero-repair fallback markdown code fence stripping.
3. Mapping native structured schema and JSON mode based on explicit per-provider capabilities.
4. Keeping tool-calling semantics completely orthogonal to response contracts.
5. Measuring component-safe provider boundary telemetry without secret contamination.
6. Preserving normal request budget invariants: exactly **1 logical and 1 physical request** for site planning, and **2 logical and 2 physical requests** for the entire normal site generation pipeline.
7. Executing 0 external network calls during automated test execution.

---

## 1. Token Estimation Discrepancy Investigation

### Prior Discrepancy Observation
During the initial real Gemini validation, local request token estimation was approximately **257 tokens**, whereas Gemini's actual response usage metadata reported **1,142 input tokens**.

### Root Cause Analysis
Investigation identified four primary sources of the discrepancy:

1. **Pre-Adapter vs. Post-Adapter Boundary Measurement**:
   Local budgeting in Phase 1 and 2 measured tokens at the application entrypoint (measuring raw user prompt and brief system instruction strings). However, at the provider adapter boundary:
   - System instructions are wrapped with provider framing guidelines.
   - Provider-specific configuration objects (such as `thinkingConfig`, `maxOutputTokens`) and adapter context were omitted from token estimation.

2. **Unmeasured Provider-Facing JSON Schema Payload**:
   When structured response schemas or tool definitions are supplied to Gemini (`config.responseSchema` or `config.tools`), the Gemini API tokenizes the entire JSON schema declaration as part of the prompt context (input tokens). `CANONICAL_SITE_PLAN_JSON_SCHEMA` is ~4,500 characters, which alone accounts for ~700–900 tokens that were previously invisible to local pre-adapter estimators.

3. **Thinking Budget & Model Preamble Overhead**:
   Gemini 2.5 Flash incorporates implicit system directives and reasoning prompt structures that expand provider-side token accounting.

### Resolution: Component-Safe Provider Boundary Telemetry
Rather than naively stringifying the whole SDK client request (which poses secret-leakage risks), Phase 3.1 implements `measureProviderBoundary()` in `src/agents/shared/provider-boundary-telemetry.ts`:
- Measures known, non-secret request components individually right before invocation:
  - `systemInstructionCharacters`
  - `contentsCharacters`
  - `toolSchemaCharacters`
  - `responseSchemaCharacters` and `responseSchemaEstimatedTokens`
  - `otherMappedContextCharacters` (e.g. non-secret runtime configs)
- Derives aggregate:
  - `providerBoundaryCharacters`
  - `providerBoundaryEstimatedTokens`
- Explicitly excludes credentials, API keys, HTTP auth headers, retry configurations, and internal SDK objects.

---

## 2. One Source of Truth for SitePlan & SiteEditPlan

### Architectural Principle
No duplicate schema definitions that can drift from runtime validator logic.

### Authoritative Runtime Validators
- **SitePlan**: `validateSitePlan(value: unknown): SitePlan` in [`src/sites/domain/site-plan.ts`](file:///c:/Users/Ninesol/Desktop/Sites/src/sites/domain/site-plan.ts) is the authoritative domain validator.
- **SiteEditPlan**: `validateSiteEditPlan(value: unknown): SiteEditPlan` in [`src/sites/domain/site-plan.ts`](file:///c:/Users/Ninesol/Desktop/Sites/src/sites/domain/site-plan.ts) (wrapping `IntelligenceValidators.validateEdit`) is the authoritative edit validator.

### Canonical Domain Schemas
- `CANONICAL_SITE_PLAN_JSON_SCHEMA` in [`src/sites/domain/site-plan-schema.ts`](file:///c:/Users/Ninesol/Desktop/Sites/src/sites/domain/site-plan-schema.ts) mirrors the authoritative domain contract.
- Contract alignment tests (Scenario P) explicitly verify:
  - Every required runtime field is required by the provider schema (`requirements`, `design`).
  - Required nested fields (`pages`, `features`, `direction`, `responsiveness`) are strictly enforced.
  - Optional runtime fields (`site`, `capabilities`, `content`, `constraints`, `spacing`, `typography`, etc.) remain optional.
  - Representative valid SitePlans pass both schema and runtime validation.
  - Representative invalid SitePlans fail both.

---

## 3. Provider Schema Projections

To ensure domain models remain decoupled from specific provider limitations:
- The canonical domain schema never incorporates provider-specific hacks or restrictions.
- Provider adapters use projection functions:
  - **Gemini**: `projectGeminiSchema(schema)` removes keywords unsupported by `@google/genai` (such as `$schema`).
  - **OpenAI**: `projectOpenAISchema(schema)` prepares strict schemas suitable for OpenAI's `json_schema` response format while leaving the original canonical schema object unmutated.

```text
Canonical SitePlan Schema
        │
        ├── projectGeminiSchema ──> Gemini responseSchema (no $schema)
        └── projectOpenAISchema ──> OpenAI text.format / json_schema
```

---

## 4. Provider Capability Matrix

OpenAI-compatible endpoints vary in their support for `response_format`. Rather than assuming blanket support, Phase 3.1 introduces `StructuredOutputCapability`:

```ts
export type StructuredOutputCapability = "NATIVE_SCHEMA" | "JSON_MODE" | "FALLBACK_TEXT";
```

### Provider Classifications

| Provider | Adapter | Capability | Wire Parameters | Fallback Path |
| :--- | :--- | :--- | :--- | :--- |
| **Gemini** | `GeminiAgentProvider` | `NATIVE_SCHEMA` | `responseMimeType: "application/json"`, `responseSchema: projectGeminiSchema(...)` | Strip outer fence if present + validate |
| **OpenAI** | `OpenAIAgentProvider` | `NATIVE_SCHEMA` | `text.format: { type: "json_schema", ... }` | Strip outer fence if present + validate |
| **Groq** | `GroqAgentProvider` | `JSON_MODE` | `response_format: { type: "json_object" }` | Strip outer fence if present + validate |
| **OpenRouter** | `OpenRouterAgentProvider` | `JSON_MODE` | `response_format: { type: "json_object" }` | Strip outer fence if present + validate |
| **DeepSeek** | `DeepSeekAgentProvider` | `JSON_MODE` | `response_format: { type: "json_object" }` | Strip outer fence if present + validate |
| **XAI** | `XaiAgentProvider` | `JSON_MODE` | `response_format: { type: "json_object" }` | Strip outer fence if present + validate |
| **Kimi** | `KimiAgentProvider` | `JSON_MODE` | `response_format: { type: "json_object" }` | Strip outer fence if present + validate |
| **Anthropic** | `AnthropicAgentProvider` | `FALLBACK_TEXT` | *(None — omitted)* | System prompt instruction + strip outer fence + validate |

Unsupported parameters are never speculatively transmitted over the wire.

---

## 5. Strict Fallback Parser & Local Validation

The structured response parsing pipeline in `src/agents/shared/structured-response-parser.ts` enforces deterministic extraction:

```text
Model Response Content
        │
        ▼
stripOuterMarkdownFence()
  ├── Raw JSON -> Accepted (unstripped)
  ├── ```json\n{...}\n``` -> Stripped
  ├── ```\n{...}\n``` -> Stripped
  └── Prose + JSON ("Here is your plan...") -> Preserved as-is (fence NOT stripped)
        │
        ▼
JSON.parse()
  └── If invalid syntax -> ApplicationError("STRUCTURED_RESPONSE_PARSE_FAILED")
        │
        ▼
Local Runtime Validator (validateSitePlan / validateSiteEditPlan)
  └── If schema invalid -> ApplicationError("STRUCTURED_RESPONSE_SCHEMA_INVALID")
        │
        ▼
Typed Domain Object (SitePlan / SiteEditPlan)
```

### Critical Invariants
- **No Regex Heuristics**: Surrounding prose is rejected cleanly without fuzzy matching.
- **No LLM Repair Calls**: Malformed or non-compliant responses fail immediately without consuming extra inference budget.
- **Local Validation is Mandatory**: Even when native schema mode is used, data is validated locally before reaching application layers.

---

## 6. Orthogonal Tool Calling Protocol

`AgentResponseContract` is strictly separated from tool execution:
```ts
export type AgentResponseContract =
  | { readonly type: "TEXT" }
  | {
      readonly type: "JSON_SCHEMA";
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict?: boolean;
    };
```
- No `{ type: "TOOLS" }` contract was introduced.
- `GENERATE_SITE` operations continue to supply tools (`write_file`, `read_file`, `apply_patch`, `finalize_generation`) and handle tool choice independently of response contracts.

---

## 7. Verification Matrix & Scenarios

All 20 target scenarios (A through T) are implemented and verified in [`tests/structured-response-contract.test.ts`](file:///c:/Users/Ninesol/Desktop/Sites/tests/structured-response-contract.test.ts):

| Scenario | Description | Result |
| :--- | :--- | :--- |
| **A** | Native structured SitePlan response parses without fallback parser | **PASS** |
| **B** | Raw JSON text response parses correctly | **PASS** |
| **C** | ```` ```json ```` markdown fence stripped and validated | **PASS** |
| **D** | Unlabeled ```` ``` ```` markdown fence stripped and validated | **PASS** |
| **E** | Malformed JSON fails with `STRUCTURED_RESPONSE_PARSE_FAILED` | **PASS** |
| **F** | Valid JSON with wrong schema fails with `STRUCTURED_RESPONSE_SCHEMA_INVALID` | **PASS** |
| **G** | Empty / whitespace response fails with `STRUCTURED_RESPONSE_EMPTY` | **PASS** |
| **H** | Conversational prose surrounding JSON strictly rejected | **PASS** |
| **I** | Gemini maps `responseMimeType` and projected `responseSchema` (no `$schema`) | **PASS** |
| **J** | OpenAI maps `text.format: { type: "json_schema", ... }` | **PASS** |
| **K** | Unsupported provider / `FALLBACK_TEXT` omits structured parameters | **PASS** |
| **L** | Physical request invariant on schema failure: exactly 1 logical, 1 physical request | **PASS** |
| **M** | SitePlan downstream compatibility with `sitePlanToRequirementSpec` and `sitePlanToSiteSpec` | **PASS** |
| **N** | Phase 2 completion contract & `finalize_generation` protocol unaffected | **PASS** |
| **O** | Provider-boundary telemetry safe, measuring individual components without secrets | **PASS** |
| **P** | Canonical/runtime schema alignment tests for SitePlan and SiteEditPlan | **PASS** |
| **Q** | Gemini schema projection removes `$schema` keyword | **PASS** |
| **R** | OpenAI schema projection produces valid format without mutating canonical schema | **PASS** |
| **S** | Capability matrix verified for Groq, OpenRouter, DeepSeek, XAI, Kimi, Anthropic, Gemini, OpenAI | **PASS** |
| **T** | Tool protocol orthogonality verified (GENERATE_SITE retains all 4 tools, independent of response contracts) | **PASS** |

---

## 8. Full Suite Regression Results

- `tests/structured-response-contract.test.ts`: **27/27 PASS**
- `tests/global-inference-budget.test.ts`: **15/15 PASS**
- `tests/generation-completion-contract.test.ts`: **27/27 PASS**
- `tests/inference-context-efficiency.test.ts`: **32/32 PASS**
- `tests/inference-efficiency.test.ts`: **12/12 PASS**
- `tests/provider-stability.test.ts`: **14/14 PASS**
- `tests/phase-3b.test.ts`: **97/97 PASS**
- Full `npm test`: **22/22 test files, 343/343 tests PASS**
- TypeScript Compiler (`npx tsc --noEmit`): **0 errors**
- External Network Calls: **0**

---

## 9. Next Step & Status

Phase 3.1 is fully implemented, verified, and backward-compatible.

Status: **`READY_FOR_NORTHSMILE_REAL_TEST`**
