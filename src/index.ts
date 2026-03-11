import { Agent } from "./agent";
import type { AgentConfig } from "./types";

export function createAgent<TState>(config: AgentConfig<TState>): Agent<TState> {
	return new Agent(config);
}

export { Agent } from "./agent";

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
	HistoryEntry,
	NextActionOptions,
	ProviderConfig,
	TokenBudgets,
	TokenUsage,
	ToolDefinition,
	VerboseActionResult,
} from "./types";
