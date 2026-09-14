# AI Sites

**Current phase: Phase 17 — Complete Agent Intelligence Layer**

Sites supports AI-driven site generation, real build and preview, Playwright Visual QA, automatic repair, durable immutable versions, restart-safe restore/edit, static deployment, stable local hosting, managed generated-site data, contact/submission forms, public-read collections, controlled CRUD, persistent runtime records, and additive runtime schema evolution.

All 21 lifecycle areas are implemented and validated locally. Ten representative product scenarios completed with **PASS_WITH_WARNINGS**: pipeline/runtime/deployment behavior passed, while scenario-specific generated UI quality remains intentionally unproven by the generic MockAgent fixture. Production-ready: **NO**.

For manual local testing, run in two terminals:

```bash
npm run dev:server
npm run dev:web
```

Then open `http://localhost:5173`. The playground uses **AgentProvider = Mock** and **ExecutionProvider = Local** by default. It shows sanitized per-purpose intelligence status and validated plans. Real Phase 17 provider testing has not started.

To opt into Groq testing, set `GROQ_API_KEY` and `SITES_DEV_AGENT_PROVIDER=groq` in `.env`, then restart the backend. The default Groq model is `openai/gpt-oss-120b`; execution remains Local. See [local playground usage](docs/LOCAL_PLAYGROUND.md).

OpenRouter is also supported through the provider-neutral OpenAI-compatible adapter. Set `OPENROUTER_API_KEY`, `SITES_DEV_AGENT_PROVIDER=openrouter`, and optionally `OPENROUTER_AGENT_MODEL`; execution remains Local. See [local playground usage](docs/LOCAL_PLAYGROUND.md).

External validation remains intentionally deferred. Daytona is implemented but not live tested or selected; other sandbox providers are not implemented. AgentProvider adapters exist but real API tests are deferred. Production cloud storage/hosting/CDN/DNS/TLS are not integrated.

Local architecture:

- Platform metadata: SQLite.
- Artifacts: `LocalArtifactStore`.
- Generated-site runtime data: a deliberately separate SQLite database.
- Execution: `LocalExecutionProvider` for trusted development only.
- Hosting: static `LocalHostingProvider` plus managed runtime gateway.

```bash
npm install
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
npm run test:integration:site-runtime
npm run demo:site:runtime
npm run test:integration:full-architecture
npm run demo:site:full-lifecycle
npm run benchmark:local
npm run acceptance:local
npm run acceptance:site -- --scenario restaurant
npm run acceptance:version-stress
```

External integrations are frozen. Daytona is implemented and mock/contract tested, but live testing is deferred. No sandbox provider is selected as the production winner, and paid AgentProvider tests are deferred.

The architecture remains frozen. Local product acceptance is complete; real AgentProvider testing and sandbox benchmarking have **NOT STARTED**. Daytona remains implemented but untouched/deferred, and no production provider is selected.

See [Phase 17 report](docs/PHASE_17_COMPLETE.md), [intelligence matrix](docs/AGENT_INTELLIGENCE_MATRIX.md), [product acceptance](docs/LOCAL_PRODUCT_ACCEPTANCE.md), and [AgentProvider readiness](docs/AGENT_PROVIDER_TEST_READINESS.md).

Playground documentation: [local usage](docs/LOCAL_PLAYGROUND.md), [architecture](docs/PLAYGROUND_ARCHITECTURE.md), and [Phase 16 report](docs/PHASE_16_COMPLETE.md).
