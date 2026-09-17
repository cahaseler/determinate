import type { z } from "zod";

// ---- Agent Configuration ----

export interface ProviderConfig {
	type: "openai" | "anthropic" | "vllm" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	oauth?: boolean;
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
	params: z.ZodType;
	validWhen: (state: TState) => boolean;
	instructions?: string;
}

export interface ModelPricing {
	input: number;
	output: number;
}

/**
 * Optional System One model (TypeSafe's Jev) consulted before the LLM. It picks
 * the tool, and fills the params too when they are all closed-set (enums,
 * literals, booleans). Anything it cannot express falls through to `provider`.
 */
export interface DeciderConfig {
	type: "typesafe";
	apiKey: string;
	/** Defaults to "jev-latest". */
	model?: string;
	baseUrl?: string;
	/** Answers below this confidence (0–1) are handed to the LLM instead. Unset accepts every answer. */
	minConfidence?: number;
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
