# Next Action Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript decision engine library that assembles optimized LLM context from state, tools, rules, and history, calls the LLM with constrained structured output, and returns a single action choice.

**Architecture:** Single Bun/TypeScript package. Core agent orchestrates state management, rule evaluation, context assembly, and token budgeting. Provider layer handles OpenAI SDK (direct for OpenAI/vLLM/OpenRouter) and a thin Anthropic adapter. OAuth extracted from pi-ai for subscription access. Zod schemas throughout for runtime validation and JSON Schema generation.

**Tech Stack:** Bun, TypeScript, Zod (peer dep), OpenAI SDK, tiktoken, zod-to-json-schema

---

## File Structure

```
src/
  index.ts                    — Public API: createAgent, types, errors
  agent.ts                    — Agent class: setState/getState, setHistory/getHistory, nextAction
  types.ts                    — All shared types: AgentConfig, ToolDefinition, HistoryEntry, ActionResult, etc.
  errors.ts                   — Typed error classes: ValidationError, BudgetExceededError, etc.

  schema/
    action-schema.ts          — Generates discriminated union JSON Schema from valid tools' Zod params
    history-schema.ts         — History entry Zod schema and validation

  context/
    assembler.ts              — Context assembly: builds the full LLM payload from state, tools, history, instructions
    budget.ts                 — Token budget enforcement per section
    tokenizer.ts              — Token counting abstraction: tiktoken for OpenAI-compatible, Anthropic API, char approximation

  providers/
    types.ts                  — Provider interface: sendRequest, countTokens
    openai.ts                 — OpenAI SDK wrapper (also used for vLLM, OpenRouter)
    anthropic.ts              — Anthropic Messages API adapter
    factory.ts                — Creates the right provider from config
    pricing.ts                — Built-in price table for cost estimation

  oauth/
    device-flow.ts            — Device code OAuth flow (extracted from pi-ai)
    token-store.ts            — Filesystem token storage and refresh
    anthropic-oauth.ts        — Anthropic-specific OAuth config
    openai-oauth.ts           — OpenAI-specific OAuth config

tests/
  agent.test.ts               — Agent creation, setState/getState, setHistory/getHistory
  schema/
    action-schema.test.ts     — JSON Schema generation from Zod tool definitions
    history-schema.test.ts    — History entry validation
  context/
    assembler.test.ts         — Context assembly, payload structure
    budget.test.ts            — Token budget enforcement
    tokenizer.test.ts         — Token counting accuracy
  providers/
    openai.test.ts            — OpenAI provider request/response translation
    anthropic.test.ts         — Anthropic adapter request/response translation
    factory.test.ts           — Provider factory selection
  integration/
    openai-e2e.test.ts        — End-to-end with real OpenAI API (optional, requires key)
    anthropic-e2e.test.ts     — End-to-end with real Anthropic API (optional, requires key)
```

---

## Research Tasks

These must be completed before implementation begins, as they resolve open questions that affect the design of core components.

### Research Task A: Discriminated Union Schema Portability

**Goal:** Find a JSON Schema structure for the action space output that works with OpenAI, Anthropic, and vLLM structured output.

- [ ] **Step 1: Read OpenAI structured output schema restrictions**

Check the OpenAI API docs for supported JSON Schema features. Specifically: does `anyOf` work in nested properties? Does `const` work for discriminant fields? Document the exact subset supported.

Ref: https://platform.openai.com/docs/guides/structured-outputs

- [ ] **Step 2: Read Anthropic structured output schema restrictions**

Check the Anthropic API docs for `output_config.format` JSON Schema support. What subset of JSON Schema is supported? Does `anyOf`/`oneOf` work? Does `const` work?

Ref: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

- [ ] **Step 3: Check vLLM structured output schema restrictions**

vLLM uses XGrammar by default for constrained decoding. Check what JSON Schema features XGrammar supports. It should be more permissive than the cloud providers since it's doing grammar-level constraint.

Ref: https://docs.vllm.ai/en/latest/features/structured_outputs/

- [ ] **Step 4: Design and document the portable schema structure**

Write a concrete example schema for 2-3 tools that works across all three providers. Test it mentally against each provider's restrictions. Document the structure in a research note.

- [ ] **Step 5: Validate with live API calls**

Write a minimal test script that sends a structured output request with the proposed schema to each available provider. Confirm it works or iterate.

### Research Task B: OAuth Extraction from pi-ai

**Goal:** Determine the feasibility and scope of extracting OAuth device code flows from pi-ai.

- [ ] **Step 1: Clone pi-mono and read the OAuth module**

```bash
cd /tmp && git clone https://github.com/badlogic/pi-mono.git
```

Read the OAuth entrypoint and identify: what files implement the device code flow, what dependencies they have on the rest of pi-ai, what external dependencies are required.

- [ ] **Step 2: Trace the Anthropic OAuth flow**

Follow the code path for Anthropic Claude Pro/Max login. Document: OAuth endpoints used, token format, refresh flow, storage format.

- [ ] **Step 3: Trace the OpenAI OAuth flow**

Same for OpenAI ChatGPT Plus/Pro (Codex) login.

- [ ] **Step 4: Assess extraction effort**

Document: how many files, how coupled to pi-ai internals, what can be extracted cleanly vs. what needs rewriting. Write up findings in a research note.

---

## Chunk 1: Project Scaffolding and Core Types

### Task 1: Initialize the Bun project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.gitignore`

- [ ] **Step 1: Initialize Bun project**

```bash
cd /home/cahaseler/projects/next-action-agent
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add openai
bun add -d zod @types/bun
```

Note: Zod is a peer dependency for consumers, but we need it as a dev dependency for our own tests and types. After installing, manually add `"peerDependencies": { "zod": "^3.0.0" }` to `package.json`.

- [ ] **Step 3: Configure tsconfig.json**

Set up strict TypeScript with ESM output:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.tgz
```

- [ ] **Step 5: Verify build works**

```bash
mkdir -p src && echo 'export const VERSION = "0.0.1"' > src/index.ts && bun build src/index.ts --outdir dist
```

Expected: builds without error.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore src/index.ts bun.lock
git commit -m "feat: initialize Bun project with TypeScript config"
```

### Task 2: Define core types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write type definitions**

Define all shared types. These are the contracts the rest of the codebase builds against:

```typescript
import { z } from "zod";

// ---- Agent Configuration ----

export interface ProviderConfig {
  type: "openai" | "anthropic" | "vllm" | "openrouter";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  oauth?: boolean; // trigger OAuth flow if no apiKey
  options?: Record<string, unknown>; // pass-through provider-specific options
}

export interface TokenBudgets {
  instructions: number;
  state: number;
  history: number;
  tools: number;
}

export interface ToolDefinition<TState> {
  name: string;
  description: string;
  params: z.ZodType;
  validWhen: (state: TState) => boolean;
  instructions?: string;
}

export interface AgentConfig<TState> {
  provider: ProviderConfig;
  state: z.ZodType<TState>;
  tools: ToolDefinition<TState>[];
  instructions: (state: TState) => string;
  context: {
    budgets: TokenBudgets;
  };
}

// ---- History ----

export interface HistoryEntry {
  tool: string;
  params: Record<string, unknown>;
  result: string;
  success?: boolean; // defaults to true
  timestamp?: string; // ISO 8601
}

// ---- Action Result ----

export interface Action {
  tool: string;
  params: Record<string, unknown>;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ActionMeta {
  tokensUsed: TokenUsage;
  cost?: number;
  model: string;
  latency: number;
}

export interface ActionResult {
  action: Action;
  meta: ActionMeta;
}

export interface VerboseActionResult extends ActionResult {
  context: AssembledContext;
}

export interface AssembledContext {
  messages: unknown[]; // provider-specific message format
  outputSchema: Record<string, unknown>; // the JSON schema sent for structured output
  validTools: string[]; // names of tools that passed validWhen
}

// ---- Next Action Options ----

export interface NextActionOptions {
  verbose?: boolean;
  signal?: AbortSignal;
  timeout?: number; // ms
}
```

- [ ] **Step 2: Verify it compiles**

```bash
bun build src/types.ts --outdir /dev/null
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: define core type definitions"
```

### Task 3: Define error classes

**Files:**
- Create: `src/errors.ts`
- Create: `tests/errors.test.ts`

- [ ] **Step 1: Write failing test for error types**

```typescript
import { describe, it, expect } from "bun:test";
import {
  ValidationError,
  BudgetExceededError,
  NoValidToolsError,
  ProviderError,
  OutputError,
  AbortError,
} from "../src/errors";

describe("errors", () => {
  it("ValidationError includes message and is instanceof Error", () => {
    const err = new ValidationError("state does not match schema");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("state does not match schema");
    expect(err.name).toBe("ValidationError");
  });

  it("BudgetExceededError includes section details", () => {
    const err = new BudgetExceededError("history", 5000, 2000);
    expect(err).toBeInstanceOf(Error);
    expect(err.section).toBe("history");
    expect(err.actual).toBe(5000);
    expect(err.budget).toBe(2000);
    expect(err.message).toContain("history");
    expect(err.message).toContain("5000");
    expect(err.message).toContain("2000");
  });

  it("NoValidToolsError is an Error", () => {
    const err = new NoValidToolsError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoValidToolsError");
  });

  it("ProviderError includes provider type", () => {
    const err = new ProviderError("anthropic", "rate limit exceeded");
    expect(err.provider).toBe("anthropic");
    expect(err.message).toContain("rate limit exceeded");
  });

  it("OutputError includes raw output", () => {
    const raw = '{"invalid": true}';
    const err = new OutputError("tool not in valid set", raw);
    expect(err.rawOutput).toBe(raw);
  });

  it("AbortError is an Error", () => {
    const err = new AbortError("timeout after 5000ms");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbortError");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/errors.test.ts
```

Expected: FAIL — cannot resolve `../src/errors`.

- [ ] **Step 3: Implement error classes**

```typescript
export class ValidationError extends Error {
  override name = "ValidationError" as const;
  constructor(message: string) {
    super(message);
  }
}

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError" as const;
  constructor(
    public readonly section: string,
    public readonly actual: number,
    public readonly budget: number
  ) {
    super(
      `Token budget exceeded for "${section}": ${actual} tokens used, budget is ${budget}`
    );
  }
}

export class NoValidToolsError extends Error {
  override name = "NoValidToolsError" as const;
  constructor() {
    super("No tools passed their validWhen predicate for the current state");
  }
}

export class ProviderError extends Error {
  override name = "ProviderError" as const;
  constructor(
    public readonly provider: string,
    message: string
  ) {
    super(`[${provider}] ${message}`);
  }
}

export class OutputError extends Error {
  override name = "OutputError" as const;
  constructor(
    message: string,
    public readonly rawOutput: string
  ) {
    super(message);
  }
}

export class AbortError extends Error {
  override name = "AbortError" as const;
  constructor(message: string = "Operation was aborted") {
    super(message);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/errors.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "feat: add typed error classes"
```

---

## Chunk 2: Schema Generation and History Validation

### Task 4: History entry validation

**Files:**
- Create: `src/schema/history-schema.ts`
- Create: `tests/schema/history-schema.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { historyEntrySchema, validateHistory } from "../../src/schema/history-schema";

describe("history validation", () => {
  it("accepts a valid history entry with all fields", () => {
    const entry = {
      tool: "approve_order",
      params: { note: "looks good" },
      result: "Order approved",
      success: true,
      timestamp: "2026-03-11T10:00:00Z",
    };
    expect(() => validateHistory([entry])).not.toThrow();
  });

  it("accepts entry with only required fields, defaults success to true", () => {
    const entry = {
      tool: "approve_order",
      params: { note: "ok" },
      result: "Done",
    };
    const validated = validateHistory([entry]);
    expect(validated[0].success).toBe(true);
  });

  it("accepts empty history array", () => {
    expect(() => validateHistory([])).not.toThrow();
  });

  it("rejects entry missing tool field", () => {
    const entry = { params: {}, result: "x" };
    expect(() => validateHistory([entry as any])).toThrow();
  });

  it("rejects entry with wrong type for result", () => {
    const entry = { tool: "x", params: {}, result: 42 };
    expect(() => validateHistory([entry as any])).toThrow();
  });

  it("rejects non-array input", () => {
    expect(() => validateHistory("not an array" as any)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/schema/history-schema.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement history schema**

```typescript
import { z } from "zod";
import { ValidationError } from "../errors";

export const historyEntrySchema = z.object({
  tool: z.string(),
  params: z.record(z.unknown()),
  result: z.string(),
  success: z.boolean().default(true),
  timestamp: z.string().optional(),
});

export type ValidatedHistoryEntry = z.output<typeof historyEntrySchema>;

const historyArraySchema = z.array(historyEntrySchema);

export function validateHistory(input: unknown): ValidatedHistoryEntry[] {
  const result = historyArraySchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `Invalid history format: ${result.error.issues.map((i) => i.message).join(", ")}`
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/schema/history-schema.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema/history-schema.ts tests/schema/history-schema.test.ts
git commit -m "feat: add history entry validation with Zod schema"
```

### Task 5: Action space JSON Schema generation

**Files:**
- Create: `src/schema/action-schema.ts`
- Create: `tests/schema/action-schema.test.ts`

This task depends on Research Task A being completed first. The exact schema structure may change based on findings.

- [ ] **Step 1: Install zod-to-json-schema**

```bash
bun add zod-to-json-schema
```

- [ ] **Step 2: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { generateActionSchema } from "../../src/schema/action-schema";

describe("action schema generation", () => {
  const tools = [
    {
      name: "approve_order",
      description: "Approve a pending order",
      params: z.object({ note: z.string() }),
    },
    {
      name: "reject_order",
      description: "Reject a pending order",
      params: z.object({ reason: z.string() }),
    },
  ];

  it("generates a valid JSON schema object", () => {
    const schema = generateActionSchema(tools);
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });

  it("includes tool as a property with enum of tool names", () => {
    const schema = generateActionSchema(tools);
    const toolProp = (schema.properties as any).tool;
    expect(toolProp.enum).toContain("approve_order");
    expect(toolProp.enum).toContain("reject_order");
    expect(toolProp.enum).toHaveLength(2);
  });

  it("includes params with anyOf branches for multiple tools", () => {
    const schema = generateActionSchema(tools);
    const params = (schema.properties as any).params;
    expect(params.anyOf).toBeDefined();
    expect(params.anyOf).toHaveLength(2);
  });

  it("each anyOf branch includes a tool_name const discriminant", () => {
    const schema = generateActionSchema(tools);
    const branches = (schema.properties as any).params.anyOf;
    const toolNames = branches.map((b: any) => b.properties.tool_name?.const);
    expect(toolNames).toContain("approve_order");
    expect(toolNames).toContain("reject_order");
  });

  it("sets additionalProperties to false", () => {
    const schema = generateActionSchema(tools);
    expect(schema.additionalProperties).toBe(false);
  });

  it("marks tool and params as required", () => {
    const schema = generateActionSchema(tools);
    expect(schema.required).toContain("tool");
    expect(schema.required).toContain("params");
  });

  it("handles single tool without anyOf wrapper", () => {
    const schema = generateActionSchema([tools[0]]);
    const toolProp = (schema.properties as any).tool;
    expect(toolProp.enum).toEqual(["approve_order"]);
    // Single tool: params is the schema directly, no anyOf
    const params = (schema.properties as any).params;
    expect(params.anyOf).toBeUndefined();
    expect(params.properties).toBeDefined();
  });

  it("throws on empty tools array", () => {
    expect(() => generateActionSchema([])).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/schema/action-schema.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement action schema generation**

Note: The exact schema structure here is a starting point. Research Task A may require adjustments to the `anyOf`/discriminant approach. This implementation uses the pattern described in the spec — `anyOf` at the params level with `const` discriminants tied to tool names via a `tool_name` field in each params branch. If testing reveals provider incompatibilities, this file is where the fix lands.

```typescript
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

interface ToolForSchema {
  name: string;
  description: string;
  params: z.ZodType;
}

export function generateActionSchema(
  tools: ToolForSchema[]
): Record<string, unknown> {
  if (tools.length === 0) {
    throw new Error("Cannot generate action schema with zero tools");
  }

  const toolNames = tools.map((t) => t.name);

  // Generate JSON Schema for each tool's params, adding a tool_name discriminant
  const paramBranches = tools.map((tool) => {
    const baseSchema = zodToJsonSchema(tool.params, {
      $refStrategy: "none",
    }) as Record<string, any>;

    // Add tool_name as a const discriminant to each branch
    return {
      type: "object",
      properties: {
        tool_name: { type: "string", const: tool.name },
        ...(baseSchema.properties ?? {}),
      },
      required: ["tool_name", ...(baseSchema.required ?? [])],
      additionalProperties: false,
    };
  });

  // Build the params property: anyOf the param schemas
  // For single tool, just use the schema directly (no anyOf wrapper)
  const paramsProperty =
    paramBranches.length === 1
      ? paramBranches[0]
      : { anyOf: paramBranches };

  return {
    type: "object",
    properties: {
      tool: {
        type: "string",
        enum: toolNames,
      },
      params: paramsProperty,
    },
    required: ["tool", "params"],
    additionalProperties: false,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/schema/action-schema.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema/action-schema.ts tests/schema/action-schema.test.ts package.json bun.lock
git commit -m "feat: add action space JSON Schema generation from Zod tool definitions"
```

---

## Chunk 3: Token Counting and Budget Enforcement

### Task 6: Token counting abstraction

**Files:**
- Create: `src/context/tokenizer.ts`
- Create: `tests/context/tokenizer.test.ts`

- [ ] **Step 1: Install tiktoken**

```bash
bun add tiktoken
```

- [ ] **Step 2: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { createTokenizer } from "../../src/context/tokenizer";

describe("tokenizer", () => {
  it("counts tokens for a simple string using tiktoken", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const count = tokenizer.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
    expect(typeof count).toBe("number");
  });

  it("returns consistent counts for the same input", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const a = tokenizer.count("test string");
    const b = tokenizer.count("test string");
    expect(a).toBe(b);
  });

  it("longer strings produce higher counts", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const short = tokenizer.count("hi");
    const long = tokenizer.count("This is a much longer string with many more tokens");
    expect(long).toBeGreaterThan(short);
  });

  it("counts tokens for objects by serializing to JSON", () => {
    const tokenizer = createTokenizer("openai", "gpt-4o");
    const count = tokenizer.count({ key: "value", nested: { a: 1 } });
    expect(count).toBeGreaterThan(0);
  });

  it("uses character approximation for unknown providers", () => {
    const tokenizer = createTokenizer("vllm" as any, "unknown-model");
    const count = tokenizer.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/context/tokenizer.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement tokenizer**

```typescript
import { encoding_for_model, get_encoding, type TiktokenModel } from "tiktoken";

export interface Tokenizer {
  count(input: string | Record<string, unknown>): number;
}

function serialize(input: string | Record<string, unknown>): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

class TiktokenTokenizer implements Tokenizer {
  private encoder;

  constructor(model: string) {
    try {
      this.encoder = encoding_for_model(model as TiktokenModel);
    } catch {
      // Fall back to cl100k_base for unknown OpenAI-compatible models
      this.encoder = get_encoding("cl100k_base");
    }
  }

  count(input: string | Record<string, unknown>): number {
    return this.encoder.encode(serialize(input)).length;
  }
}

class CharApproximationTokenizer implements Tokenizer {
  // Conservative: ~3.5 chars per token on average for English text
  // Using 3 to overestimate token count (safer for budget enforcement)
  private readonly charsPerToken = 3;

  count(input: string | Record<string, unknown>): number {
    return Math.ceil(serialize(input).length / this.charsPerToken);
  }
}

export function createTokenizer(
  providerType: string,
  model: string
): Tokenizer {
  if (providerType === "openai" || providerType === "openrouter") {
    return new TiktokenTokenizer(model);
  }
  // vLLM and unknown providers get character approximation
  // Anthropic will be handled separately via their API
  return new CharApproximationTokenizer();
}
```

Note: Anthropic token counting via their API will be added in the Anthropic provider task. The tokenizer abstraction supports it — the Anthropic provider will implement its own `count` method that calls their API.

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/context/tokenizer.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/context/tokenizer.ts tests/context/tokenizer.test.ts package.json bun.lock
git commit -m "feat: add token counting with tiktoken and character approximation"
```

### Task 7: Token budget enforcement

**Files:**
- Create: `src/context/budget.ts`
- Create: `tests/context/budget.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { enforceBudgets } from "../../src/context/budget";
import type { Tokenizer } from "../../src/context/tokenizer";
import type { TokenBudgets } from "../../src/types";
import { BudgetExceededError } from "../../src/errors";

// Simple mock tokenizer: 1 character = 1 token
const mockTokenizer: Tokenizer = {
  count: (input) => {
    const str = typeof input === "string" ? input : JSON.stringify(input);
    return str.length;
  },
};

describe("budget enforcement", () => {
  const budgets: TokenBudgets = {
    instructions: 100,
    state: 50,
    history: 30,
    tools: 40,
  };

  it("passes when all sections are within budget", () => {
    const sections = {
      instructions: "a".repeat(50),
      state: "b".repeat(30),
      history: "c".repeat(20),
      tools: "d".repeat(25),
    };
    expect(() => enforceBudgets(sections, budgets, mockTokenizer)).not.toThrow();
  });

  it("throws BudgetExceededError when instructions exceed budget", () => {
    const sections = {
      instructions: "a".repeat(150),
      state: "b".repeat(10),
      history: "c".repeat(10),
      tools: "d".repeat(10),
    };
    try {
      enforceBudgets(sections, budgets, mockTokenizer);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).section).toBe("instructions");
      expect((err as BudgetExceededError).actual).toBe(150);
      expect((err as BudgetExceededError).budget).toBe(100);
    }
  });

  it("throws for the first section that exceeds budget", () => {
    const sections = {
      instructions: "a".repeat(200),
      state: "b".repeat(200),
      history: "c".repeat(10),
      tools: "d".repeat(10),
    };
    try {
      enforceBudgets(sections, budgets, mockTokenizer);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      // First section checked that exceeds
      expect((err as BudgetExceededError).section).toBeDefined();
    }
  });

  it("returns token counts for all sections", () => {
    const sections = {
      instructions: "a".repeat(50),
      state: "b".repeat(30),
      history: "c".repeat(20),
      tools: "d".repeat(25),
    };
    const counts = enforceBudgets(sections, budgets, mockTokenizer);
    expect(counts.instructions).toBe(50);
    expect(counts.state).toBe(30);
    expect(counts.history).toBe(20);
    expect(counts.tools).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/context/budget.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement budget enforcement**

```typescript
import type { Tokenizer } from "./tokenizer";
import type { TokenBudgets } from "../types";
import { BudgetExceededError } from "../errors";

export interface SectionContents {
  instructions: string;
  state: string;
  history: string;
  tools: string;
}

export function enforceBudgets(
  sections: SectionContents,
  budgets: TokenBudgets,
  tokenizer: Tokenizer
): Record<keyof TokenBudgets, number> {
  const counts: Record<string, number> = {};

  for (const key of ["instructions", "state", "history", "tools"] as const) {
    const count = tokenizer.count(sections[key]);
    counts[key] = count;
    if (count > budgets[key]) {
      throw new BudgetExceededError(key, count, budgets[key]);
    }
  }

  return counts as Record<keyof TokenBudgets, number>;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/context/budget.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/budget.ts tests/context/budget.test.ts
git commit -m "feat: add token budget enforcement per section"
```

---

## Chunk 4: Provider Layer

### Task 8: Provider interface and factory

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/factory.ts`
- Create: `tests/providers/factory.test.ts`

- [ ] **Step 1: Write the provider interface**

```typescript
import type { Action, ActionMeta } from "../types";

export interface ProviderRequest {
  messages: unknown[];
  outputSchema: Record<string, unknown>;
  model: string;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  action: Action;
  meta: {
    tokensUsed: { input: number; output: number };
    model: string;
  };
}

export interface Provider {
  sendRequest(request: ProviderRequest): Promise<ProviderResponse>;
}
```

- [ ] **Step 2: Write failing test for factory**

```typescript
import { describe, it, expect } from "bun:test";
import { createProvider } from "../../src/providers/factory";

describe("provider factory", () => {
  it("throws for unknown provider type", () => {
    expect(() =>
      createProvider({ type: "unknown" as any, model: "x" })
    ).toThrow();
  });

  it("creates an openai provider", () => {
    const provider = createProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
    });
    expect(provider).toBeDefined();
  });

  it("creates an anthropic provider", () => {
    const provider = createProvider({
      type: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      apiKey: "test-key",
    });
    expect(provider).toBeDefined();
  });

  it("creates a vllm provider with baseUrl", () => {
    const provider = createProvider({
      type: "vllm",
      model: "local-model",
      baseUrl: "http://localhost:8000/v1",
    });
    expect(provider).toBeDefined();
  });

  it("creates an openrouter provider", () => {
    const provider = createProvider({
      type: "openrouter",
      model: "anthropic/claude-sonnet-4-5-20250514",
      apiKey: "test-key",
    });
    expect(provider).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/providers/factory.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement factory (stubs for providers)**

```typescript
import type { ProviderConfig } from "../types";
import type { Provider } from "./types";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";

export function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "openai":
      return new OpenAIProvider(config);
    case "vllm":
      return new OpenAIProvider({
        ...config,
        baseUrl: config.baseUrl ?? "http://localhost:8000/v1",
      });
    case "openrouter":
      return new OpenAIProvider({
        ...config,
        baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
      });
    case "anthropic":
      return new AnthropicProvider(config);
    default:
      throw new Error(`Unknown provider type: ${(config as any).type}`);
  }
}
```

The OpenAI and Anthropic providers will be implemented in the next two tasks. For now, create minimal stubs so the factory compiles:

`src/providers/openai.ts` stub:
```typescript
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

export class OpenAIProvider implements Provider {
  constructor(private config: ProviderConfig) {}
  async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }
}
```

`src/providers/anthropic.ts` stub:
```typescript
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

export class AnthropicProvider implements Provider {
  constructor(private config: ProviderConfig) {}
  async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/providers/factory.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/providers/factory.ts src/providers/openai.ts src/providers/anthropic.ts tests/providers/factory.test.ts
git commit -m "feat: add provider interface and factory"
```

### Task 9: OpenAI provider

**Files:**
- Create: `src/providers/openai.ts`
- Create: `tests/providers/openai.test.ts`

- [ ] **Step 1: Write failing test**

Tests use a mock HTTP server to verify request translation without calling the real API.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OpenAIProvider } from "../../src/providers/openai";

describe("OpenAI provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        // Echo back the request body so tests can inspect it
        return req.json().then((body) =>
          Response.json({
            id: "test-id",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    tool: "approve_order",
                    params: { note: "ok" },
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
            // Stash the request for assertion
            _request: body,
          })
        );
      },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    server.stop();
  });

  it("sends a structured output request with response_format", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: {
        type: "object",
        properties: { tool: { type: "string" }, params: { type: "object" } },
        required: ["tool", "params"],
        additionalProperties: false,
      },
      model: "gpt-4o",
    });

    expect(result.action.tool).toBe("approve_order");
    expect(result.action.params).toEqual({ note: "ok" });
    expect(result.meta.tokensUsed.input).toBe(100);
    expect(result.meta.tokensUsed.output).toBe(20);
    expect(result.meta.model).toBe("gpt-4o");
  });

  it("passes through provider options", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
      options: { temperature: 0.5 },
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "gpt-4o",
      options: { temperature: 0.5 },
    });

    expect(result).toBeDefined();
  });

  it("parses the action from response content", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "gpt-4o",
    });

    expect(result.action).toHaveProperty("tool");
    expect(result.action).toHaveProperty("params");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/providers/openai.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement OpenAI provider**

```typescript
import OpenAI from "openai";
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";
import { ProviderError, OutputError } from "../errors";

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? "",
      baseURL: config.baseUrl,
    });
  }

  async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages as OpenAI.ChatCompletionMessageParam[],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "action",
              strict: true,
              schema: request.outputSchema,
            },
          },
          ...request.options,
        },
        {
          signal: request.signal,
        }
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new OutputError("No content in response", "");
      }

      let action: { tool: string; params: Record<string, unknown> };
      try {
        action = JSON.parse(content);
      } catch {
        throw new OutputError("Failed to parse response as JSON", content);
      }

      return {
        action: {
          tool: action.tool,
          params: action.params,
        },
        meta: {
          tokensUsed: {
            input: response.usage?.prompt_tokens ?? 0,
            output: response.usage?.completion_tokens ?? 0,
          },
          model: response.model,
        },
      };
    } catch (err) {
      if (err instanceof OutputError) throw err;
      if (err instanceof OpenAI.APIError) {
        throw new ProviderError(this.config.type, err.message);
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/providers/openai.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai.ts tests/providers/openai.test.ts
git commit -m "feat: add OpenAI provider with structured output"
```

### Task 10: Anthropic provider adapter

**Files:**
- Create: `src/providers/anthropic.ts`
- Create: `tests/providers/anthropic.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AnthropicProvider } from "../../src/providers/anthropic";

describe("Anthropic provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return req.json().then((body: any) => {
          // Verify Anthropic-specific fields are present
          const hasOutputConfig = body.output_config?.format?.type === "json_schema";

          return Response.json({
            id: "msg-test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5-20250514",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tool: "approve_order",
                  params: { note: "approved" },
                }),
              },
            ],
            usage: {
              input_tokens: 150,
              output_tokens: 30,
            },
            _had_output_config: hasOutputConfig,
            _request: body,
          });
        });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop();
  });

  it("translates request to Anthropic Messages API format", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "test" },
      ],
      outputSchema: {
        type: "object",
        properties: { tool: { type: "string" }, params: { type: "object" } },
        required: ["tool", "params"],
        additionalProperties: false,
      },
      model: "claude-sonnet-4-5-20250514",
    });

    expect(result.action.tool).toBe("approve_order");
    expect(result.action.params).toEqual({ note: "approved" });
  });

  it("maps token usage from Anthropic format", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "claude-sonnet-4-5-20250514",
    });

    expect(result.meta.tokensUsed.input).toBe(150);
    expect(result.meta.tokensUsed.output).toBe(30);
    expect(result.meta.model).toBe("claude-sonnet-4-5-20250514");
  });

  it("extracts system message from messages array", async () => {
    const provider = new AnthropicProvider({
      type: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      apiKey: "test-key",
      baseUrl,
    });

    // This should not throw — the provider should handle
    // extracting the system message from the messages array
    const result = await provider.sendRequest({
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "claude-sonnet-4-5-20250514",
    });

    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/providers/anthropic.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement Anthropic provider**

```typescript
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";
import { ProviderError, OutputError } from "../errors";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
// Note: This version must support output_config.format. Confirm the correct
// version string during Research Task A. Update if needed.
const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_STATUS_CODES = [429, 500, 502, 503, 529];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export class AnthropicProvider implements Provider {
  private config: ProviderConfig;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? ANTHROPIC_API_BASE;
  }

  async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
    // Extract system message from messages array
    const messages = request.messages as Array<{ role: string; content: string }>;
    let system: string | undefined;
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = msg.content;
      } else {
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: anthropicMessages,
      max_tokens: 4096,
      output_config: {
        format: {
          type: "json_schema",
          schema: request.outputSchema,
        },
      },
      ...request.options,
    };

    if (system) {
      body.system = system;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          // Retry on transient errors
          if (RETRY_STATUS_CODES.includes(response.status) && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            await sleep(delay);
            lastError = new ProviderError("anthropic", `HTTP ${response.status}: ${errorBody}`);
            continue;
          }
          throw new ProviderError(
            "anthropic",
            `HTTP ${response.status}: ${errorBody}`
          );
        }

        const data = await response.json() as any;

        // Extract text content from Anthropic response
        const textBlock = data.content?.find((b: any) => b.type === "text");
        if (!textBlock?.text) {
          throw new OutputError("No text content in Anthropic response", JSON.stringify(data.content));
        }

        let action: { tool: string; params: Record<string, unknown> };
        try {
          action = JSON.parse(textBlock.text);
        } catch {
          throw new OutputError("Failed to parse Anthropic response as JSON", textBlock.text);
        }

        return {
          action: {
            tool: action.tool,
            params: action.params,
          },
          meta: {
            tokensUsed: {
              input: data.usage?.input_tokens ?? 0,
              output: data.usage?.output_tokens ?? 0,
            },
            model: data.model ?? request.model,
          },
        };
      } catch (err) {
        if (err instanceof ProviderError || err instanceof OutputError) throw err;
        throw new ProviderError("anthropic", (err as Error).message);
      }
    }

    throw lastError ?? new ProviderError("anthropic", "Max retries exceeded");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/providers/anthropic.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic.ts tests/providers/anthropic.test.ts
git commit -m "feat: add Anthropic provider adapter"
```

### Task 11: Pricing table for cost estimation

**Files:**
- Create: `src/providers/pricing.ts`
- Create: `tests/providers/pricing.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { estimateCost } from "../../src/providers/pricing";

describe("cost estimation", () => {
  it("estimates cost for a known OpenAI model", () => {
    const cost = estimateCost("gpt-4o", { input: 1000, output: 500 });
    expect(cost).toBeDefined();
    expect(cost).toBeGreaterThan(0);
  });

  it("estimates cost for a known Anthropic model", () => {
    const cost = estimateCost("claude-sonnet-4-5-20250514", {
      input: 1000,
      output: 500,
    });
    expect(cost).toBeDefined();
    expect(cost).toBeGreaterThan(0);
  });

  it("returns undefined for unknown models", () => {
    const cost = estimateCost("unknown-model-xyz", { input: 1000, output: 500 });
    expect(cost).toBeUndefined();
  });

  it("returns undefined for local models", () => {
    const cost = estimateCost("my-local-llama", { input: 1000, output: 500 });
    expect(cost).toBeUndefined();
  });

  it("scales linearly with token count", () => {
    const cost1 = estimateCost("gpt-4o", { input: 1000, output: 0 });
    const cost2 = estimateCost("gpt-4o", { input: 2000, output: 0 });
    expect(cost2).toBe(cost1! * 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/providers/pricing.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement pricing**

```typescript
import type { TokenUsage } from "../types";

// Prices in USD per 1M tokens
interface ModelPricing {
  input: number;
  output: number;
}

const PRICING: Record<string, ModelPricing> = {
  // OpenAI - GPT-5 series (update as pricing is published)
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Anthropic
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function estimateCost(
  model: string,
  usage: TokenUsage
): number | undefined {
  const pricing = PRICING[model];
  if (!pricing) return undefined;

  const inputCost = (usage.input / 1_000_000) * pricing.input;
  const outputCost = (usage.output / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/providers/pricing.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/pricing.ts tests/providers/pricing.test.ts
git commit -m "feat: add model pricing table for cost estimation"
```

---

## Chunk 5: Context Assembly

### Task 12: Context assembler

**Files:**
- Create: `src/context/assembler.ts`
- Create: `tests/context/assembler.test.ts`

This is the core of the library. It takes state, tools, history, and instructions, and builds the complete LLM payload.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { assembleContext } from "../../src/context/assembler";
import type { ToolDefinition, HistoryEntry, TokenBudgets } from "../../src/types";
import type { Tokenizer } from "../../src/context/tokenizer";
import { NoValidToolsError, BudgetExceededError } from "../../src/errors";

// Mock tokenizer: 1 char = 1 token
const mockTokenizer: Tokenizer = {
  count: (input) => {
    const str = typeof input === "string" ? input : JSON.stringify(input);
    return str.length;
  },
};

const stateSchema = z.object({
  status: z.enum(["pending", "approved"]),
  score: z.number(),
});

type TestState = z.infer<typeof stateSchema>;

const tools: ToolDefinition<TestState>[] = [
  {
    name: "approve",
    description: "Approve the item",
    params: z.object({ note: z.string() }),
    validWhen: (s) => s.status === "pending" && s.score < 0.7,
  },
  {
    name: "reject",
    description: "Reject the item",
    params: z.object({ reason: z.string() }),
    validWhen: (s) => s.status === "pending" && s.score >= 0.7,
  },
  {
    name: "ship",
    description: "Ship the item",
    params: z.object({ carrier: z.string() }),
    validWhen: (s) => s.status === "approved",
  },
];

const bigBudgets: TokenBudgets = {
  instructions: 10000,
  state: 10000,
  history: 10000,
  tools: 10000,
};

describe("context assembler", () => {
  it("filters tools by validWhen and returns valid tool names", () => {
    const result = assembleContext({
      state: { status: "pending", score: 0.3 },
      tools,
      history: [],
      instructions: () => "Do your job",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    expect(result.validTools).toEqual(["approve"]);
  });

  it("includes instructions in system message", () => {
    const result = assembleContext({
      state: { status: "pending", score: 0.3 },
      tools,
      history: [],
      instructions: (s) => `Process item with score ${s.score}`,
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    const systemMsg = result.messages.find(
      (m: any) => m.role === "system"
    ) as any;
    expect(systemMsg.content).toContain("0.3");
  });

  it("includes state in user message", () => {
    const result = assembleContext({
      state: { status: "pending", score: 0.3 },
      tools,
      history: [],
      instructions: () => "x",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    const userMsg = result.messages.find(
      (m: any) => m.role === "user"
    ) as any;
    expect(userMsg.content).toContain("pending");
    expect(userMsg.content).toContain("0.3");
  });

  it("throws NoValidToolsError when no tools match", () => {
    expect(() =>
      assembleContext({
        state: { status: "approved", score: 0.3 },
        tools: [tools[0], tools[1]], // both require pending
        history: [],
        instructions: () => "x",
        budgets: bigBudgets,
        tokenizer: mockTokenizer,
        providerType: "openai",
      })
    ).toThrow(NoValidToolsError);
  });

  it("formats history as tool-calling messages for openai", () => {
    const history: HistoryEntry[] = [
      {
        tool: "approve",
        params: { note: "ok" },
        result: "Approved",
        success: true,
      },
    ];

    const result = assembleContext({
      state: { status: "approved", score: 0.3 },
      tools,
      history,
      instructions: () => "x",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    // Should have assistant tool_call + tool result messages
    const assistantMsg = result.messages.find(
      (m: any) => m.role === "assistant" && m.tool_calls
    );
    const toolMsg = result.messages.find((m: any) => m.role === "tool");
    expect(assistantMsg).toBeDefined();
    expect(toolMsg).toBeDefined();
  });

  it("formats history as tool-calling messages for anthropic", () => {
    const history: HistoryEntry[] = [
      {
        tool: "approve",
        params: { note: "ok" },
        result: "Approved",
        success: true,
      },
    ];

    const result = assembleContext({
      state: { status: "approved", score: 0.3 },
      tools,
      history,
      instructions: () => "x",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "anthropic",
    });

    // Should have assistant with tool_use content block + user with tool_result
    const assistantMsg = result.messages.find(
      (m: any) => m.role === "assistant" && Array.isArray(m.content)
    ) as any;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content[0].type).toBe("tool_use");

    const userResultMsg = result.messages.find(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result"
    );
    expect(userResultMsg).toBeDefined();
  });

  it("throws BudgetExceededError when a section is too large", () => {
    expect(() =>
      assembleContext({
        state: { status: "pending", score: 0.3 },
        tools,
        history: [],
        instructions: () => "x".repeat(100),
        budgets: { ...bigBudgets, instructions: 10 },
        tokenizer: mockTokenizer,
        providerType: "openai",
      })
    ).toThrow(BudgetExceededError);
  });

  it("generates an output schema from valid tools", () => {
    const result = assembleContext({
      state: { status: "pending", score: 0.3 },
      tools,
      history: [],
      instructions: () => "x",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    expect(result.outputSchema).toBeDefined();
    expect((result.outputSchema as any).properties?.tool).toBeDefined();
    expect((result.outputSchema as any).properties?.params).toBeDefined();
  });

  it("includes per-tool instructions for valid tools", () => {
    const toolsWithInstructions: ToolDefinition<TestState>[] = [
      {
        name: "approve",
        description: "Approve",
        params: z.object({ note: z.string() }),
        validWhen: (s) => s.status === "pending",
        instructions: "Only approve if compliant with policy X",
      },
    ];

    const result = assembleContext({
      state: { status: "pending", score: 0.3 },
      tools: toolsWithInstructions,
      history: [],
      instructions: () => "Base instructions",
      budgets: bigBudgets,
      tokenizer: mockTokenizer,
      providerType: "openai",
    });

    const systemMsg = result.messages.find(
      (m: any) => m.role === "system"
    ) as any;
    expect(systemMsg.content).toContain("policy X");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/context/assembler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement context assembler**

```typescript
import type { ToolDefinition, HistoryEntry, TokenBudgets } from "../types";
import type { Tokenizer } from "./tokenizer";
import { generateActionSchema } from "../schema/action-schema";
import { enforceBudgets } from "./budget";
import { NoValidToolsError } from "../errors";
import { randomUUID } from "crypto";

interface AssembleInput<TState> {
  state: TState;
  tools: ToolDefinition<TState>[];
  history: HistoryEntry[];
  instructions: (state: TState) => string;
  budgets: TokenBudgets;
  tokenizer: Tokenizer;
  providerType: string;
}

interface AssembledPayload {
  messages: unknown[];
  outputSchema: Record<string, unknown>;
  validTools: string[];
}

export function assembleContext<TState>(
  input: AssembleInput<TState>
): AssembledPayload {
  const { state, tools, history, instructions, budgets, tokenizer, providerType } = input;

  // 1. Filter tools by validWhen
  const validTools = tools.filter((t) => t.validWhen(state));
  if (validTools.length === 0) {
    throw new NoValidToolsError();
  }

  // 2. Generate output schema
  const outputSchema = generateActionSchema(validTools);

  // 3. Build instructions text
  const instructionsText = instructions(state);

  // Append per-tool instructions
  const toolInstructions = validTools
    .filter((t) => t.instructions)
    .map((t) => `[${t.name}]: ${t.instructions}`)
    .join("\n");

  const fullInstructions = toolInstructions
    ? `${instructionsText}\n\nTool-specific instructions:\n${toolInstructions}`
    : instructionsText;

  // 4. Build tool descriptions for context
  const toolDescriptions = validTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  // 5. Serialize state
  const stateText = JSON.stringify(state, null, 2);

  // 6. Build history messages first (needed for accurate budget counting)
  const historyMessages: unknown[] = [];
  for (const entry of history) {
    const callId = randomUUID();

    if (providerType === "anthropic") {
      // Anthropic format: assistant with tool_use content block
      historyMessages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: callId,
            name: entry.tool,
            input: entry.params,
          },
        ],
      });
      historyMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: callId,
            content: entry.result,
            is_error: entry.success === false,
          },
        ],
      });
    } else {
      // OpenAI format: assistant with tool_calls + tool message
      historyMessages.push({
        role: "assistant",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: entry.tool,
              arguments: JSON.stringify(entry.params),
            },
          },
        ],
      });
      historyMessages.push({
        role: "tool",
        tool_call_id: callId,
        content: entry.result,
      });
    }
  }

  // 7. Enforce budgets (count history on actual serialized messages)
  const historyText = historyMessages.length > 0
    ? JSON.stringify(historyMessages)
    : "";

  enforceBudgets(
    {
      instructions: fullInstructions,
      state: stateText,
      history: historyText,
      tools: toolDescriptions,
    },
    budgets,
    tokenizer
  );

  // 8. Build final messages array
  const messages: unknown[] = [];

  // System message: instructions + tool descriptions
  messages.push({
    role: "system",
    content: `${fullInstructions}\n\nAvailable actions:\n${toolDescriptions}\n\nRespond with a JSON object choosing one action and its parameters.`,
  });

  // Add history messages
  messages.push(...historyMessages);

  // User message: current state
  messages.push({
    role: "user",
    content: `Current state:\n${stateText}\n\nChoose the next action.`,
  });

  return {
    messages,
    outputSchema,
    validTools: validTools.map((t) => t.name),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/context/assembler.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/assembler.ts tests/context/assembler.test.ts
git commit -m "feat: add context assembler with tool filtering, history formatting, and budget enforcement"
```

---

## Chunk 6: Agent Class and Public API

### Task 13: Agent class

**Files:**
- Create: `src/agent.ts`
- Create: `tests/agent.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createAgent } from "../src/index";
import { ValidationError, NoValidToolsError, AbortError } from "../src/errors";

const stateSchema = z.object({
  status: z.enum(["pending", "approved"]),
  score: z.number(),
});

const baseConfig = {
  provider: {
    type: "openai" as const,
    model: "gpt-4o",
    apiKey: "test-key",
  },
  state: stateSchema,
  tools: [
    {
      name: "approve",
      description: "Approve",
      params: z.object({ note: z.string() }),
      validWhen: (s: z.infer<typeof stateSchema>) => s.status === "pending",
    },
  ],
  instructions: () => "Process the item",
  context: {
    budgets: {
      instructions: 5000,
      state: 5000,
      history: 5000,
      tools: 5000,
    },
  },
};

describe("agent", () => {
  it("creates an agent instance", () => {
    const agent = createAgent(baseConfig);
    expect(agent).toBeDefined();
  });

  it("setState validates against schema", () => {
    const agent = createAgent(baseConfig);
    expect(() =>
      agent.setState({ status: "pending", score: 0.5 })
    ).not.toThrow();
  });

  it("setState rejects invalid state", () => {
    const agent = createAgent(baseConfig);
    expect(() =>
      agent.setState({ status: "invalid", score: 0.5 } as any)
    ).toThrow(ValidationError);
  });

  it("getState returns the current state", () => {
    const agent = createAgent(baseConfig);
    agent.setState({ status: "pending", score: 0.5 });
    const state = agent.getState();
    expect(state).toEqual({ status: "pending", score: 0.5 });
  });

  it("getState throws if state not set", () => {
    const agent = createAgent(baseConfig);
    expect(() => agent.getState()).toThrow();
  });

  it("setHistory validates format", () => {
    const agent = createAgent(baseConfig);
    expect(() =>
      agent.setHistory([
        { tool: "approve", params: { note: "ok" }, result: "Done" },
      ])
    ).not.toThrow();
  });

  it("setHistory rejects invalid format", () => {
    const agent = createAgent(baseConfig);
    expect(() => agent.setHistory([{ bad: "data" }] as any)).toThrow(
      ValidationError
    );
  });

  it("getHistory returns current history", () => {
    const agent = createAgent(baseConfig);
    const history = [
      { tool: "approve", params: { note: "ok" }, result: "Done" },
    ];
    agent.setHistory(history);
    const result = agent.getHistory();
    expect(result[0].tool).toBe("approve");
    expect(result[0].success).toBe(true); // default applied
  });

  it("getHistory returns empty array if not set", () => {
    const agent = createAgent(baseConfig);
    expect(agent.getHistory()).toEqual([]);
  });

  it("nextAction throws if state not set", async () => {
    const agent = createAgent(baseConfig);
    await expect(agent.nextAction()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement agent class**

```typescript
import type { z } from "zod";
import type {
  AgentConfig,
  HistoryEntry,
  ActionResult,
  VerboseActionResult,
  NextActionOptions,
} from "./types";
import { validateHistory, type ValidatedHistoryEntry } from "./schema/history-schema";
import { assembleContext } from "./context/assembler";
import { createTokenizer, type Tokenizer } from "./context/tokenizer";
import { createProvider } from "./providers/factory";
import type { Provider } from "./providers/types";
import { estimateCost } from "./providers/pricing";
import { ValidationError, AbortError, OutputError } from "./errors";

export class Agent<TState> {
  private config: AgentConfig<TState>;
  private state: TState | undefined;
  private history: ValidatedHistoryEntry[] = [];
  private provider: Provider;
  private tokenizer: Tokenizer;

  constructor(config: AgentConfig<TState>) {
    this.config = config;
    this.provider = createProvider(config.provider);
    this.tokenizer = createTokenizer(config.provider.type, config.provider.model);
  }

  setState(state: TState): void {
    const result = this.config.state.safeParse(state);
    if (!result.success) {
      throw new ValidationError(
        `Invalid state: ${result.error.issues.map((i) => i.message).join(", ")}`
      );
    }
    this.state = result.data as TState;
  }

  getState(): TState {
    if (this.state === undefined) {
      throw new ValidationError("State has not been set");
    }
    return this.state;
  }

  setHistory(history: HistoryEntry[]): void {
    this.history = validateHistory(history);
  }

  getHistory(): ValidatedHistoryEntry[] {
    return this.history;
  }

  async nextAction(
    options?: NextActionOptions
  ): Promise<ActionResult | VerboseActionResult> {
    const state = this.getState();

    // Set up abort handling — combine user signal and timeout if both provided
    let signal: AbortSignal | undefined = options?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeout) {
      const timeoutSignal = AbortSignal.timeout(options.timeout);
      signal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    }

    try {
      // Assemble context
      const assembled = assembleContext({
        state,
        tools: this.config.tools,
        history: this.history,
        instructions: this.config.instructions,
        budgets: this.config.context.budgets,
        tokenizer: this.tokenizer,
        providerType: this.config.provider.type,
      });

      // Call provider
      const start = performance.now();
      const response = await this.provider.sendRequest({
        messages: assembled.messages,
        outputSchema: assembled.outputSchema,
        model: this.config.provider.model,
        options: this.config.provider.options,
        signal,
      });
      const latency = performance.now() - start;

      // Validate response against valid tools
      if (!assembled.validTools.includes(response.action.tool)) {
        throw new OutputError(
          `Model returned tool "${response.action.tool}" which is not in the valid set: [${assembled.validTools.join(", ")}]`,
          JSON.stringify(response.action)
        );
      }

      // Find the tool and validate params
      const toolDef = this.config.tools.find(
        (t) => t.name === response.action.tool
      );
      if (toolDef) {
        const paramsResult = toolDef.params.safeParse(response.action.params);
        if (!paramsResult.success) {
          throw new OutputError(
            `Params for tool "${response.action.tool}" failed validation: ${paramsResult.error.issues.map((i) => i.message).join(", ")}`,
            JSON.stringify(response.action)
          );
        }
        // Use parsed params (with defaults applied)
        response.action.params = paramsResult.data;
      }

      const cost = estimateCost(response.meta.model, response.meta.tokensUsed);

      const result: ActionResult = {
        action: response.action,
        meta: {
          tokensUsed: response.meta.tokensUsed,
          cost,
          model: response.meta.model,
          latency,
        },
      };

      if (options?.verbose) {
        return {
          ...result,
          context: {
            messages: assembled.messages,
            outputSchema: assembled.outputSchema,
            validTools: assembled.validTools,
          },
        } as VerboseActionResult;
      }

      return result;
    } catch (err) {
      // Check if abort was triggered (more reliable than checking error name)
      if (signal?.aborted) {
        throw new AbortError(
          options?.timeout
            ? `Timeout after ${options.timeout}ms`
            : "Operation was aborted"
        );
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/agent.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat: add Agent class with state management, history, and nextAction"
```

### Task 14: Public API and index exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the public API**

```typescript
import { Agent } from "./agent";
import type { AgentConfig } from "./types";

export function createAgent<TState>(config: AgentConfig<TState>): Agent<TState> {
  return new Agent(config);
}

// Re-export types
export type {
  AgentConfig,
  ProviderConfig,
  TokenBudgets,
  ToolDefinition,
  HistoryEntry,
  Action,
  ActionMeta,
  ActionResult,
  VerboseActionResult,
  AssembledContext,
  NextActionOptions,
  TokenUsage,
} from "./types";

// Re-export errors
export {
  ValidationError,
  BudgetExceededError,
  NoValidToolsError,
  ProviderError,
  OutputError,
  AbortError,
} from "./errors";

// Re-export Agent class for type use
export { Agent } from "./agent";
```

- [ ] **Step 2: Verify all tests pass**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 3: Verify the package builds**

```bash
bun build src/index.ts --outdir dist --target node
```

Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add public API with createAgent and exports"
```

---

## Chunk 7: Integration Tests

### Task 15: End-to-end test with mock server

**Files:**
- Create: `tests/integration/e2e.test.ts`

This test exercises the full flow: createAgent → setState → setHistory → nextAction, using a mock HTTP server instead of real API calls.

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { createAgent } from "../../src/index";

describe("end-to-end with mock server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return req.json().then(() =>
          Response.json({
            id: "test-id",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    tool: "approve_order",
                    params: { note: "Looks good, low risk" },
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 25,
              total_tokens: 225,
            },
          })
        );
      },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    server.stop();
  });

  it("completes a full decision turn", async () => {
    const stateSchema = z.object({
      order: z.object({
        status: z.enum(["pending", "approved", "shipped"]),
        riskScore: z.number(),
        items: z.array(z.object({ name: z.string(), qty: z.number() })),
      }),
    });

    const agent = createAgent({
      provider: {
        type: "openai",
        model: "gpt-4o",
        apiKey: "test-key",
        baseUrl,
      },
      state: stateSchema,
      tools: [
        {
          name: "approve_order",
          description: "Approve a pending order",
          params: z.object({ note: z.string() }),
          validWhen: (s) =>
            s.order.status === "pending" && s.order.riskScore < 0.7,
        },
        {
          name: "escalate_order",
          description: "Escalate for review",
          params: z.object({ reason: z.string() }),
          validWhen: (s) =>
            s.order.status === "pending" && s.order.riskScore >= 0.7,
        },
      ],
      instructions: (s) =>
        `You are an order processor. Risk score: ${s.order.riskScore}`,
      context: {
        budgets: {
          instructions: 5000,
          state: 5000,
          history: 5000,
          tools: 5000,
        },
      },
    });

    agent.setState({
      order: {
        status: "pending",
        riskScore: 0.3,
        items: [{ name: "Widget", qty: 2 }],
      },
    });

    agent.setHistory([
      {
        tool: "request_info",
        params: { field: "shipping_address" },
        result: "Customer provided address",
      },
    ]);

    const result = await agent.nextAction();

    expect(result.action.tool).toBe("approve_order");
    expect(result.action.params).toEqual({ note: "Looks good, low risk" });
    expect(result.meta.tokensUsed.input).toBe(200);
    expect(result.meta.tokensUsed.output).toBe(25);
    expect(result.meta.model).toBe("gpt-4o");
    expect(result.meta.latency).toBeGreaterThan(0);
    expect(result.meta.cost).toBeDefined();
  });

  it("returns verbose context when requested", async () => {
    const stateSchema = z.object({ status: z.string() });

    const agent = createAgent({
      provider: { type: "openai", model: "gpt-4o", apiKey: "test-key", baseUrl },
      state: stateSchema,
      tools: [
        {
          name: "approve_order",
          description: "Approve",
          params: z.object({ note: z.string() }),
          validWhen: () => true,
        },
      ],
      instructions: () => "test",
      context: {
        budgets: { instructions: 5000, state: 5000, history: 5000, tools: 5000 },
      },
    });

    agent.setState({ status: "pending" });

    const result = await agent.nextAction({ verbose: true });

    expect("context" in result).toBe(true);
    const verbose = result as any;
    expect(verbose.context.messages).toBeDefined();
    expect(verbose.context.outputSchema).toBeDefined();
    expect(verbose.context.validTools).toContain("approve_order");
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
bun test tests/integration/e2e.test.ts
```

Expected: all 2 tests PASS.

- [ ] **Step 3: Run all tests**

```bash
bun test
```

Expected: all tests across all files PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/e2e.test.ts
git commit -m "feat: add end-to-end integration test with mock server"
```

---

## Chunk 8: OAuth (Deferred)

### Task 16: Research and extract OAuth from pi-ai

This task depends on Research Task B being completed first. The implementation details will be determined by the research findings.

**Files:**
- Create: `src/oauth/device-flow.ts`
- Create: `src/oauth/token-store.ts`
- Create: `src/oauth/anthropic-oauth.ts`
- Create: `src/oauth/openai-oauth.ts`
- Create: `tests/oauth/device-flow.test.ts`
- Create: `tests/oauth/token-store.test.ts`

This task will be planned in detail after Research Task B is complete. The high-level steps:

- [ ] **Step 1: Extract device code flow logic from pi-ai**
- [ ] **Step 2: Implement filesystem token storage**
- [ ] **Step 3: Implement Anthropic OAuth configuration**
- [ ] **Step 4: Implement OpenAI OAuth configuration**
- [ ] **Step 5: Wire OAuth into provider factory (auto-trigger when `oauth: true` and no apiKey)**
- [ ] **Step 6: Add tests for token storage and refresh**
- [ ] **Step 7: Test OAuth flows manually against real endpoints**
- [ ] **Step 8: Commit**

---

## Task Dependencies

```
Research A (schema portability) ──→ Task 5 (action schema)
Research B (OAuth extraction)  ──→ Task 16 (OAuth)
Task 1 (scaffolding)          ──→ all other tasks
Task 2 (types)                ──→ Tasks 3-14
Task 3 (errors)               ──→ Tasks 4-14
Task 4 (history schema)       ──→ Task 12 (assembler)
Task 5 (action schema)        ──→ Task 12 (assembler)
Task 6 (tokenizer)            ──→ Task 7 (budget)
Task 7 (budget)               ──→ Task 12 (assembler)
Task 8 (provider factory)     ──→ Task 13 (agent)
Task 9 (OpenAI provider)      ──→ Task 13 (agent)
Task 10 (Anthropic provider)  ──→ Task 13 (agent)
Task 11 (pricing)             ──→ Task 13 (agent)
Task 12 (assembler)           ──→ Task 13 (agent)
Task 13 (agent)               ──→ Task 14 (public API)
Task 14 (public API)          ──→ Task 15 (integration tests)
Task 15 (integration tests)   ──→ Task 16 (OAuth)
```

Tasks that can run in parallel (once their dependencies are met):
- Tasks 4 + 5 + 6 + 11 (after Task 3)
- Tasks 9 + 10 (after Task 8)
