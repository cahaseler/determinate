import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ProviderError } from "../../src/errors";
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
					}),
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

	describe("request defaults", () => {
		const schema = { type: "object", properties: {}, additionalProperties: false };
		const reply = (choice: object, usage: object = {}) =>
			Response.json({ id: "x", object: "chat.completion", model: "m", choices: [choice], usage });
		const action = JSON.stringify({ tool: "approve_order", params: {} });

		/** Sends one request through a provider and returns the body the server received. */
		const sentBody = async (config: Partial<ConstructorParameters<typeof OpenAIProvider>[0]>) => {
			const bodies: Record<string, unknown>[] = [];
			const capture = Bun.serve({
				port: 0,
				fetch: async (req) => {
					bodies.push((await req.json()) as Record<string, unknown>);
					return reply({
						index: 0,
						message: { role: "assistant", content: action },
						finish_reason: "stop",
					});
				},
			});
			try {
				const provider = new OpenAIProvider({
					type: "openai",
					model: "m",
					apiKey: "test-key",
					baseUrl: `http://localhost:${capture.port}/v1`,
					...config,
				});
				await provider.sendRequest({
					messages: [{ role: "user", content: "test" }],
					outputSchema: schema,
					model: "m",
					options: config.options,
				});
				return bodies[0] ?? {};
			} finally {
				capture.stop();
			}
		};

		it("sends reasoningEffort in each provider's own form", async () => {
			expect(await sentBody({ type: "openai", reasoningEffort: "low" })).toMatchObject({
				reasoning_effort: "low",
			});
			expect(await sentBody({ type: "openrouter", reasoningEffort: "low" })).toMatchObject({
				reasoning: { effort: "low" },
			});
			const vllm = await sentBody({ type: "vllm", reasoningEffort: "low" });
			expect(vllm).not.toHaveProperty("reasoning");
			expect(vllm).not.toHaveProperty("reasoning_effort");
		});

		it("asks OpenRouter for hosts that honour the request's parameters, unless options say otherwise", async () => {
			expect(await sentBody({ type: "openrouter" })).toMatchObject({
				provider: { require_parameters: true },
			});
			expect(await sentBody({ type: "openai" })).not.toHaveProperty("provider");
			expect(
				await sentBody({ type: "openrouter", options: { provider: { only: ["some-host"] } } }),
			).toMatchObject({ provider: { only: ["some-host"], require_parameters: true } });
			expect(
				await sentBody({
					type: "openrouter",
					options: { provider: { require_parameters: false } },
				}),
			).toMatchObject({ provider: { require_parameters: false } });
		});

		it("reports a truncated answer as not worth retrying", async () => {
			const truncating = Bun.serve({
				port: 0,
				fetch: () =>
					reply(
						{ index: 0, message: { role: "assistant", content: null }, finish_reason: "length" },
						{ completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2048 } },
					),
			});
			try {
				const provider = new OpenAIProvider({
					type: "openrouter",
					model: "m",
					apiKey: "test-key",
					baseUrl: `http://localhost:${truncating.port}/v1`,
				});
				await expect(
					provider.sendRequest({ messages: [], outputSchema: schema, model: "m" }),
				).rejects.toMatchObject({
					name: "OutputError",
					retryable: false,
					message: expect.stringContaining("2048 of them reasoning"),
				});
			} finally {
				truncating.stop();
			}
		});
	});

	it("preserves structured provider error details", async () => {
		const failingServer = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					{
						error: {
							message: "Provider returned error",
							metadata: { raw: "Root schema must be an object" },
						},
					},
					{ status: 400 },
				);
			},
		});
		try {
			const provider = new OpenAIProvider({
				type: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
				baseUrl: `http://localhost:${failingServer.port}/v1`,
			});

			await expect(
				provider.sendRequest({
					messages: [{ role: "user", content: "test" }],
					outputSchema: { anyOf: [] },
					model: "gpt-4o",
				}),
			).rejects.toEqual(
				expect.objectContaining({
					name: "ProviderError",
					message: expect.stringContaining("Root schema must be an object"),
				}) as ProviderError,
			);
		} finally {
			failingServer.stop();
		}
	});
});
