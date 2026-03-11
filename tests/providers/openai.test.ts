import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OpenAIProvider } from "../../src/providers/openai";

describe("OpenAI provider", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return req.json().then((body) =>
          Response.json({
            id: "test-id",
            object: "chat.completion",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    tool: "approve_order",
                    params: { note: "ok" },
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
            _request: body,
          })
        );
      },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => {
    server.stop();
  });

  it("sends a structured output request with response_format", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: {
        type: "object",
        properties: { tool: { type: "string" }, params: { type: "object" } },
        required: ["tool", "params"],
        additionalProperties: false,
      },
      model: "gpt-4o",
    });

    expect(result.action.tool).toBe("approve_order");
    expect(result.action.params).toEqual({ note: "ok" });
    expect(result.meta.tokensUsed.input).toBe(100);
    expect(result.meta.tokensUsed.output).toBe(20);
    expect(result.meta.model).toBe("gpt-4o");
  });

  it("passes through provider options", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
      options: { temperature: 0.5 },
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "gpt-4o",
      options: { temperature: 0.5 },
    });

    expect(result).toBeDefined();
  });

  it("parses the action from response content", async () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      baseUrl,
    });

    const result = await provider.sendRequest({
      messages: [{ role: "user", content: "test" }],
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      model: "gpt-4o",
    });

    expect(result.action).toHaveProperty("tool");
    expect(result.action).toHaveProperty("params");
  });
});
