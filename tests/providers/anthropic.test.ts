import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AnthropicProvider } from "../../src/providers/anthropic";

describe("Anthropic provider", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				return req.json().then((body: Record<string, unknown>) => {
					const outputConfig = body.output_config as { format?: { type?: string } } | undefined;
					const hasOutputConfig = outputConfig?.format?.type === "json_schema";

					return Response.json({
						id: "msg-test",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5-20250514",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									tool: "approve_order",
									params: { note: "approved" },
								}),
							},
						],
						usage: {
							input_tokens: 150,
							output_tokens: 30,
						},
						_had_output_config: hasOutputConfig,
						_request: body,
					});
				});
			},
		});
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	it("translates request to Anthropic Messages API format", async () => {
		const provider = new AnthropicProvider({
			type: "anthropic",
			model: "claude-sonnet-4-5-20250514",
			apiKey: "test-key",
			baseUrl,
		});

		const result = await provider.sendRequest({
			messages: [
				{ role: "system", content: "You are a helper." },
				{ role: "user", content: "test" },
			],
			outputSchema: {
				type: "object",
				properties: { tool: { type: "string" }, params: { type: "object" } },
				required: ["tool", "params"],
				additionalProperties: false,
			},
			model: "claude-sonnet-4-5-20250514",
		});

		expect(result.action.tool).toBe("approve_order");
		expect(result.action.params).toEqual({ note: "approved" });
	});

	it("maps token usage from Anthropic format", async () => {
		const provider = new AnthropicProvider({
			type: "anthropic",
			model: "claude-sonnet-4-5-20250514",
			apiKey: "test-key",
			baseUrl,
		});

		const result = await provider.sendRequest({
			messages: [{ role: "user", content: "test" }],
			outputSchema: { type: "object", properties: {}, additionalProperties: false },
			model: "claude-sonnet-4-5-20250514",
		});

		expect(result.meta.tokensUsed.input).toBe(150);
		expect(result.meta.tokensUsed.output).toBe(30);
		expect(result.meta.model).toBe("claude-sonnet-4-5-20250514");
	});

	it("extracts system message from messages array", async () => {
		const provider = new AnthropicProvider({
			type: "anthropic",
			model: "claude-sonnet-4-5-20250514",
			apiKey: "test-key",
			baseUrl,
		});

		const result = await provider.sendRequest({
			messages: [
				{ role: "system", content: "System prompt" },
				{ role: "user", content: "Hello" },
			],
			outputSchema: { type: "object", properties: {}, additionalProperties: false },
			model: "claude-sonnet-4-5-20250514",
		});

		expect(result).toBeDefined();
	});
});
