import OpenAI from "openai";
import { OutputError, ProviderError } from "../errors";
import type { ProviderConfig } from "../types";
import { parseActionFromJson } from "./parse-action";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

/**
 * The OpenAI SDK rejects a missing or empty `apiKey` at construction time, but
 * self-hosted endpoints (vLLM) do not need credentials. Fall back to a
 * placeholder so those agents still build and so genuine auth failures surface
 * as a typed ProviderError from the API rather than an untyped SDK throw.
 */
const PLACEHOLDER_API_KEY = "not-needed";

export class OpenAIProvider implements Provider {
	private client: OpenAI;
	private config: ProviderConfig;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey || PLACEHOLDER_API_KEY,
			baseURL: config.baseUrl,
		});
	}

	async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
		try {
			const response = await this.client.chat.completions.create(
				{
					model: request.model,
					messages: request.messages as OpenAI.ChatCompletionMessageParam[],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "action",
							strict: true,
							schema: request.outputSchema,
						},
					},
					...request.options,
					...librarySettings(this.config, request.options),
				},
				{
					signal: request.signal,
				},
			);

			const choice = response.choices[0];
			const content = choice?.message?.content;
			if (choice?.finish_reason === "length") {
				const used = response.usage?.completion_tokens;
				const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens;
				throw new OutputError(
					`The model reached its output limit (${used ?? "unknown"} tokens${reasoning ? `, ${reasoning} of them reasoning` : ""}) before finishing its answer. Lower reasoningEffort or raise max_tokens in the provider options.`,
					content ?? "",
					false,
				);
			}
			if (!content) {
				throw new OutputError("No content in response", "");
			}

			const action = parseActionFromJson(content);

			return {
				action,
				meta: {
					tokensUsed: {
						input: response.usage?.prompt_tokens ?? 0,
						output: response.usage?.completion_tokens ?? 0,
					},
					model: response.model,
				},
			};
		} catch (err) {
			if (err instanceof OutputError) throw err;
			if (err instanceof OpenAI.APIError) {
				const detail = serializeProviderError(err.error);
				throw new ProviderError(
					this.config.type,
					detail ? `${err.message}: ${detail}` : err.message,
				);
			}
			throw err;
		}
	}
}

/** Request fields the library sets for a provider type. Anything the consumer's `options` say on the same point wins. */
function librarySettings(
	{ type, reasoningEffort }: ProviderConfig,
	{ provider, reasoning, reasoning_effort }: Record<string, unknown> = {},
): Record<string, unknown> {
	if (type === "openrouter") {
		return {
			// OpenRouter otherwise routes to any host of the model, including ones that ignore
			// response_format, and the model then answers in prose or in a JSON shape of its own.
			provider: { require_parameters: true, ...(provider as object | undefined) },
			...(reasoningEffort && !reasoning ? { reasoning: { effort: reasoningEffort } } : {}),
		};
	}
	return type === "openai" && reasoningEffort && !reasoning_effort
		? { reasoning_effort: reasoningEffort }
		: {};
}

function serializeProviderError(error: unknown): string | undefined {
	if (error === undefined || error === null) return undefined;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
