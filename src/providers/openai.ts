import OpenAI from "openai";
import type { ProviderConfig } from "../types";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";
import { ProviderError, OutputError } from "../errors";

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
        }
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new OutputError("No content in response", "");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new OutputError("Failed to parse response as JSON", content);
      }

      const action = parsed as { tool?: string; params?: Record<string, unknown> };
      if (typeof action.tool !== "string" || typeof action.params !== "object" || action.params === null) {
        throw new OutputError("Response missing required 'tool' or 'params' fields", content);
      }

      return {
        action: {
          tool: action.tool,
          params: action.params as Record<string, unknown>,
        },
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
