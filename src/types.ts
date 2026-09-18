import type { z } from "zod";

// ---- Agent Configuration ----

export interface ProviderConfig {
	type: "openai" | "anthropic" | "vllm" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	oauth?: boolean;
	/**
	 * How hard a reasoning model thinks before it answers. Choosing one action from
	 * a short list rarely needs much: at their default effort, cheap reasoning models
	 * can spend thousands of tokens (and most of a minute) per decision, and run out
	 * of `max_tokens` before producing the answer at all. Sent as `reasoning.effort`
	 * on OpenRouter and `reasoning_effort` on OpenAI. Ignored for Anthropic, where
	 * thinking is off unless `options` turns it on, and for vLLM, which has no common
	 * setting (pass `chat_template_kwargs` through `options`).
	 */
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
	/** Extra request-body fields, passed through as they are. They win over anything the library sets. */
	options?: Record<string, unknown>;
}

export interface TokenBudgets {
	instructions: number;
	history: number;
	tools: number;
}

export interface ToolDefinition<TState> {
	name: string;
	description: string;
	/**
	 * The tool's parameter schema, or a function of state that builds it. Use the
	 * function form when the valid values live in state (the IDs in reach, the
	 * items in stock): an enum of them constrains an LLM to real values and lets
	 * a decider choose among them. Only called for tools that pass `validWhen`.
	 */
	params: z.ZodType | ((state: TState) => z.ZodType);
	validWhen: (state: TState) => boolean;
	instructions?: string;
}

/** A valid tool whose params have been built for the current state. */
export type ResolvedTool<TState> = ToolDefinition<TState> & { params: z.ZodType };

export interface ModelPricing {
	input: number;
	output: number;
}

/**
 * Optional System One model (TypeSafe's Jev) consulted before the LLM. It picks
 * the tool, and fills the params too when they are all closed-set (enums,
 * literals, booleans). Anything it cannot express falls through to `provider`.
 * Reached directly at TypeSafe (`type: "typesafe"`) or through OpenRouter's
 * decisions endpoint (`type: "openrouter"`, with an OpenRouter key).
 */
export interface DeciderConfig {
	type: "typesafe" | "openrouter";
	apiKey: string;
	/** Defaults to "jev-latest" at TypeSafe and "typesafe/jev-1.13" on OpenRouter. */
	model?: string;
	baseUrl?: string;
	/** Answers below this confidence (0–1) are handed to the LLM instead. Unset accepts every answer. */
	minConfidence?: number;
	/**
	 * The question asked when choosing a tool. Defaults to "Which action should be
	 * taken next?". A choose-only model answers the question it is asked, so put
	 * the current objective here rather than leaving it somewhere in the
	 * instructions. A function is called on every decision.
	 */
	question?: string | (() => string);
	/**
	 * A decider cannot write free-form values. By default one free-form param
	 * sends the whole tool's params to the LLM. When true, free-form params that
	 * are optional are left unset instead, so a tool like
	 * `{ target: enum, note?: string }` stays with the decider.
	 */
	omitOptionalFreeForm?: boolean;
	pricing?: ModelPricing;
}

export interface AgentConfig<TState> {
	provider: ProviderConfig;
	decider?: DeciderConfig;
	state: z.ZodType<TState>;
	tools: ToolDefinition<TState>[];
	instructions: (state: TState) => string;
	context: {
		budgets: TokenBudgets;
	};
	pricing?: ModelPricing;
}

// ---- History ----

export interface HistoryEntry {
	tool: string;
	params: Record<string, unknown>;
	result: string;
	success?: boolean;
	timestamp?: string;
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

export type DeciderFallbackReason = "low-confidence" | "invalid-output" | "unavailable";

export interface DeciderMeta {
	/** How much of the action the decider settled. "none" means the LLM made the whole decision. */
	decided: "action" | "tool" | "none";
	model: string;
	tokensUsed: TokenUsage;
	latency: number;
	/** Lowest confidence among the decider answers that were used. */
	confidence?: number;
	toolProbabilities?: Record<string, number>;
	/** Why the LLM was asked for something the decider could have settled. */
	fallbackReason?: DeciderFallbackReason;
	/** The decider's own failure message when it was unavailable or returned invalid output, e.g. "HTTP 429: ...". */
	fallbackDetail?: string;
	/** With `decided: "tool"`: the params the decider settled; the LLM was only asked for the others. */
	settledParams?: string[];
	/** What the route itself reported the request cost, when it reports one (OpenRouter does). */
	reportedCost?: number;
}

export interface ActionMeta {
	/** Usage of the model named in `model`. Decider usage is reported under `decider` when an LLM was also called. */
	tokensUsed: TokenUsage;
	/** Sum of the LLM and decider costs for which pricing was configured. */
	cost?: number;
	model: string;
	latency: number;
	/** Present when a decider is configured and was consulted. */
	decider?: DeciderMeta;
}

export interface ActionResult {
	action: Action;
	meta: ActionMeta;
}

export interface VerboseActionResult extends ActionResult {
	context: AssembledContext;
}

export interface AssembledContext {
	messages: unknown[];
	outputSchema: Record<string, unknown>;
	validTools: string[];
	/** Body sent to the decider, when one was consulted. `messages` is then the LLM request, sent or not. */
	deciderRequest?: Record<string, unknown>;
}

// ---- Next Action Options ----

export interface NextActionOptions {
	verbose?: boolean;
	signal?: AbortSignal;
	timeout?: number;
	/** Number of times to ask the model again after malformed or schema-invalid output. Defaults to 2. */
	outputRetries?: number;
}
