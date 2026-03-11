import type { Action } from "../types";

export interface ProviderRequest {
	messages: unknown[];
	outputSchema: Record<string, unknown>;
	model: string;
	options?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface ProviderResponse {
	action: Action;
	meta: {
		tokensUsed: { input: number; output: number };
		model: string;
	};
}

export interface Provider {
	sendRequest(request: ProviderRequest): Promise<ProviderResponse>;
}
