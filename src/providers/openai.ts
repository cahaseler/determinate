import OpenAI from "openai";
import { OutputError, ProviderError } from "../errors";
import type { ProviderConfig } from "../types";
import { parseActionFromJson } from "./parse-action";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

export class OpenAIProvider implements Provider {
	private client: OpenAI;
	private config: ProviderConfig;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey ?? "",
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
				},
				{
					signal: request.signal,
				},
			);

			const content = response.choices[0]?.message?.content;
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
				throw new ProviderError(this.config.type, err.message);
			}
			throw err;
		}
	}
}
