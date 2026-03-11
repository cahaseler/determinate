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

    let signal: AbortSignal | undefined = options?.signal;

    if (options?.timeout) {
      const timeoutSignal = AbortSignal.timeout(options.timeout);
      signal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    }

    try {
      const assembled = assembleContext({
        state,
        tools: this.config.tools,
        history: this.history,
        instructions: this.config.instructions,
        budgets: this.config.context.budgets,
        tokenizer: this.tokenizer,
        providerType: this.config.provider.type,
      });

      const start = performance.now();
      const response = await this.provider.sendRequest({
        messages: assembled.messages,
        outputSchema: assembled.outputSchema,
        model: this.config.provider.model,
        options: this.config.provider.options,
        signal,
      });
      const latency = performance.now() - start;

      if (!assembled.validTools.includes(response.action.tool)) {
        throw new OutputError(
          `Model returned tool "${response.action.tool}" which is not in the valid set: [${assembled.validTools.join(", ")}]`,
          JSON.stringify(response.action)
        );
      }

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
