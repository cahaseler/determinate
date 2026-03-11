import { Agent } from "./agent";
import type { AgentConfig } from "./types";

export function createAgent<TState>(config: AgentConfig<TState>): Agent<TState> {
  return new Agent(config);
}

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

export {
  ValidationError,
  BudgetExceededError,
  NoValidToolsError,
  ProviderError,
  OutputError,
  AbortError,
} from "./errors";

export { Agent } from "./agent";
