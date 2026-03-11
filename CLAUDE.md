# determinate

Decision engine that treats LLMs as next-action predictors with constrained structured output. Not a framework — does not own the loop. Consumer provides state, tools, rules, and history; library assembles optimized context, calls the LLM, returns a single action choice.

## Architecture

```
Consumer Loop
  └─> agent.setState(state)
  └─> agent.setHistory(history)
  └─> agent.nextAction()
        ├─ Filter tools by validWhen predicates
        ├─ Generate discriminated union JSON Schema from valid tools
        ├─ Assemble context (instructions, state, history, tool descriptions)
        ├─ Enforce per-section token budgets
        ├─ Translate to provider format (OpenAI or Anthropic)
        ├─ Single LLM call with constrained structured output
        ├─ Validate response, strip schema artifacts (tool_name discriminant)
        └─ Return { action: { tool, params }, meta: { tokensUsed, model, latency } }
```

## Key Design Decisions

- **Zod v4 required** (peer dep `>=4.0.0`). Uses `z.toJSONSchema()` for schema generation — the third-party `zod-to-json-schema` is broken with Zod v4.
- **Discriminated union uses single-value `enum`**, not `const`. The `const` keyword is unsound in vLLM's xgrammar constrained decoding. See `research/schema-portability-research.md`.
- **`tool_name` discriminant** is injected into the `params` object of the output schema for discrimination. It gets stripped in `agent.ts` before validating params against the tool's Zod schema.
- **History formatted as provider-native tool-calling messages** (tool_use/tool_result for Anthropic, tool_calls/tool for OpenAI). This exploits model training on tool-calling patterns.
- **Anthropic provider** is a raw fetch adapter (no SDK). Uses `output_config.format` for structured output, implements its own retry with exponential backoff.
- **OpenAI provider** uses the official OpenAI SDK. Handles OpenAI, vLLM, and OpenRouter via `baseUrl`.
- **Token budgeting** rejects (throws `BudgetExceededError`) if any section exceeds its budget. No silent truncation.
- **OAuth** extracted from pi-ai (MIT). Supports Anthropic and OpenAI device code flows. Tokens stored at `~/.determinate/` with 0o600 permissions.

## Project Structure

```
src/
  index.ts              Public API: createAgent(), re-exports
  agent.ts              Agent class: state, history, provider resolution, nextAction()
  types.ts              All shared interfaces
  errors.ts             6 typed error classes
  context/
    assembler.ts        Core: builds messages, filters tools, generates schema
    budget.ts           Per-section token budget enforcement
    tokenizer.ts        tiktoken (OpenAI/vLLM/OpenRouter), char approximation (Anthropic)
  schema/
    action-schema.ts    Generates discriminated union JSON Schema from Zod tool params
    history-schema.ts   Validates history entries
  providers/
    types.ts            Provider interface
    factory.ts          Provider instantiation by type
    openai.ts           OpenAI SDK wrapper (also vLLM, OpenRouter)
    anthropic.ts        Raw fetch Anthropic adapter with retry
  oauth/
    index.ts            Registry, getOAuthApiKey() with token refresh
    types.ts            OAuth interfaces
    pkce.ts             PKCE utilities (Web Crypto)
    anthropic.ts        Anthropic OAuth flow
    openai.ts           OpenAI OAuth flow (local callback server)
    token-store.ts      Filesystem credential storage
tests/                  Mirrors src/ structure, 75 unit tests
scripts/
  e2e-live.ts           Live tests against real providers (vLLM, OpenAI, Anthropic)
```

## Commands

- `bun test` — Run all tests (75 tests, ~1.3s)
- `bun scripts/e2e-live.ts` — Live e2e against local vLLM (default)
- `PROVIDER=openai OPENAI_API_KEY=... bun scripts/e2e-live.ts` — Against OpenAI
- `PROVIDER=anthropic ANTHROPIC_API_KEY=... bun scripts/e2e-live.ts` — Against Anthropic
- `bunx biome check src/ tests/` — Lint
- `bunx biome check --write src/ tests/` — Auto-fix lint
- `bunx tsc --noEmit` — Type check

## Code Style

- **Biome** for linting and formatting (tabs, 100 width)
- **No `any`** lint rule is disabled — `as any` casts are acceptable where needed
- Follow existing patterns. Match surrounding code style.

## Dependencies

- `openai` — OpenAI SDK (used for OpenAI, vLLM, OpenRouter providers)
- `tiktoken` — Token counting for OpenAI-compatible models
- `zod` — Peer dependency (`>=4.0.0`), used for all schema validation

## Common Pitfalls

- If `z.toJSONSchema()` returns empty/minimal output, check that you're on Zod v4. The function doesn't exist in v3.
- The `params` from the model response includes a `tool_name` field that must be stripped before Zod validation — this is handled in `agent.ts`.
- Provider-specific message formats differ: Anthropic uses `content: [{ type: "tool_use" }]` arrays, OpenAI uses `tool_calls` on assistant messages + `role: "tool"` messages.
- vLLM needs `--enforce-eager` on some GPUs (particularly WSL) to avoid CUDA graph capture failures.
