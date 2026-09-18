import { Agent } from "./agent";
import type { AgentConfig } from "./types";

export function createAgent<TState>(config: AgentConfig<TState>): Agent<TState> {
	return new Agent(config);
}

export { Agent } from "./agent";
export type { Answer, AskMeta, AskResult, Decider, Question } from "./decider/ask";
export { createDecider } from "./decider/ask";
export { DeciderUnavailableError } from "./decider/typesafe";

export {
	AbortError,
	BudgetExceededError,
	NoValidToolsError,
	OutputError,
	ProviderError,
	ValidationError,
} from "./errors";
export type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "./oauth/index";
export { getOAuthApiKey, getOAuthProvider, getOAuthProviders, TokenStore } from "./oauth/index";
export type {
	Action,
	ActionMeta,
	ActionResult,
	AgentConfig,
	AssembledContext,
	DeciderConfig,
	DeciderFallbackReason,
	DeciderMeta,
	HistoryEntry,
	ModelPricing,
	NextActionOptions,
	ProviderConfig,
	TokenBudgets,
	TokenUsage,
	ToolDefinition,
	VerboseActionResult,
} from "./types";
