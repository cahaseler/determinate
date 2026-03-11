# Provider Layer Research

Research into LLM provider abstraction and structured output for the next-action-agent framework.

---

## The Requirement

The architecture described in [Beyond the Sacred Conversation](../beyond-the-sacred-conversation.md) treats the LLM as a **next action predictor** — not a conversational partner. Each invocation receives a freshly assembled context (state snapshot, compressed history, filtered action set, situational instructions) and emits a **structured action choice** from a constrained set of valid actions.

This means the provider layer needs to:

1. **Support structured output / constrained decoding** — the primary output mechanism. The model emits a JSON object conforming to a dynamically generated schema representing the current valid action space. No free text, no retry parsing.
2. **Translate between provider API formats** — without imposing conversation management, agent loops, or opinions about how context is assembled.
3. **Support local models** — the hypothesis is that clean, small context + constrained output will enable much smaller models to perform well. Local inference via vLLM is a first-class requirement.
4. **Support OAuth-based subscription access** — Claude Pro/Max, ChatGPT Plus/Pro. Users shouldn't need separate API keys if they already have subscriptions.

---

## Structured Output Landscape

### Cloud Providers

**OpenAI** — Full structured output via `response_format: { type: "json_schema", json_schema: { ... } }`. Uses constrained decoding internally (built on Microsoft's llguidance). Guarantees schema conformance. Production-ready.

**Anthropic** — Native structured output since November 2025 via `output_format: { type: "json_schema" }` on their Messages API. Grammar-level constrained token generation. In beta but functional. Also supports `strict: true` on tool definitions for constrained tool parameters. Their OpenAI-compatible endpoint (`api.anthropic.com/v1/`) does NOT support `response_format` — it's silently ignored. The compat endpoint is explicitly "not a long-term or production-ready solution."

**Google** — Supports `response_schema` in the Gemini API. Not pursuing for initial implementation.

### Local Inference

**vLLM** — Best-in-class. Full OpenAI-compatible API with `response_format: { type: "json_schema" }`. Multiple constrained decoding backends: XGrammar (default, <40μs/token overhead), Outlines, LM Format Enforcer, llguidance. Also supports `guided_regex`, `guided_grammar` (CFG), `guided_choice` for constraints beyond JSON schema. Production-ready.

**SGLang** — High performance (compressed FSMs, up to 2x latency reduction over standard approaches). XGrammar backend. Less API-compatible than vLLM but fast.

**SGLang, Ollama, llama.cpp** — Various levels of OpenAI-compatible structured output support, but none as clean as vLLM. Ollama's compat endpoint doesn't support `json_schema` response_format at all. llama.cpp has had persistent bugs with it. Not pursuing these as primary targets — vLLM is the recommended local inference path.

### Key Insight: Constrained Decoding + Tool-Call Training

For small models (7B-14B), research suggests the best approach is combining both:

- **Tool-calling training** (Qwen2.5/Qwen3 8-14B, Mistral-Small) helps the model produce semantically correct content — pick the right action, fill reasonable parameter values.
- **Constrained decoding** guarantees structural validity — no parse failures, no retries, no wasted tokens.

When the model is already trained to produce the target format, constraints act as a safety net rather than fighting the model's output distribution. ACL 2025 research found constrained decoding can degrade accuracy on instruction-tuned models by ~17% when the constraint format conflicts with training — but that penalty largely disappears when the model was trained for the target format.

---

## Existing Libraries Evaluated

### pi-ai (`@mariozechner/pi-ai`)

The initial candidate. Part of the [pi-mono](https://github.com/badlogic/pi-mono) monorepo by Mario Zechner.

**What it offers:**
- Unified API across 20+ providers (OpenAI, Anthropic, Google, Mistral, Groq, xAI, Bedrock, OpenRouter, etc.)
- OAuth for Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot, Google Gemini CLI
- Token/cost tracking per response
- TypeBox tool schemas with AJV validation
- Streaming with partial tool argument parsing
- Cross-provider context handoffs

**What it doesn't offer:**
- No `response_format` / `output_format` / structured output support. The provider implementations build request params from known fields and don't pass through structured output options. `ProviderStreamOptions` is typed as `StreamOptions & Record<string, unknown>` but extra fields are silently dropped.
- Tool-calling oriented by design — only includes tool-calling capable models.

**Assessment:** Excellent provider abstraction and OAuth, but the architecture assumes tool calling as the output mechanism. The structured output gap is fundamental to our use case. The OAuth module (`@mariozechner/pi-ai/oauth`) is a separate entrypoint and is the most valuable piece for our purposes.

### Vercel AI SDK (`ai`)

**What it offers:**
- First-class structured output via `generateText` with `Output.object({ schema })`. Auto-negotiates per provider.
- Works with local models via community providers (Ollama, OpenAI-compatible).
- Zod schema support.

**What it doesn't offer:**
- Lightweight operation. ~186KB core, ~73,000 lines. Opinionated about its own abstraction layer.
- It's a framework that wants to own the interaction pattern, not a translation library.

**Assessment:** Too heavy and opinionated. Imposes its own abstraction on top of the provider APIs rather than getting out of the way.

### Thin Wrappers (llm-polyglot, token.js, multi-llm-ts)

**llm-polyglot** — 140KB, 1 dependency, OpenAI-shaped API translated to other providers. Closest to "just normalize the HTTP call." Last published Jan 2025; peer deps may be stale.

**token.js** — 408KB, bundles all provider SDKs as direct deps. Same OpenAI-shaped API pattern. More recently maintained (Apr 2025).

**multi-llm-ts** — 1.1MB, own Message class, Zod structured output support, 12 providers. Still in beta.

**Assessment:** These are closer to right-sized but all have maintenance/maturity concerns. None of them solve the OAuth problem.

### OpenAI SDK Directly

**The revelation:** The OpenAI Chat Completions API has become the de facto standard. vLLM, llama.cpp, Groq, xAI, OpenRouter, and many others expose OpenAI-compatible endpoints with full structured output support. The only major provider that doesn't speak OpenAI natively in a production-ready way is **Anthropic** — their compat endpoint drops `response_format`, `strict`, prompt caching, and extended thinking detail.

---

## Decision: Build a Thin Provider Layer

### Architecture

**OpenAI SDK as the universal interface.** The `openai` npm package talks directly to:
- OpenAI (cloud, full structured output)
- vLLM (local, full structured output via constrained decoding)
- OpenRouter (cloud, access to many providers)
- Any other OpenAI-compatible endpoint

**One Anthropic adapter.** A thin translation layer that:
- Accepts OpenAI-shaped requests
- Translates to Anthropic's native Messages API format
- Maps `response_format` to Anthropic's `output_format`
- Maps responses back to OpenAI shape
- Bounded problem — probably ~300 lines

**OAuth extracted from pi-ai.** pi-ai's OAuth module (MIT licensed) implements device code flows for subscription-based access. We'll extract the relevant OAuth logic into our own codebase rather than taking a dependency on pi-ai. The flows we need:
- Anthropic Claude Pro/Max subscription login
- OpenAI Codex (ChatGPT Plus/Pro) subscription login
- Token refresh and credential management

### What We're Not Building

- No Google/Vertex support. Access via OpenRouter if needed.
- No Bedrock support. Same.
- No streaming. Each invocation is a single-decision request/response.
- No conversation management. The Context Assembler builds a fresh payload each turn.
- No agent loop. The orchestration layer owns the loop.
- No tool calling as the primary output mechanism. Structured output via `response_format` / `output_format` is the default path. For smaller models, structured output and tool calling work together — tool-call training improves semantic quality (picking the right action, filling reasonable parameters) while constrained decoding guarantees structural validity. The two complement rather than substitute for each other.

### Provider Surface

| Provider | Interface | Structured Output | Auth |
|----------|-----------|-------------------|------|
| OpenAI | OpenAI SDK direct | `response_format: json_schema` | API key or OAuth (extracted from pi-ai) |
| Anthropic | Custom adapter → Messages API | `output_format: json_schema` | API key or OAuth (extracted from pi-ai) |
| vLLM (local) | OpenAI SDK, custom baseURL | `response_format: json_schema` (constrained decoding) | None |
| OpenRouter | OpenAI SDK, custom baseURL | Depends on upstream model | API key |

---

## Open Questions

1. **Token counting for context budgeting.** The Context Assembler needs to know how many tokens a payload will consume before sending it. Do we use tiktoken, or does the provider layer need to expose token counting?

2. **Cost tracking.** pi-ai provides per-response cost tracking. Do we replicate this, or is it out of scope for the provider layer?

3. **pi-ai OAuth extraction scope.** Need to read through pi-ai's OAuth source and determine what's involved in extracting the Anthropic and OpenAI Codex flows. How coupled are they to the rest of pi-ai? What are the actual dependencies?

---

## References

- [pi-mono repository](https://github.com/badlogic/pi-mono) — pi-ai source, OAuth module, agent-core
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — native `output_format` docs
- [Anthropic OpenAI SDK Compatibility](https://platform.claude.com/docs/en/api/openai-sdk) — limitations, `response_format` ignored
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) — `response_format: json_schema` docs
- [vLLM Structured Outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/) — XGrammar, Outlines, multi-backend support
- [Outlines (dottxt-ai)](https://github.com/dottxt-ai/outlines) — foundational FSM-based constrained decoding
- [XGrammar](https://arxiv.org/pdf/2411.15100) — pushdown automata, <40μs/token, default in vLLM/SGLang
- [ACL 2025: Hidden Cost of Structure](https://acl-bg.org/proceedings/2025/RANLP%202025/pdf/2025.ranlp-1.124.pdf) — constrained decoding quality degradation research
- [Berkeley Function Calling Leaderboard V4](https://gorilla.cs.berkeley.edu/leaderboard.html) — small model tool-calling benchmarks
