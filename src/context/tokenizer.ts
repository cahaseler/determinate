import { encoding_for_model, get_encoding, type TiktokenModel } from "tiktoken";
import type { ProviderConfig } from "../types";

export interface Tokenizer {
	count(input: string | Record<string, unknown>): number;
}

function serialize(input: string | Record<string, unknown>): string {
	if (typeof input === "string") return input;
	return JSON.stringify(input);
}

function loadEncoder(model: string) {
	try {
		return encoding_for_model(model as TiktokenModel);
	} catch {
		return get_encoding("cl100k_base");
	}
}

// Building an encoder parses its whole BPE table (hundreds of ms), so agents for the same model share one.
const encoders = new Map<string, ReturnType<typeof loadEncoder>>();

class TiktokenTokenizer implements Tokenizer {
	private encoder;

	constructor(model: string) {
		this.encoder = encoders.get(model) ?? loadEncoder(model);
		encoders.set(model, this.encoder);
	}

	count(input: string | Record<string, unknown>): number {
		return this.encoder.encode(serialize(input)).length;
	}
}

class CharApproximationTokenizer implements Tokenizer {
	private readonly charsPerToken = 3;

	count(input: string | Record<string, unknown>): number {
		return Math.ceil(serialize(input).length / this.charsPerToken);
	}
}

export function createTokenizer(providerType: ProviderConfig["type"], model: string): Tokenizer {
	if (providerType === "openai" || providerType === "openrouter" || providerType === "vllm") {
		return new TiktokenTokenizer(model);
	}
	// Anthropic doesn't use tiktoken — approximate by character count
	return new CharApproximationTokenizer();
}
