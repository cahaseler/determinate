# next-action-agent

A TypeScript library that treats LLMs as next-action predictors instead of conversational partners.

## The Problem

Current agentic frameworks are built around a conversation metaphor: an append-only chat history, a static list of tools, and a loop that generates the next message given everything that came before. This works well for coding assistants where the environment is deterministic and stable, but falls apart in dynamic environments where:

- **State goes stale.** If you inject environment state each turn across a 50-turn interaction, you have 50 snapshots in context, 49 of which are wrong. The oldest, most incorrect snapshot has the strongest positional signal.
- **Context fills with noise.** Failed tool calls, redundant observations, and retry loops consume tokens without contributing to decisions. Half the conversation history in a typical agentic run is the agent's own mistakes.
- **Tools are over-injected.** For a system with 180 possible actions, all 180 schemas are injected every call, even when only 20 are relevant in the current state.
- **The model does housekeeping instead of reasoning.** The model spends capacity reconciling stale state, filtering irrelevant tools, and formatting output instead of making the actual decision.

For the full argument, see [Beyond the Sacred Conversation](beyond-the-sacred-conversation.md).

## The Approach

The unit of work is not a conversation turn. It is a **state-to-action decision**.

`next-action-agent` is a decision engine, not a framework. It does not own the loop, manage side effects, or implement tool handlers. You provide the situation; it returns an action.

Each call to `nextAction()`:

1. Filters tools to only those valid in the current state
2. Generates a constrained output schema — the model *cannot* choose an invalid action
3. Assembles an optimized context with explicit token budgets per section
4. Makes a single LLM call with structured output (constrained decoding)
5. Returns the chosen action with validated parameters

No conversation history accumulates inside the library. Context is an intentional budget, not a dumping ground.

## Quick Start

```bash
bun add next-action-agent
# zod is a peer dependency
bun add zod
```

```typescript
import { z } from "zod";
import { createAgent } from "next-action-agent";

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
    budgets: { instructions: 5000, state: 5000, history: 10000, tools: 3000 },
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

Define your environment state as a Zod schema. The library validates it, serializes it for the model, and passes it to your tool predicates and instruction function. You replace it entirely each turn via `setState()` — no stale snapshots accumulating.

### Tools with Conditional Validity

Each tool has a `validWhen` predicate evaluated against current state. Only valid tools are presented to the model, and the constrained output schema makes it physically impossible for the model to choose an invalid tool. This is least-privilege enforced structurally, not by hoping the model follows instructions.

### Token Budgets

You set explicit token budgets per section (instructions, state, history, tools). If any section exceeds its budget, the call is rejected with a `BudgetExceededError` — no silent truncation. This makes context overflow a build-time problem you fix once, not a runtime surprise.

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

## Verbose Mode

For debugging, get the full assembled context:

```typescript
const result = await agent.nextAction({ verbose: true });
// result.context.messages — what was sent to the LLM
// result.context.outputSchema — the JSON schema constraining the output
// result.context.validTools — which tools were available
```

## Errors

All errors are typed and actionable:

| Error | When |
|-------|------|
| `ValidationError` | State doesn't match schema, history format invalid |
| `BudgetExceededError` | A section exceeds its token budget |
| `NoValidToolsError` | No tool's `validWhen` returned true |
| `ProviderError` | Auth failure, rate limit, network error |
| `OutputError` | Model returned invalid action (shouldn't happen with constrained output) |
| `AbortError` | Call cancelled or timed out |

## OAuth

Built-in device code flows for subscription-based access (ChatGPT Plus, Claude Pro):

```typescript
import { getOAuthProvider, getOAuthApiKey } from "next-action-agent";

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

- **Runtime:** Bun (or Node.js with compatible APIs)
- **TypeScript:** 5.x
- **Zod:** >= 4.0.0 (peer dependency)

## Philosophy

This library exists because we believe the conversation metaphor is the wrong abstraction for most agentic systems. An LLM making decisions in a dynamic environment is solving a classification problem with context, not having a conversation. The architecture should reflect that.

For the full argument: [Beyond the Sacred Conversation](beyond-the-sacred-conversation.md).
