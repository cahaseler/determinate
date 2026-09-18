import { ProviderError } from "../errors";
import type { DeciderConfig, TokenUsage } from "../types";
import type { ChoiceAnswer } from "./questions";

const TYPESAFE_API_BASE = "https://api.typesafe.ai";
const OPENROUTER_API_BASE = "https://openrouter.ai";
export const DEFAULT_DECIDER_MODEL = "jev-latest";
export const DEFAULT_OPENROUTER_DECIDER_MODEL = "typesafe/jev-1.13";

/** The model a decider config asks for, by its route. */
export const deciderModel = (config: DeciderConfig): string =>
	config.model ??
	(config.type === "openrouter" ? DEFAULT_OPENROUTER_DECIDER_MODEL : DEFAULT_DECIDER_MODEL);

/** TypeSafe serves /v1/systemone; OpenRouter mirrors it at /api/alpha/decisions with the same body and answers. */
const endpointFor = (config: DeciderConfig): string =>
	config.type === "openrouter"
		? `${config.baseUrl ?? OPENROUTER_API_BASE}/api/alpha/decisions`
		: `${config.baseUrl ?? TYPESAFE_API_BASE}/v1/systemone`;

/** Rate limits and server-side failures, including gateway errors and TypeSafe's 529 overload. */
const isTransient = (status: number): boolean => status === 429 || status >= 500;
// The decider is a fast path in front of an LLM, so give up quickly and let the LLM answer.
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 250;

/** The decider could not be reached or kept failing; the caller should fall back to the LLM. */
export class DeciderUnavailableError extends Error {
	override name = "DeciderUnavailableError" as const;
}

export interface DeciderResponse {
	answers: Record<string, ChoiceAnswer>;
	tokensUsed: TokenUsage;
	model: string;
	/** What the route itself says the request cost, when it says (OpenRouter does). */
	cost?: number;
}

interface SystemOneResponse {
	model?: string;
	answers?: Record<string, ChoiceAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function askTypeSafe({
	config,
	body,
	signal,
}: {
	config: DeciderConfig;
	body: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<DeciderResponse> {
	const url = endpointFor(config);
	let lastFailure = "Max retries exceeded";

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));

		let response: Response;
		let data: SystemOneResponse | null = null;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});
			// A 2xx with an unreadable body (a proxy's HTML page, a cut-off response) is as transient as a 5xx.
			if (response.ok) data = (await response.json()) as SystemOneResponse | null;
		} catch (err) {
			if (signal?.aborted) throw err;
			lastFailure = (err as Error).message;
			continue;
		}

		if (response.ok) {
			return {
				answers: data?.answers ?? {},
				tokensUsed: {
					input: data?.usage?.input_tokens ?? 0,
					output: data?.usage?.output_tokens ?? 0,
				},
				model: data?.model ?? deciderModel(config),
				cost: typeof data?.usage?.cost === "number" ? data.usage.cost : undefined,
			};
		}

		lastFailure = `HTTP ${response.status}: ${await response.text()}`;
		// Bad credentials or a rejected request will not fix themselves, and silently
		// falling back would hide a misconfigured decider behind a working LLM.
		if (!isTransient(response.status)) {
			throw new ProviderError(config.type, lastFailure);
		}
	}

	throw new DeciderUnavailableError(lastFailure);
}
