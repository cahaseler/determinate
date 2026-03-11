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

export interface AgentConfig<TState> {
	provider: ProviderConfig;
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
	messages: unknown[];
	outputSchema: Record<string, unknown>;
	validTools: string[];
}

// ---- Next Action Options ----

export interface NextActionOptions {
	verbose?: boolean;
	signal?: AbortSignal;
	timeout?: number;
}
