import { encoding_for_model, get_encoding, type TiktokenModel } from "tiktoken";

export interface Tokenizer {
  count(input: string | Record<string, unknown>): number;
}

function serialize(input: string | Record<string, unknown>): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

class TiktokenTokenizer implements Tokenizer {
  private encoder;

  constructor(model: string) {
    try {
      this.encoder = encoding_for_model(model as TiktokenModel);
    } catch {
      this.encoder = get_encoding("cl100k_base");
    }
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

export function createTokenizer(
  providerType: string,
  model: string
): Tokenizer {
  if (providerType === "openai" || providerType === "openrouter" || providerType === "vllm") {
    return new TiktokenTokenizer(model);
  }
  // Anthropic will use their token counting API in a future version
  return new CharApproximationTokenizer();
}
