# Next Action Agent — Design Spec

## Overview

A TypeScript library that treats an LLM as a next-action predictor rather than a conversational partner. The consumer provides state, tools, rules, and history; the library assembles an optimized context, calls the LLM with constrained structured output, and returns a single action choice.

The library is not a framework. It does not own the loop, manage side effects, or implement tool handlers. It is a decision engine: situation in, action out.

## Core Concepts

### The Decision Turn

Each call to `nextAction()` is a self-contained decision. The library:

1. Evaluates each tool's `validWhen` predicate against current state to determine the valid action set
2. Generates a JSON schema union from valid tools' parameter schemas
3. Calls the consumer's instructions function with current state
4. Serializes the current state for the model
5. Formats consumer-provided history into provider-native tool-calling message format
6. Enforces token budgets per section — rejects the call if any section overflows
7. Assembles the full payload and translates to the target provider's API format
8. Makes a single LLM call with structured output (constrained decoding)
9. Returns the chosen action plus metadata

No conversation history accumulates inside the library across turns. The history block is consumer-managed data that the library includes verbatim (after formatting) but never modifies.

### Boundaries of Responsibility

| Concern | Library | Consumer |
|---------|---------|----------|
| State schema | Validates against it | Defines it (Zod), maintains state |
| State storage | Holds current state in memory | Updates it between turns via `setState` |
| Tool definitions | Filters by rules, generates output schema | Defines tools, implements handlers |
| Rule evaluation | Runs `validWhen` predicates | Defines the predicates |
| Instructions | Includes in assembled context | Provides function `(state) => string` |
| History | Validates format, enforces budget, formats for model | Compresses, filters, stores between turns |
| Context assembly | Core responsibility | N/A |
| Token budgeting | Enforces per-section limits | Configures the limits |
| Provider translation | Handles all format differences | Picks provider, provides credentials |
| LLM call | Makes the call | N/A |
| Action execution | N/A | Implements tool handlers, updates state |
| The loop | N/A | Owns it entirely |

## API Surface

### `createAgent(config)`

Creates an agent instance. Config includes:

- **provider** — Provider type, model, credentials, and pass-through provider-specific options (thinking budgets, temperature, etc.)
- **state** — Zod schema defining the state shape
- **tools** — Array of tool definitions, each with name, description, Zod params schema, `validWhen` predicate, and optional per-tool instructions
- **instructions** — Function `(state) => string` returning situational instructions
- **context.budgets** — Explicit token budgets per section: `instructions`, `state`, `history`, `tools`

### Agent Instance Methods

- **setState(state)** — Replaces the current state entirely. Validated against the Zod schema. For partial updates, use `getState()`, merge, and `setState()` with the result.
- **getState()** — Returns the current state.
- **setHistory(history)** — Sets the current history. Validated structurally against the history entry format (correct fields and types), not semantically against tool definitions.
- **getHistory()** — Returns the current history.
- **nextAction(options?)** — Executes one decision turn. Returns the action plus metadata. Options include: `verbose` flag to include the full assembled context in the response, `signal` (AbortSignal) for cancellation, and `timeout` (ms) for per-call timeout. Throws `AbortError` on cancellation or timeout.

### Return Value from `nextAction()`

Standard response:
- **action** — `{ tool: string, params: object }` — the model's chosen action
- **meta** — `{ tokensUsed: { input, output }, cost?: number, model, latency }` — cost is estimated from token usage and a built-in price table when available; `undefined` for local models or unknown pricing

Verbose response adds:
- **context** — The full assembled payload sent to the LLM, for debugging

### Errors

Typed errors with actionable detail:

- **ValidationError** — State doesn't match schema, history format invalid
- **BudgetExceededError** — A section exceeds its token budget (includes which section, current size, budget limit)
- **NoValidToolsError** — No tool's `validWhen` returned true for the current state
- **ProviderError** — Auth failure, rate limit, network error, model unavailable
- **OutputError** — Structured output failed to parse, or the returned action's `tool` is not in the valid set, or `params` don't match the tool's Zod schema (defensive; shouldn't occur with constrained decoding but validated anyway)
- **AbortError** — The call was cancelled via AbortSignal or exceeded the per-call timeout

### Concurrency

Agent instances are not safe for concurrent `nextAction()` calls. The consumer should not call `nextAction()` while a previous call is in flight on the same instance. For parallel decisions, create separate agent instances.

### Streaming

Streaming is out of scope for v0. Each `nextAction()` call blocks until the LLM returns a complete response. Progress visibility for long-running reasoning model calls may be added in a future version.

## Provider Layer

### Architecture

The OpenAI SDK serves as the universal interface. Most providers (OpenAI, vLLM, OpenRouter) speak OpenAI-compatible APIs natively. Anthropic gets a thin adapter that translates between OpenAI-shaped requests and Anthropic's native Messages API.

The library passes through provider-specific options (thinking configuration, temperature, etc.) without opinion.

### Supported Providers

| Provider | Interface | Structured Output | Auth |
|----------|-----------|-------------------|------|
| OpenAI | OpenAI SDK direct | `response_format: json_schema` | API key or OAuth |
| Anthropic | Custom adapter to Messages API | `output_config.format: json_schema` | API key or OAuth |
| vLLM | OpenAI SDK, custom base URL | `response_format: json_schema` (constrained decoding) | None |
| OpenRouter | OpenAI SDK, custom base URL | Depends on upstream model | API key |

GPT-5 series reasoning models are the target for OpenAI. Legacy o3/o1 models are not explicitly blocked but not a design target.

### Retry Policy

The library relies on the OpenAI SDK's built-in retry logic for transient errors (429s, 5xxs, network timeouts) on OpenAI-compatible providers. The Anthropic adapter implements equivalent retry behavior for transient errors. Non-transient errors (auth failures, invalid requests) are surfaced immediately to the consumer.

### OAuth

Device code flows extracted from pi-ai (MIT licensed) for subscription-based access:

- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro

The library handles token refresh transparently — if a token is expired but refreshable, refresh and retry without surfacing an error. Only error if refresh fails. Initial device code login flow is handled by the library when triggered. OAuth tokens are stored on the filesystem in a configurable location (defaulting to `~/.next-action-agent/`).

## Context Assembly

### Token Budgeting

The consumer configures explicit token budgets per section:

```
instructions: N tokens
state: N tokens
history: N tokens
tools: N tokens
```

The library counts tokens for each section using a tokenizer appropriate to the target model. For OpenAI-compatible models, tiktoken (or a compatible implementation). For Anthropic, their token counting API endpoint. For unknown models, a conservative character-based approximation with a documented margin of error. If any section exceeds its budget, the call is rejected with a `BudgetExceededError` — no silent truncation, no summarization.

### History Formatting

The consumer provides history as an array of action-result pairs. Each entry has the shape:

- **tool** — `string` — which tool was called
- **params** — `object` — the parameters passed
- **result** — `string` — a summary of what happened
- **success** — `boolean` — whether the action succeeded (defaults to `true`)
- **timestamp** — `string` (ISO 8601, optional) — when the action occurred

The library translates these entries into the provider's native tool-calling message format — assistant tool_use + user tool_result blocks for Anthropic, assistant tool_calls + tool messages for OpenAI-shaped providers. This exploits the model's training on tool-calling conversation patterns.

The consumer owns compression, filtering, and storage of history. The library defines the format, validates it, and translates it for the model.

### Instructions

A function `(state) => string` that the consumer provides. Called each turn with current state. The consumer handles all selection logic — different instructions for different states, combining multiple instruction sources, etc.

## State Management

The library holds the state object in memory. The consumer:

- Defines the state shape via a Zod schema at agent creation
- Sets state via `setState()` (validated against the schema)
- Reads state via `getState()`
- Updates state between turns based on action results and external changes

The library uses the current state to evaluate tool predicates, generate instructions, and serialize state for the model context.

## Tool Definitions

Each tool has:

- **name** — Unique identifier
- **description** — Human-readable description (included in model context)
- **params** — Zod schema for the tool's parameters
- **validWhen** — Predicate function `(state) => boolean`
- **instructions** — Optional per-tool guidance included when the tool is valid

The library filters tools by `validWhen` and generates a JSON schema for the constrained output. The output shape is `{ tool: string, params: object }`. The schema uses `anyOf` at the params level (not root level, as OpenAI restricts root-level `anyOf`) to express the valid parameter shapes, with each branch associated with its tool name via a `const` discriminant. The exact schema structure needs validation during implementation against each provider's JSON Schema subset — OpenAI, Anthropic, and vLLM each have slightly different restrictions. Finding a portable representation that works across all providers is a core implementation task, not optional.

## Package Details

- **Runtime:** Bun
- **Language:** TypeScript
- **Structure:** Single package, monolithic
- **Dependencies:** OpenAI SDK (direct), Zod (peer)
- **Anthropic adapter:** Custom HTTP, no SDK dependency
- **Working name:** `next-action-agent` (placeholder)
- **Versioning:** Pre-1.0, expect breaking changes. Semver once stable.

### Divergences from Vision Doc

The vision doc ("Beyond the Sacred Conversation") describes a History Manager component that actively compresses and filters history. This spec delegates all history management to the consumer. The consumer has the domain knowledge to decide what history matters; the library enforces the budget and format.

The vision doc shows declarative YAML configuration with expression-string rules. This spec uses Zod schemas and predicate functions. This is a stronger fit for a TypeScript library — type-safe, flexible, no expression parser needed.

### Open Questions

1. **OAuth extraction scope** — pi-ai's OAuth module needs to be read through to determine coupling to the rest of pi-ai and the effort to extract the Anthropic and OpenAI device code flows.
2. **Discriminated union schema portability** — The exact JSON Schema structure for the action space output needs testing against OpenAI, Anthropic, and vLLM's structured output implementations to find a portable representation.

### Internal Organization

- **Core** — Agent creation, state management, rule evaluation, context assembly, token budgeting
- **Providers** — OpenAI SDK wrapper, Anthropic adapter, provider detection
- **OAuth** — Device code flows, token storage and refresh
- **Schema** — Zod-to-JSON-Schema conversion, history format definitions, output schema generation
