# Beyond the Sacred Conversation

## Rethinking Agentic Architecture for Dynamic Environments

---

## Background

The dominant paradigm for building AI agent systems today was forged in software development. Agentic coding assistants demonstrated remarkable effectiveness by placing a large language model inside a simple loop: read code, decide what to do, call tools, observe results, repeat. This pattern works extraordinarily well for programming because the environment has a set of properties that make it almost uniquely forgiving:

**The state is deterministic and stable.** A file doesn't change while you're working on it. The codebase waits for you. Your observations are ground truth at the moment you make them, and they remain true until you act on them.

**Feedback is crisp.** Tests pass or fail. Code compiles or doesn't. Errors come with stack traces. There is very little ambiguity in whether an action succeeded.

**The action space is well-structured.** Read a file, write a file, run a command. The set of things an agent can do is broad but well-defined, and the consequences of each action are largely predictable.

**Retries are safe.** If something fails, you can usually try the same action again and expect the same preconditions to hold.

The success of this model has led to its wholesale adoption as the default architecture for agentic systems across every domain. Frameworks, APIs, model training patterns, and developer tooling are all built around the same core structure: an append-only conversation history, a static list of tools, and a loop that generates the next assistant message given the full history.

The problem is that most real-world domains where agents need to operate share almost none of the properties that make this architecture work for code.

---

## The Problem

### The Sacred Conversation

The entire stack — from model training, to API design, to framework architecture — treats the conversation history as an append-only log that represents ground truth. This assumption is embedded deeply. The attention mechanism operates over the ever-growing token sequence, and positional encoding patterns give disproportionate weight to earlier tokens. Your system prompt and first few exchanges are literally more influential than your most recent state update.

This means the architecture has the relationship between freshness and importance exactly backwards for any dynamic environment.

### Conflation of Concerns

The conversation log conflates at least three things that should be separate:

**Task specification** — what am I trying to accomplish, what are my constraints, what are my instructions. This is relatively static and deserves high weight.

**Current world state** — what does the environment look like right now. This should be a single, current snapshot that gets replaced wholesale each turn, not appended.

**Action history** — what have I done so far, what worked, what failed. This is useful but should be summarized and compressed, not preserved verbatim with every failed tool call intact.

In the current paradigm, all three are mashed into one linear token sequence and treated identically by the model. There is no mechanism to say "this block is the current state, always prefer it over any earlier version" or "this block of failed tool calls is historical context that should be heavily discounted." You can write instructions telling the model to do this, but you're spending the model's reasoning capacity compensating for an architectural limitation rather than solving the actual problem.

### The 800 Copies Problem

In a dynamic environment, the agent needs fresh state almost every turn. If you inject environment state each turn across a 50-turn interaction, you have 50 snapshots in context, 49 of which are wrong. The model must determine which one is current every time it reasons. The oldest, most incorrect snapshot has the strongest positional signal.

The alternative — telling the agent to use tools to discover its own state — is equally wasteful. The agent spends half of every turn burning tool calls and thousands of tokens reconstructing a picture of the world that the orchestration layer already knows or could easily know. The context window fills up with search results, file reads, and API responses that served only to rebuild context that should have been handed to the model directly.

### Stale Context and Wasted Tokens

Even in the programming domain, these problems are visible. When an agent edits a file three times, the context contains four versions — the original read plus three edits. The model implicitly learns "ignore the first three, the last one is real," but it's spending capacity on that reconciliation instead of the actual task, and every stale version costs tokens on every subsequent turn.

Failed tool calls are pure noise. Retry loops leave behind a trail of errors that serve no purpose but consume context. Half the conversation history in a typical agentic run is the agent's own mistakes and redundant observations.

### The Static Tool Injection Problem

Current frameworks and APIs require tools to be defined once upfront and injected into every request. MCP and similar protocols encourage thinking of tools as a static registry. For a system with 180 possible actions — not unusual for any reasonably complex business process — this means injecting the full schema for all 180 tools into every call, regardless of the fact that only 20 might be relevant in any given state.

The industry's practical answer to "too many tools" has been the universal tool — typically a bash shell or code interpreter — that can do anything. This solves the tool cardinality problem by granting the agent maximum privilege, which inverts the fundamental security principle of least privilege. The threat model becomes "attacker already has access to your hardware," which most security professionals would describe as already having lost.

### The Conversation Paradigm Itself

As agentic systems move toward automated pipelines where a human user is an afterthought or absent entirely, the conversation paradigm becomes increasingly vestigial. Chat formatting, conversational tone, step-by-step reasoning explanations, the assistant role itself — all of this is overhead optimized for a human-in-the-loop use case. For a system that needs to emit the correct next action given a state, this is a classification problem with context, not a conversation.

---

## Solution: A State-Action Framework

### Core Reframing

The unit of work is not a conversation turn. It is a **state-to-action decision**. Everything about how the LLM input is constructed should flow from that principle.

The model is not a "helpful assistant reply predictor." It is a **next action predictor** operating over a constrained, context-dependent action space. Each invocation receives a carefully constructed input containing exactly what it needs to choose the right action, emits a structured action, and retains nothing. All state management, history compression, and context assembly lives in a deterministic orchestration layer.

### Architecture Components

The framework requires six components, none of which are domain-specific in their machinery — only in the content they're configured with:

**State Schema.** A structured definition of the environment state: what fields exist, what types they are, what constitutes a valid state. This is what gets snapshotted and injected as current context each turn, replacing whatever was there before.

**Tool Registry.** The full set of possible actions, each with its parameter schema, decoupled from any provider's tool format. Just data.

**Rule Engine.** Given current state, which tools are valid. This can be simple predicate functions or something declarative: "If `order.status` is `pending_review`, enable `approve_order`, `reject_order`, `request_info`." The valid action set is computed before each invocation and only those actions are presented to the model.

**Context Assembler.** The core component. Each invocation, it takes the current state, selects relevant tools, pulls appropriate memory and history, selects per-state instructions, and builds the actual token sequence sent to the model. This is where context budgeting lives — it knows how many tokens are available, the priority order of what to include, and handles translation to whatever provider format is being used.

**History Manager.** Not an append-only conversation log, but an active system that maintains compressed, relevant action history. It drops failed attempts, collapses redundant reads, summarizes older actions, and keeps history within a token budget — all programmatically, without requiring LLM summarization calls.

**State Updater.** Takes action results and updates the state representation, including handling external state changes that occurred between turns.

### Context Window as a Budget

If you have 128k tokens available, the current paradigm might allocate them as: 8k system prompt, 80k of accumulated conversation noise, 30k of the current turn's tool results, and 10k for the model to work with. This is a terrible allocation.

The proposed architecture reframes the context window as an intentional budget:

- 20k of detailed, situation-specific instructions selected programmatically based on the current state
- 15k of clean, current environment state — deduplicated and structured
- 5k of compressed action history — outcomes only, not raw tool responses
- The remaining capacity is simply unused, meaning you can run a smaller, faster, cheaper model and get equal or better results

The insight is that most systems reach for the largest model and context window because their architecture wastes so much capacity. Fix the architecture and a smaller model with clean 8k input may outperform a frontier model drowning in 128k of noise.

### Constrained Output, Not Free Text

If the valid action space at a given state is 20 actions, the model should emit a structured choice from those 20 options — not free text that gets parsed for intent. Using a JSON schema or constrained decoding, the output is guaranteed valid on the first try. No retry loops. No "sorry, let me try that again in the correct format" polluting context.

This also resolves the security problem structurally. The model cannot take an action outside the valid set because constrained decoding won't allow it. Least privilege isn't a policy the model is hoped to respect — it's a physical constraint on the output space.

### Declarative Configuration

The framework is configured, not coded, for each domain:

```yaml
state:
  order:
    status: enum[draft, pending, approved, shipped, delivered]
    items: list[OrderItem]
    customer: CustomerRef
    risk_score: float

tools:
  approve_order:
    params: { note: string }
    valid_when: order.status == "pending" and order.risk_score < 0.7
  escalate_order:
    params: { reason: string }
    valid_when: order.status == "pending" and order.risk_score >= 0.7
  ship_order:
    params: { carrier: enum[fedex, ups, usps] }
    valid_when: order.status == "approved"

context:
  instructions:
    pending: "Evaluate the order against current fulfillment policy..."
    approved: "Select carrier based on package weight and destination..."
  memory:
    - source: order_history
      budget: 2000
    - source: customer_interactions
      budget: 1500
```

The framework turns this into optimally assembled LLM calls with constrained output schemas, clean state injection, filtered tool sets, and situation-appropriate instructions — without the developer thinking about prompt engineering, context windows, or provider-specific formats.

### Provider Independence

The model provider's API is treated as a raw inference endpoint, not as the owner of the agentic loop. The orchestration layer maintains its own action definitions, translates to the provider's format at the API boundary, and normalizes responses on the way back. Switching providers requires changing a translation layer, not rewriting the system.

For single-decision invocations, the framework can bypass tool use entirely and use structured output — a JSON schema representing the action space — which is simpler, more portable, and avoids the opacity of provider-managed tool injection.

### Returning to First Principles

In a sense, this approach circles back to the earliest LLM integration patterns: constructing exactly the text the model sees to produce the best possible output. The "conversation" the model receives bears little resemblance to what actually happened — it is an optimized fiction designed to produce the correct next action. The chat API is used as the text-in-text-out interface it fundamentally still is, with the message array treated as "whatever sequence of tokens produces the best decision" rather than "a faithful record of events."

---

## Implications

**For framework builders:** The abstraction needed is not "chat with tools" but "state machine where the LLM is the transition function." The generic machinery — context assembly, token budgeting, provider translation, history compression, action space filtering — is domain-independent. The domain-specific part is purely configuration.

**For model providers:** The market is moving toward systems where conversation history management, tool injection strategy, and context window optimization are competitive differentiators for the application developer, not black-box features owned by the provider. APIs that expose more control over how tool definitions are injected, how context is weighted, and how output is constrained will win in the agentic use case.

**For practitioners building agents in dynamic domains:** The current frameworks are optimized for a use case that probably isn't yours. The architectural mismatch between "chat with tools" and "stateful decision-making in a changing environment" is not a minor inconvenience — it's a fundamental constraint on reliability, cost, and performance. The path forward likely involves building your own orchestration layer that treats the LLM as a decision kernel, not as a conversational partner.

**For the industry:** The economic incentive to sell tokens by volume creates a misalignment between provider revenue and application efficiency. An architecture that uses 10x fewer tokens to achieve the same result is better for everyone except the token seller. As agentic applications mature and cost pressure increases, the architectures that survive will be the ones that treat context as a scarce resource to be budgeted, not an append-only log to be filled.
