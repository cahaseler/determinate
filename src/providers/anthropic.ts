import { OutputError, ProviderError } from "../errors";
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_STATUS_CODES = [429, 500, 502, 503, 529];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export class AnthropicProvider implements Provider {
	private config: ProviderConfig;
	private baseUrl: string;

	constructor(config: ProviderConfig) {
		this.config = config;
		this.baseUrl = config.baseUrl ?? ANTHROPIC_API_BASE;
	}

	async sendRequest(request: ProviderRequest): Promise<ProviderResponse> {
		const messages = request.messages as Array<{ role: string; content: unknown }>;
		let system: string | undefined;
		const anthropicMessages: AnthropicMessage[] = [];

		for (const msg of messages) {
			if (msg.role === "system") {
				system = msg.content as string;
			} else {
				anthropicMessages.push({
					role: msg.role as "user" | "assistant",
					content: msg.content as AnthropicMessage["content"],
				});
			}
		}

		const body: Record<string, unknown> = {
			model: request.model,
			messages: anthropicMessages,
			max_tokens: 4096,
			output_config: {
				format: {
					type: "json_schema",
					schema: request.outputSchema,
				},
			},
			...request.options,
		};

		if (system) {
			body.system = system;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": this.config.apiKey ?? "",
			"anthropic-version": ANTHROPIC_VERSION,
		};

		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (request.signal?.aborted) {
				throw new ProviderError("anthropic", "Request was aborted");
			}

			try {
				const response = await fetch(`${this.baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: request.signal,
				});

				if (!response.ok) {
					const errorBody = await response.text();
					if (RETRY_STATUS_CODES.includes(response.status) && attempt < MAX_RETRIES) {
						const delay = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delay);
						lastError = new ProviderError("anthropic", `HTTP ${response.status}: ${errorBody}`);
						continue;
					}
					throw new ProviderError("anthropic", `HTTP ${response.status}: ${errorBody}`);
				}

				const data = (await response.json()) as {
					content?: Array<{ type: string; text?: string }>;
					usage?: { input_tokens?: number; output_tokens?: number };
					model?: string;
				};

				const textBlock = data.content?.find((b) => b.type === "text");
				if (!textBlock?.text) {
					throw new OutputError(
						"No text content in Anthropic response",
						JSON.stringify(data.content),
					);
				}

				let parsed: unknown;
				try {
					parsed = JSON.parse(textBlock.text);
				} catch {
					throw new OutputError("Failed to parse Anthropic response as JSON", textBlock.text);
				}

				const action = parsed as { tool?: string; params?: Record<string, unknown> };
				if (
					typeof action.tool !== "string" ||
					typeof action.params !== "object" ||
					action.params === null
				) {
					throw new OutputError(
						"Response missing required 'tool' or 'params' fields",
						textBlock.text,
					);
				}

				return {
					action: { tool: action.tool, params: action.params as Record<string, unknown> },
					meta: {
						tokensUsed: {
							input: data.usage?.input_tokens ?? 0,
							output: data.usage?.output_tokens ?? 0,
						},
						model: data.model ?? request.model,
					},
				};
			} catch (err) {
				if (err instanceof ProviderError || err instanceof OutputError) throw err;
				throw new ProviderError("anthropic", (err as Error).message);
			}
		}

		throw lastError ?? new ProviderError("anthropic", "Max retries exceeded");
	}
}
