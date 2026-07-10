import { assembleContext } from "./context/assembler";
import { createTokenizer, type Tokenizer } from "./context/tokenizer";
import { AbortError, OutputError, ProviderError, ValidationError } from "./errors";
import { getOAuthApiKey } from "./oauth/index";
import { createProvider } from "./providers/factory";
import type { Provider } from "./providers/types";
import { type ValidatedHistoryEntry, validateHistory } from "./schema/history-schema";
import type {
	ActionResult,
	AgentConfig,
	HistoryEntry,
	NextActionOptions,
	VerboseActionResult,
} from "./types";

export class Agent<TState> {
	private config: AgentConfig<TState>;
	private state: TState | undefined;
	private history: ValidatedHistoryEntry[] = [];
	private provider: Provider | undefined;
	private tokenizer: Tokenizer;

	constructor(config: AgentConfig<TState>) {
		this.config = config;
		this.tokenizer = createTokenizer(config.provider.type, config.provider.model);

		// Create provider immediately if we have an apiKey or OAuth isn't requested
		if (config.provider.apiKey || !config.provider.oauth) {
			this.provider = createProvider(config.provider);
		}
	}

	private async resolveProvider(): Promise<Provider> {
		if (this.provider) return this.provider;

		// OAuth is requested but no apiKey — try stored credentials
		const oauthProviderId = this.config.provider.type === "openai" ? "openai" : "anthropic";
		const result = await getOAuthApiKey(oauthProviderId);

		if (!result) {
			throw new ProviderError(
				this.config.provider.type,
				`No stored OAuth credentials for ${oauthProviderId}. Run the login flow first using the exported OAuth providers.`,
			);
		}

		this.provider = createProvider({
			...this.config.provider,
			apiKey: result.apiKey,
		});

		return this.provider;
	}

	setState(state: TState): void {
		const result = this.config.state.safeParse(state);
		if (!result.success) {
			throw new ValidationError(
				`Invalid state: ${result.error.issues.map((i) => i.message).join(", ")}`,
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

	async nextAction(options?: NextActionOptions): Promise<ActionResult | VerboseActionResult> {
		const state = this.getState();

		let signal: AbortSignal | undefined = options?.signal;

		if (options?.timeout) {
			const timeoutSignal = AbortSignal.timeout(options.timeout);
			signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
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
				providerModel: this.config.provider.model,
			});

			const provider = await this.resolveProvider();
			const start = performance.now();
			const retryMessages = [...assembled.messages];
			const outputRetries = options?.outputRetries ?? 2;
			let response: Awaited<ReturnType<Provider["sendRequest"]>> | undefined;
			let outputError: OutputError | undefined;

			for (let attempt = 0; attempt <= outputRetries; attempt++) {
				try {
					response = await provider.sendRequest({
						messages: retryMessages,
						outputSchema: assembled.outputSchema,
						model: this.config.provider.model,
						options: this.config.provider.options,
						signal,
					});

					if (!assembled.validTools.includes(response.action.tool)) {
						throw new OutputError(
							`Model returned tool "${response.action.tool}" which is not in the valid set: [${assembled.validTools.join(", ")}]`,
							JSON.stringify(response.action),
						);
					}

					const toolDef = this.config.tools.find((t) => t.name === response?.action.tool);
					if (toolDef) {
						let paramsResult = toolDef.params.safeParse(response.action.params);
						if (!paramsResult.success) {
							paramsResult = toolDef.params.safeParse(omitNullObjectFields(response.action.params));
						}
						if (!paramsResult.success) {
							throw new OutputError(
								`Params for tool "${response.action.tool}" failed validation: ${paramsResult.error.issues.map((i) => i.message).join(", ")}`,
								JSON.stringify(response.action),
							);
						}
						response.action.params = paramsResult.data as Record<string, unknown>;
					}
					outputError = undefined;
					break;
				} catch (err) {
					if (!(err instanceof OutputError) || attempt === outputRetries) throw err;
					outputError = err;
					retryMessages.push({
						role: "user",
						content: `Your previous response was invalid: ${err.message}. Respond only with one JSON object that exactly matches the supplied schema.`,
					});
				}
			}

			if (!response || outputError)
				throw outputError ?? new OutputError("Model returned no response", "");
			const latency = performance.now() - start;

			let cost: number | undefined;
			if (this.config.pricing) {
				const { input, output } = response.meta.tokensUsed;
				cost =
					(input / 1_000_000) * this.config.pricing.input +
					(output / 1_000_000) * this.config.pricing.output;
			}

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
					options?.timeout ? `Timeout after ${options.timeout}ms` : "Operation was aborted",
				);
			}
			throw err;
		}
	}
}

function omitNullObjectFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitNullObjectFields);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== null)
			.map(([key, child]) => [key, omitNullObjectFields(child)]),
	);
}
