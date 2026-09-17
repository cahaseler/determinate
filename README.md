# determinate

A TypeScript library that treats LLMs as next-action predictors instead of conversational partners.

## The Problem

Current agentic frameworks are built around a conversation metaphor: an append-only chat history, a static list of tools, and a loop that generates the next message given everything that came before. This works well for coding assistants where the environment is stable, but falls apart in dynamic environments where:

- **State goes stale.** If you inject environment state each turn across a 50-turn interaction, you have 50 snapshots in context, 49 of which are wrong. The oldest, most incorrect snapshot has the strongest positional signal.
- **Context fills with noise.** Failed tool calls, redundant observations, and retry loops consume tokens without contributing to decisions. Half the conversation history in a typical agentic run is the agent's own mistakes.
- **Tools are over-injected.** For a system with 180 possible actions, all 180 schemas are injected every call, even when only 20 are relevant in the current state.
- **The model does housekeeping instead of reasoning.** The model spends capacity reconciling stale state, filtering irrelevant tools, and formatting output instead of making the actual decision.

For the full argument, see [Beyond the Sacred Conversation](beyond-the-sacred-conversation.md).

## The Approach

The unit of work is not a conversation turn. It is a **state-to-action decision**.

`determinate` is a decision engine, not a framework. It does not own the loop, manage side effects, or implement tool handlers. You provide the situation; it returns an action.

Each call to `nextAction()`:

1. Filters tools to only those valid in the current state
2. Generates a constrained output schema — the model *cannot* choose an invalid action
3. Assembles an optimized context with explicit token budgets per section
4. Makes a single LLM call with structured output (constrained decoding)
5. Returns the chosen action with validated parameters

No conversation history accumulates inside the library. Context is an intentional budget, not a dumping ground.

## Quick Start

```bash
bun add determinate
# zod is a peer dependency
bun add zod
```

```typescript
import { z } from "zod";
import { createAgent } from "determinate";

const agent = createAgent({
  provider: {
    type: "openai",          // or "anthropic", "vllm", "openrouter"
    model: "gpt-5-nano",
    apiKey: process.env.OPENAI_API_KEY,
  },
  state: z.object({
    order: z.object({
      status: z.enum(["pending", "approved", "shipped"]),
      riskScore: z.number(),
      items: z.array(z.object({ name: z.string(), qty: z.number() })),
    }),
  }),
  tools: [
    {
      name: "approve_order",
      description: "Approve a pending order",
      params: z.object({ note: z.string() }),
      validWhen: (s) => s.order.status === "pending" && s.order.riskScore < 0.7,
    },
    {
      name: "escalate_order",
      description: "Escalate order for human review",
      params: z.object({ reason: z.string() }),
      validWhen: (s) => s.order.status === "pending" && s.order.riskScore >= 0.7,
    },
    {
      name: "ship_order",
      description: "Ship an approved order",
      params: z.object({ carrier: z.enum(["fedex", "ups", "usps"]) }),
      validWhen: (s) => s.order.status === "approved",
    },
  ],
  instructions: (s) =>
    `You are an order processing agent. Evaluate order risk and take appropriate action.
     Current risk score: ${s.order.riskScore}`,
  context: {
    budgets: { instructions: 5000, history: 10000, tools: 3000 },
  },
});

// Your loop — you own it
agent.setState({
  order: { status: "pending", riskScore: 0.3, items: [{ name: "Widget", qty: 2 }] },
});

const result = await agent.nextAction();
// { action: { tool: "approve_order", params: { note: "Low risk, standard order" } },
//   meta: { tokensUsed: { input: 180, output: 30 }, model: "gpt-5-nano", latency: 892 } }

// You execute the action, update state, call nextAction() again
```

## Core Concepts

### State

Define your environment state as a Zod schema. The library validates it and passes it to your tool predicates and instruction function. You replace it entirely each turn via `setState()` — no stale snapshots accumulating.

**State is never sent to the model.** It reaches the LLM only through whatever your `instructions(state)` function chooses to say about it, so you decide exactly what the model sees. That is why `TokenBudgets` has no `state` section.

### Tools with Conditional Validity

Each tool has a `validWhen` predicate evaluated against current state. Only valid tools are presented to the model, and the constrained output schema makes it physically impossible for the model to choose an invalid tool. This is least-privilege enforced structurally, not by hoping the model follows instructions.

### Token Budgets

You set explicit token budgets per section (instructions, history, tools). If any section exceeds its budget, the call is rejected with a `BudgetExceededError` — no silent truncation. This makes context overflow a build-time problem you fix once, not a runtime surprise.

### History

You manage history. The library defines the format, validates it, and translates it into provider-native tool-calling messages (exploiting model training on tool-calling patterns). You control what history to include, how to compress it, and when to drop entries.

```typescript
agent.setHistory([
  {
    tool: "request_info",
    params: { field: "shipping_address" },
    result: "Customer provided: 123 Main St",
    success: true,
  },
]);
```

### Instructions

A function from state to string. Called each turn, so you can provide different instructions for different situations without any framework machinery.

```typescript
instructions: (s) => {
  if (s.order.riskScore > 0.9) return "This is an extremely high-risk order. Escalate immediately.";
  if (s.order.status === "approved") return "Select carrier based on package weight and destination.";
  return "Evaluate the order against standard fulfillment policy.";
},
```

## Providers

| Provider | How | Structured Output |
|----------|-----|-------------------|
| OpenAI | OpenAI SDK | `response_format: json_schema` |
| Anthropic | Raw fetch adapter | `output_config.format: json_schema` |
| vLLM | OpenAI SDK + custom base URL | Constrained decoding (xgrammar/outlines) |
| OpenRouter | OpenAI SDK + custom base URL | Depends on upstream model |

```typescript
// Local vLLM
provider: { type: "vllm", model: "Qwen/Qwen3.5-4B", apiKey: "not-needed", baseUrl: "http://localhost:8000/v1" }

// Anthropic
provider: { type: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: process.env.ANTHROPIC_API_KEY }

// OpenRouter
provider: { type: "openrouter", model: "anthropic/claude-sonnet-4-5", apiKey: process.env.OPENROUTER_API_KEY }
```

### Schema Portability

The same Zod tool definitions produce JSON Schema that one provider accepts and another rejects, so the generated schema is adapted per provider:

- **OpenAI** (and `openai/*` models on OpenRouter) forbids root-level unions and optional object properties, so it receives a single strict root object with optional params expressed as nullable.
- **Anthropic** (and `anthropic/*` on OpenRouter) rejects several numeric keywords (`minimum`, `maximum`, `multipleOf`, and the exclusive forms), so those are stripped.

This relaxation applies only to what the model is asked to generate. The action it returns is still validated against your original, unrelaxed Zod schema, and null placeholders for optional fields are removed before that check.

## Decider (TypeSafe Jev)

[Jev](https://typesafe.ai/) is a model that chooses but does not generate text. It answers typed questions (pick one of these options) in a single pass, with calibrated probabilities, in roughly 100–500ms. It can't write a string or a number, so it can't replace the LLM, but most of a next-action decision is a choice. Configure it beside the provider and it takes the parts it fits:

```typescript
const agent = createAgent({
  provider: { type: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: process.env.ANTHROPIC_API_KEY },
  decider: {
    type: "typesafe",
    apiKey: process.env.TYPESAFE_API_KEY,
    minConfidence: 0.6,                     // optional
    pricing: { input: 0.042, output: 0 },   // optional, per 1M tokens
  },
  // ...
});
```

On each `nextAction()`, one request asks Jev which valid tool comes next and, for every tool whose params are all closed-set, what each param should be. A tool is closed-set when its params are all enums, literals, unions of literals, booleans, nullable or optional versions of those, or empty. Then:

- **The chosen tool is closed-set.** The action is returned and the LLM is never called.
- **The chosen tool has free-form params** (strings, numbers, arrays, nested objects). The LLM is called with the schema narrowed to that one tool and fills the params.
- **Tool confidence is below `minConfidence`.** Jev's answer is discarded and the LLM makes the whole decision. If only a param answer is below it, the tool stands and the LLM fills the params.
- **Jev is unreachable, overloaded, or returns something outside the declared options.** The LLM makes the decision. A rejected request (bad key, invalid payload) throws a `ProviderError` instead of falling back.

Whatever Jev picks is validated against the tool's Zod schema like any LLM output, so refinements and defaults still apply. Jev receives the same things the LLM would: the output of `instructions(state)`, the history, and the tool descriptions. Param `.describe()` text becomes part of the question, so describe your enums.

Three things matter in practice, all observed running `scripts/bench-decider.ts` (51 scenarios with known answers) against the live API:

- **Set `minConfidence`.** Jev's confidence tracked correctness closely. Every answer it gave at 0.5 or above was right, and every miss came in under 0.35. A threshold between 0.5 and 0.7 sent those misses to the LLM at the cost of a handful of extra LLM calls.
- **Do the arithmetic in `instructions(state)`.** Jev is weak at sums, date differences and counting, and says so with low confidence. `instructions` is code: write "38 days overdue" rather than a due date and today's date, and "subtotal $104.97" rather than a list of line items.
- **Leave no param to chance.** Confidence comes from how decisively Jev picks, so a param that nothing in the instructions speaks to comes back near 50/50 and drags the whole action under the threshold. Say what every closed-set param should be, or give it a `.default()` so leaving it unset is an option.

`result.meta.decider` reports what happened:

```typescript
result.meta.decider?.decided;            // "action" | "tool" | "none"
result.meta.decider?.confidence;         // lowest confidence among the answers used
result.meta.decider?.toolProbabilities;  // { approve: 0.91, escalate: 0.09 }
result.meta.decider?.fallbackReason;     // "low-confidence" | "invalid-output" | "unavailable"
```

When the LLM is also called, `meta.tokensUsed` and `meta.model` describe the LLM call and Jev's usage is under `meta.decider`. `meta.cost` sums both.

## Cost Tracking

The library returns token counts in `meta.tokensUsed` (may be `{ input: 0, output: 0 }` if the provider doesn't report usage). For cost estimation, pass your own pricing:

```typescript
const agent = createAgent({
  // ...
  pricing: { input: 0.05, output: 0.4 },  // per 1M tokens
});

const result = await agent.nextAction();
result.meta.cost;  // number | undefined
```

## Timeouts and Cancellation

```typescript
// Per-call timeout
const result = await agent.nextAction({ timeout: 10000 });

// AbortSignal
const controller = new AbortController();
const result = await agent.nextAction({ signal: controller.signal });
```

## Output Retries

Constrained decoding is not perfect in practice — some models intermittently emit their native tool-call format or params that fail schema validation. When that happens, the model is re-asked with a correction message appended, up to `outputRetries` times (default 2) before an `OutputError` is thrown. DeepSeek's native DSML tool-call envelope is additionally recovered and parsed rather than counted as a failure.

```typescript
// Fail fast instead of re-asking
const result = await agent.nextAction({ outputRetries: 0 });
```

## Verbose Mode

For debugging, get the full assembled context:

```typescript
const result = await agent.nextAction({ verbose: true });
// result.context.messages — what was sent to the LLM
// result.context.outputSchema — the JSON schema constraining the output
// result.context.validTools — which tools were available
// result.context.deciderRequest — what was sent to the decider, if one is configured
```

## Errors

All errors are typed and actionable:

| Error | When |
|-------|------|
| `ValidationError` | State doesn't match schema, history format invalid |
| `BudgetExceededError` | A section exceeds its token budget |
| `NoValidToolsError` | No tool's `validWhen` returned true |
| `ProviderError` | Auth failure, rate limit, network error |
| `OutputError` | Model returned an unparseable or invalid action, and every retry was exhausted |
| `AbortError` | Call cancelled or timed out |

## OAuth

Built-in device code flows for subscription-based access (ChatGPT Plus, Claude Pro):

```typescript
import { getOAuthProvider, getOAuthApiKey } from "determinate";

// Trigger login flow
const provider = getOAuthProvider("openai"); // returns undefined if not registered
await provider?.login(callbacks);

// Later, credentials are used automatically
const agent = createAgent({
  provider: { type: "openai", model: "gpt-5-nano", oauth: true },
  // no apiKey needed — uses stored credentials
  // ...
});
```

## Requirements

- **Runtime:** Bun, or Node.js >= 22 (the openai SDK v7 floor)
- **TypeScript:** 5.x
- **Zod:** >= 4.0.0 (peer dependency)

## Philosophy

This library exists because we believe the conversation metaphor is the wrong abstraction for most agentic systems. An LLM making decisions in a dynamic environment is solving a classification problem with context, not having a conversation. The architecture should reflect that.

For the full argument: [Beyond the Sacred Conversation](beyond-the-sacred-conversation.md).
