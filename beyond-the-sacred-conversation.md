# Beyond the Sacred Conversation

## Rethinking Agentic Architecture for Dynamic Environments

The dominant paradigm for building AI agent systems was forged in software development. Agentic coding assistants demonstrated remarkable effectiveness by placing a large language model inside a simple loop: read code, decide what to do, call tools, observe results, repeat. This works extraordinarily well for programming because the environment is almost uniquely forgiving. The state is deterministic and stable — a file doesn't change while you're working on it. Feedback is crisp — tests pass or fail, code compiles or doesn't. Retries are safe — if something fails, you can usually try the same action again and expect the same preconditions to hold.

The success of this model has led to its wholesale adoption as the default architecture for agentic systems across every domain. Frameworks, APIs, model training, and developer tooling are all built around the same core structure: an append-only conversation history, a static list of tools, and a loop that generates the next assistant message given the full history.

The problem is that most real-world domains where agents need to operate share almost none of the properties that make this architecture work for code.

---

## The Sacred Conversation

The entire stack — from model training to API design to framework architecture — treats the conversation history as an append-only log that represents ground truth. This assumption runs deep. The attention mechanism operates over the ever-growing token sequence, and positional encoding gives disproportionate weight to earlier tokens. Your system prompt and first few exchanges are literally more influential than your most recent state update.

For any dynamic environment, the architecture has the relationship between freshness and importance exactly backwards.

The conversation log conflates at least three concerns that should be separate. Task specification — what am I trying to accomplish, what are my constraints — is relatively static and deserves high weight. Current world state — what does the environment look like right now — should be a single snapshot that gets replaced wholesale each turn, not appended. Action history — what have I done, what worked — is useful but should be compressed, not preserved verbatim with every failed tool call intact.

In the current paradigm, all three are mashed into one linear token sequence and treated identically by the model. There is no mechanism to say "this block is the current state, always prefer it over any earlier version" or "these failed tool calls should be heavily discounted." You can write instructions telling the model to do this, but then you're spending the model's reasoning capacity compensating for an architectural limitation rather than solving the actual problem.

## The 800 Copies Problem

In a dynamic environment, the agent needs fresh state almost every turn. If you inject environment state each turn across a 50-turn interaction, you have 50 snapshots in context, 49 of which are wrong. The model must determine which one is current every time it reasons. The oldest, most incorrect snapshot has the strongest positional signal.

The alternative — telling the agent to use tools to discover its own state — is equally wasteful. The agent spends half its turns burning tool calls and thousands of tokens reconstructing a picture of the world that the orchestration layer already knows. The context window fills with search results, file reads, and API responses that served only to rebuild context that should have been handed to the model directly.

Even in the programming domain, these problems are visible. When an agent edits a file three times, the context contains four versions — the original read plus three edits. The model implicitly learns "ignore the first three, the last one is real," but it's spending capacity on that reconciliation instead of the actual task, and every stale version costs tokens on every subsequent turn. Failed tool calls are pure noise. Retry loops leave behind a trail of errors that serve no purpose but consume context. Half the conversation history in a typical agentic run is the agent's own mistakes and redundant observations.

## The Static Tool Problem

Current frameworks and APIs require tools to be defined once upfront and injected into every request. MCP and similar protocols encourage thinking of tools as a static registry. For a system with 180 possible actions — not unusual for any reasonably complex business process — this means injecting the full schema for all 180 tools into every call, even though only 20 might be relevant in the current state.

The industry's practical answer to "too many tools" has been the universal tool — typically a bash shell or code interpreter — that can do anything. This solves the tool cardinality problem by granting the agent maximum privilege, which inverts the fundamental security principle of least privilege. The threat model becomes "attacker already has access to your hardware," which most security professionals would describe as already having lost.

## The Conversation Paradigm Itself

As agentic systems move toward automated pipelines where a human user is absent entirely, the conversation paradigm becomes increasingly vestigial. Chat formatting, conversational tone, step-by-step reasoning explanations, the assistant role itself — all of this is overhead optimized for a human-in-the-loop use case. For a system that needs to emit the correct next action given a state, this is a classification problem with context, not a conversation.

---

## The Alternative: State-Action Architecture

The unit of work is not a conversation turn. It is a **state-to-action decision**. Everything about how the LLM input is constructed should flow from that principle.

The model is not a "helpful assistant reply predictor." It is a **next-action predictor** operating over a constrained, context-dependent action space. Each invocation receives a carefully constructed input containing exactly what it needs to choose the right action, emits a structured action, and retains nothing. All state management, history compression, and context assembly lives in a deterministic orchestration layer outside the model.

### Engineered Context, Not Accumulated History

If you have 128k tokens available, the conversation paradigm might allocate them as: 8k system prompt, 80k of accumulated conversation noise, 30k of the current turn's tool results, and 10k for the model to work with. This is a terrible allocation.

The state-action architecture treats the context window as an intentional budget:

- Detailed, situation-specific instructions selected based on current state
- A clean, current snapshot of environment state — deduplicated and structured
- Compressed action history — outcomes only, not raw tool responses
- Only the tool definitions that are valid right now

The remaining capacity is simply unused. This is the key insight: most systems reach for the largest model and context window because their architecture wastes so much capacity. Fix the architecture and a smaller model with clean context may outperform a frontier model drowning in noise.

### Constrained Output, Not Free Text

If the valid action space at a given state is five actions, the model should emit a structured choice from those five — not free text that gets parsed for intent. Using constrained decoding with a JSON schema, the output is guaranteed valid on the first try. No retry loops. No "sorry, let me try that again in the correct format" polluting context. The model can make the wrong choice, but it cannot fail to make a valid one.

This also resolves the security problem structurally. The model cannot take an action outside the valid set because constrained decoding won't allow it. Least privilege isn't a policy the model is hoped to respect — it's a physical constraint on the output space.

### Conditional Tool Validity

Rather than injecting every possible action into every call, tools declare when they're valid as a function of state. An order can only be shipped when its status is "approved." A refund can only be issued when the customer is premium and the balance is sufficient. These predicates are evaluated before the model sees anything, and only valid actions enter the schema. The model doesn't need to figure out what it's allowed to do — the allowed actions are the only ones it can express.

### Provider as Inference Endpoint

The model provider's API is treated as a raw inference endpoint, not as the owner of the agentic loop. The orchestration layer maintains its own state, its own action definitions, and its own context assembly strategy. It translates to the provider's format at the API boundary and normalizes responses on the way back. Switching providers means changing a translation layer, not rewriting the system.

### Returning to First Principles

In a sense, this approach circles back to the earliest LLM integration patterns: constructing exactly the text the model sees to produce the best possible output. The "conversation" the model receives bears little resemblance to what actually happened — it is an optimized input designed to produce the correct next action. The chat API is used as the text-in-text-out interface it fundamentally still is, with the message array treated as "whatever sequence of tokens produces the best decision" rather than "a faithful record of events."

---

## Implications

**For framework builders:** The abstraction needed is not "chat with tools" but "state machine where the LLM is the transition function." The generic machinery — context assembly, token budgeting, provider translation, action space filtering — is domain-independent. The domain-specific part is configuration.

**For model providers:** The market is moving toward systems where context assembly strategy and output constraint are competitive differentiators for the application developer, not black-box features owned by the provider. APIs that expose more control over how context is weighted and how output is constrained will win in the agentic use case.

**For practitioners:** The current frameworks are optimized for a use case that probably isn't yours. The architectural mismatch between "chat with tools" and "stateful decision-making in a changing environment" is not a minor inconvenience — it's a fundamental constraint on reliability, cost, and performance.

**For the industry:** The economic incentive to sell tokens by volume creates a misalignment between provider revenue and application efficiency. An architecture that uses 10x fewer tokens to achieve the same result is better for everyone except the token seller. As agentic applications mature, the architectures that survive will be the ones that treat context as a scarce resource to be budgeted, not an append-only log to be filled.
