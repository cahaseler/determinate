import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

export class AnthropicProvider implements Provider {
  constructor(private config: ProviderConfig) {}
  async sendRequest(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("Not implemented");
  }
}
