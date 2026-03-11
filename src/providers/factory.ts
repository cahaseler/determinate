import type { ProviderConfig } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { Provider } from "./types";

export function createProvider(config: ProviderConfig): Provider {
	switch (config.type) {
		case "openai":
			return new OpenAIProvider(config);
		case "vllm":
			return new OpenAIProvider({
				...config,
				baseUrl: config.baseUrl ?? "http://localhost:8000/v1",
			});
		case "openrouter":
			return new OpenAIProvider({
				...config,
				baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
			});
		case "anthropic":
			return new AnthropicProvider(config);
		default:
			throw new Error(`Unknown provider type: ${(config as any).type}`);
	}
}
