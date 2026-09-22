import { z } from "zod";
import { assembleContext } from "./context/assembler";
import { createTokenizer, type Tokenizer } from "./context/tokenizer";
import { consultDecider } from "./decider/decide";
import { AbortError, OutputError, ProviderError, ValidationError } from "./errors";
import { getOAuthApiKey } from "./oauth/index";
import { createProvider } from "./providers/factory";
import type { Provider, ProviderResponse } from "./providers/types";
import { type ValidatedHistoryEntry, validateHistory } from "./schema/history-schema";
import { describeIssues } from "./schema/issues";
import type {
	ActionResult,
	AgentConfig,
	HistoryEntry,
	ModelPricing,
	NextActionOptions,
	ResolvedTool,
	TokenUsage,
	ToolDefinition,
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
			throw new ValidationError(`Invalid state: ${describeIssues(result.error.issues)}`);
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

	private assemble(state: TState, tools: ToolDefinition<TState>[]) {
		return assembleContext({
			state,
			tools,
			history: this.history,
			instructions: this.config.instructions,
			budgets: this.config.context.budgets,
			tokenizer: this.tokenizer,
			providerType: this.config.provider.type,
			providerModel: this.config.provider.model,
		});
	}

	/** Asks the LLM for an action, re-asking with a correction message after malformed output. */
	private async askProvider(
		assembled: ReturnType<typeof assembleContext<TState>>,
		{ signal, outputRetries = 2 }: Pick<NextActionOptions, "signal" | "outputRetries">,
	): Promise<ProviderResponse> {
		const provider = await this.resolveProvider();
		const retryMessages = [...assembled.messages];

		for (let attempt = 0; ; attempt++) {
			try {
				const response = await provider.sendRequest({
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

				const toolDef = assembled.tools.find((t) => t.name === response.action.tool);
				if (toolDef) {
					let paramsResult = toolDef.params.safeParse(response.action.params);
					if (!paramsResult.success) {
						paramsResult = toolDef.params.safeParse(omitNullObjectFields(response.action.params));
					}
					if (!paramsResult.success) {
						throw new OutputError(
							`Params for tool "${response.action.tool}" failed validation: ${describeIssues(paramsResult.error.issues)}`,
							JSON.stringify(response.action),
						);
					}
					response.action.params = paramsResult.data as Record<string, unknown>;
				}
				return response;
			} catch (err) {
				if (!(err instanceof OutputError) || !err.retryable || attempt >= outputRetries) throw err;
				retryMessages.push({
					role: "user",
					content: `Your previous response was invalid: ${err.message}. Respond only with one JSON object that exactly matches the supplied schema.`,
				});
			}
		}
	}

	async nextAction(options?: NextActionOptions): Promise<ActionResult | VerboseActionResult> {
		const state = this.getState();
		const { tools, decider, pricing } = this.config;

		let signal: AbortSignal | undefined = options?.signal;

		if (options?.timeout) {
			const timeoutSignal = AbortSignal.timeout(options.timeout);
			signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		}

		try {
			const assembled = this.assemble(state, tools);
			const start = performance.now();

			const decided = decider
				? await consultDecider({
						config: decider,
						tools: assembled.tools,
						instructions: assembled.instructions,
						history: this.history,
						signal,
					})
				: undefined;

			// When the decider settled the tool but not all its params, the LLM only sees that tool,
			// with any params the decider settled fixed to their values.
			const asked = decided?.tool
				? this.assemble(
						state,
						assembled.tools
							.filter(({ name }) => name === decided.tool)
							.map((tool) => fixParams(tool, decided.settled)),
					)
				: assembled;
			const response = decided?.action
				? undefined
				: await this.askProvider(asked, { signal, outputRetries: options?.outputRetries });
			const action = decided?.action ?? response?.action;
			if (!action) throw new OutputError("Model returned no response", "");
			const latency = performance.now() - start;

			const costs = [
				response && pricing ? priceUsage(response.meta.tokensUsed, pricing) : undefined,
				decided?.meta.reportedCost ??
					(decided && decider?.pricing
						? priceUsage(decided.meta.tokensUsed, decider.pricing)
						: undefined),
			].filter((cost) => cost !== undefined);

			const result: ActionResult = {
				action,
				meta: {
					tokensUsed: response?.meta.tokensUsed ??
						decided?.meta.tokensUsed ?? { input: 0, output: 0 },
					cost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : undefined,
					model: response?.meta.model ?? decided?.meta.model ?? this.config.provider.model,
					latency,
					...(decided && { decider: decided.meta }),
				},
			};

			if (options?.verbose) {
				return {
					...result,
					context: {
						messages: asked.messages,
						outputSchema: asked.outputSchema,
						validTools: assembled.validTools,
						...(decided && { deciderRequest: decided.request }),
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

/** Narrows a tool's params schema so the given params admit only the decider's values. */
function fixParams<TState>(
	tool: ResolvedTool<TState>,
	settled: Record<string, unknown> | undefined,
): ResolvedTool<TState> {
	const { params } = tool;
	if (!settled || !(params instanceof z.ZodObject)) return tool;
	const shape = params.shape as Record<string, z.ZodType>;
	const fixed = Object.fromEntries(
		Object.entries(settled).map(([name, value]) => {
			const literal = z.literal(value as z.core.util.Literal);
			const description = shape[name]?.description;
			return [name, description ? literal.describe(description) : literal];
		}),
	);
	return { ...tool, params: params.extend(fixed) };
}

const priceUsage = ({ input, output }: TokenUsage, pricing: ModelPricing): number =>
	(input / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;

function omitNullObjectFields(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitNullObjectFields);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== null)
			.map(([key, child]) => [key, omitNullObjectFields(child)]),
	);
}
