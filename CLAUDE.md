# determinate

Decision engine that treats LLMs as next-action predictors with constrained structured output. Not a framework — does not own the loop. Consumer provides state, tools, instructions, and history; library assembles optimized context, calls the LLM, returns a single action choice.

## Architecture

```
Consumer Loop
  └─> agent.setState(state)
  └─> agent.setHistory(history)
  └─> agent.nextAction()
        ├─ Filter tools by validWhen predicates
        ├─ Generate coupled action union from valid tools (one branch per tool)
        ├─ Normalize the schema for the target provider's strictness rules
        ├─ Assemble context (instructions, history, tool descriptions)
        ├─ Enforce per-section token budgets
        ├─ If a decider is configured: one Jev request picks the tool and fills closed-set
        │    params. A complete action returns here; a tool-only answer narrows the steps
        │    below to that tool; low confidence or an unavailable decider changes nothing
        ├─ Translate to provider format (OpenAI or Anthropic)
        ├─ Single LLM call with constrained structured output
        ├─ Validate tool against the valid set and params against the tool's Zod schema
        ├─ On malformed output, re-ask with a correction message (outputRetries, default 2)
        └─ Return { action: { tool, params }, meta: { tokensUsed, model, latency } }
```

## Key Design Decisions

- **Zod v4 required** (peer dep `>=4.0.0`). Uses `z.toJSONSchema()` for schema generation — the third-party `zod-to-json-schema` is broken with Zod v4.
- **Discriminated union uses single-value `enum`**, not `const`. The `const` keyword is unsound in vLLM's xgrammar constrained decoding. See `research/schema-portability-research.md`.
- **Action union couples each tool to its own params.** Every branch of the union is `{ tool: { enum: ["<name>"] }, params: <that tool's schema> }`, so a crossed tool/params pair is structurally invalid and a constrained decoder rejects it. This replaced an earlier design where `tool` and `params` were declared independently and a hidden `tool_name` discriminant lived inside `params`; models could satisfy that schema while pairing one tool with another tool's parameters.
- **Provider-specific schema relaxation** happens at generation time only, in `generateActionSchema` options. OpenAI (and `openai/*` on OpenRouter) forbids root-level unions and optional object properties, so it gets a merged strict root object; Anthropic (and `anthropic/*` on OpenRouter) rejects several numeric keywords, which get stripped. The chosen action is always validated against the authoritative per-tool Zod schema afterwards, so relaxation never weakens validation.
- **Optional params become required-but-nullable** for strict structured-output providers. `agent.ts` retries validation with null placeholders removed (`omitNullObjectFields`) before reporting a params failure.
- **Malformed output is recoverable.** `nextAction()` re-asks up to `outputRetries` times (default 2) with a correction message appended. `parse-action.ts` additionally recovers DeepSeek's native DSML tool-call envelope when a model degrades out of JSON structured output.
- **History formatted as provider-native tool-calling messages** (tool_use/tool_result for Anthropic, tool_calls/tool for OpenAI). This exploits model training on tool-calling patterns.
- **Anthropic provider** is a raw fetch adapter (no SDK). Uses `output_config.format` for structured output, implements its own retry with exponential backoff.
- **OpenAI provider** uses the official OpenAI SDK. Handles OpenAI, vLLM, and OpenRouter via `baseUrl`.
- **State is not sent to the model** — state is only passed to `instructions(state)` and `validWhen(state)`. The consumer controls what the model sees through the instructions function.
- **The decider (TypeSafe Jev) sits beside the provider, not in place of it.** Jev only chooses among declared options (Choice questions, max 255 options) and cannot produce strings or numbers, so `AgentConfig.decider` is optional and `provider` stays mandatory. `decider/closed-params.ts` decides per tool whether every param is closed-set (enum, literal, boolean, nullable/optional of those) by inspecting `z.toJSONSchema(params, { io: "input" })`. One request carries the tool question plus param questions for every closed-set tool, because Jev answers questions in parallel and cannot condition one on another. Optional params get an extra `(unset)` option. Decider answers go through the same per-tool Zod validation as LLM output. Transient decider failures fall back to the LLM; 4xx rejections throw, so a bad key is not masked by a working LLM.
- **Token budgeting** rejects (throws `BudgetExceededError`) if any section (instructions, history, tools) exceeds its budget. No silent truncation.
- **OAuth** extracted from pi-ai (MIT). Supports Anthropic and OpenAI device code flows. Tokens stored at `~/.determinate/` with 0o600 permissions.
- **Node.js 22+ floor** since the openai SDK v7 bump. The OpenAI client also rejects an empty `apiKey` at construction, so `openai.ts` substitutes a placeholder to keep keyless self-hosted (vLLM) endpoints working.

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
    action-schema.ts    Generates the coupled action union from Zod tool params,
                        with per-provider strictness normalization
    history-schema.ts   Validates history entries
  decider/
    decide.ts           consultDecider(): ask, resolve, apply minConfidence, validate
    closed-params.ts    Which Zod param schemas a choose-only model can fill
    questions.ts        Builds Choice questions and state; maps answers back to params
    typesafe.ts         Raw fetch client for POST /v1/systemone with short retry
  providers/
    types.ts            Provider interface
    factory.ts          Provider instantiation by type
    openai.ts           OpenAI SDK wrapper (also vLLM, OpenRouter)
    anthropic.ts        Raw fetch Anthropic adapter with retry
    parse-action.ts     Shared { tool, params } parser, plus DeepSeek DSML recovery
  oauth/
    index.ts            Registry, getOAuthApiKey() with token refresh
    types.ts            OAuth interfaces
    pkce.ts             PKCE utilities (Web Crypto)
    anthropic.ts        Anthropic OAuth flow
    openai.ts           OpenAI OAuth flow (local callback server)
    token-store.ts      Filesystem credential storage
tests/                  Mirrors src/ structure, 113 unit tests
scripts/
  e2e-live.ts           Live tests against real providers (vLLM, OpenAI, Anthropic, OpenRouter, TypeSafe)
  bench-decider.ts      Decider vs LLM accuracy, latency and confidence calibration
```

## Commands

- `bun run build` — Compile TypeScript to `dist/` (JS + declarations + source maps)
- `bun test` — Run all tests (113 tests)
- `bun run lint` — Lint with Biome
- `bun run lint:fix` — Auto-fix lint issues
- `bun run typecheck` — Type check without emitting
- `bun scripts/e2e-live.ts` — Live e2e against local vLLM (default)
- `PROVIDER=openai OPENAI_API_KEY=... bun scripts/e2e-live.ts` — Against OpenAI
- `PROVIDER=anthropic ANTHROPIC_API_KEY=... bun scripts/e2e-live.ts` — Against Anthropic
- `PROVIDER=openrouter OPENROUTER_API_KEY=... bun scripts/e2e-live.ts` — Against OpenRouter (`OPENROUTER_MODEL`, default `openai/gpt-4o-mini`). Bun loads a gitignored `.env` automatically
- `TYPESAFE_API_KEY=... bun scripts/e2e-live.ts` — Adds the decider tests in front of the chosen provider; `E2E_FILTER="without the LLM"` runs only the one that needs no LLM
- `bun scripts/bench-decider.ts` — Benchmarks Jev alone, an OpenRouter LLM alone (`BENCH_MODEL`) and the hybrid pipeline on 51 scenarios with known answers; needs `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY`. `BENCH_ARMS`, `BENCH_FILTER`, `BENCH_MIN_CONFIDENCE`, `BENCH_OUT` narrow or record a run

## Commit Conventions

This project uses **Conventional Commits** enforced by commitlint. Every commit message must follow this format:

```
type(scope): description
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

- `feat` — new feature (triggers minor version bump)
- `fix` — bug fix (triggers patch version bump)
- `feat!` or `fix!` or `BREAKING CHANGE:` in footer — triggers major version bump
- All other types — no version bump

**Rules:**
- Type is required, scope is optional
- Description must be lowercase, no period at end
- Keep the subject line under 100 characters
- Use the body for additional context when needed

**Examples:**
```
feat: add openrouter provider support
fix(anthropic): handle empty content blocks in response
refactor: extract shared action parser from providers
test: add budget enforcement edge cases
chore(deps): bump openai sdk to v7
feat!: remove deprecated setRules API
```

**Versioning:** Handled automatically by semantic-release on main. Never manually edit the version in package.json.

## Code Style

- **Biome** for linting and formatting (tabs, 100 width)
- **No `any` anywhere** — `noExplicitAny` is an error. Use `unknown` and narrow with type assertions to specific interfaces. For untyped API responses (e.g. `fetch().json()`), cast to a named interface, not `any`. In tests, use `as unknown as TargetType` for intentionally invalid inputs.
- **No non-null assertions** (`!`) — use fallback values (`?? []`, `?? ""`) or guard checks instead.
- **No unused code** — `noUnusedVariables`, `noUnusedImports`, `noUnusedFunctionParameters` are all errors.
- Follow existing patterns. Match surrounding code style.

## Dependencies

- `openai` — OpenAI SDK (used for OpenAI, vLLM, OpenRouter providers)
- `tiktoken` — Token counting for OpenAI-compatible models
- `zod` — Peer dependency (`>=4.0.0`), used for all schema validation

## Common Pitfalls

- If `z.toJSONSchema()` returns empty/minimal output, check that you're on Zod v4. The function doesn't exist in v3.
- Strict providers receive optional params as required-but-nullable. The model then returns explicit `null`s, which `agent.ts` strips (`omitNullObjectFields`) before re-validating against the tool's Zod schema. If you add a validation path, keep that fallback.
- Relaxing a schema for a provider (stripping numeric keywords, merging the root object) only affects what the model is asked to produce. Never relax the Zod validation that follows it.
- The decider path and the LLM path must agree on validation. If you change how params are validated in `askProvider`, check `judgeDecision` in `decider/decide.ts` too.
- Provider-specific message formats differ: Anthropic uses `content: [{ type: "tool_use" }]` arrays, OpenAI uses `tool_calls` on assistant messages + `role: "tool"` messages.
- vLLM needs `--enforce-eager` on some GPUs (particularly WSL) to avoid CUDA graph capture failures.
- A non-conventional commit subject makes semantic-release analyse the merge as "no release", and the work silently never ships. CI now runs commitlint over each pull request's commit range to catch this.
