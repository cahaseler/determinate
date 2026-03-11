import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { createAgent } from "../../src/index";

describe("end-to-end with mock server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				return req.json().then(() =>
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
										params: { note: "Looks good, low risk" },
									}),
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 200,
							completion_tokens: 25,
							total_tokens: 225,
						},
					}),
				);
			},
		});
		baseUrl = `http://localhost:${server.port}/v1`;
	});

	afterAll(() => {
		server.stop();
	});

	it("completes a full decision turn", async () => {
		const stateSchema = z.object({
			order: z.object({
				status: z.enum(["pending", "approved", "shipped"]),
				riskScore: z.number(),
				items: z.array(z.object({ name: z.string(), qty: z.number() })),
			}),
		});

		const agent = createAgent({
			provider: {
				type: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
				baseUrl,
			},
			state: stateSchema,
			tools: [
				{
					name: "approve_order",
					description: "Approve a pending order",
					params: z.object({ note: z.string() }),
					validWhen: (s) => s.order.status === "pending" && s.order.riskScore < 0.7,
				},
				{
					name: "escalate_order",
					description: "Escalate for review",
					params: z.object({ reason: z.string() }),
					validWhen: (s) => s.order.status === "pending" && s.order.riskScore >= 0.7,
				},
			],
			instructions: (s) => `You are an order processor. Risk score: ${s.order.riskScore}`,
			context: {
				budgets: {
					instructions: 5000,
					state: 5000,
					history: 5000,
					tools: 5000,
				},
			},
		});

		agent.setState({
			order: {
				status: "pending",
				riskScore: 0.3,
				items: [{ name: "Widget", qty: 2 }],
			},
		});

		agent.setHistory([
			{
				tool: "request_info",
				params: { field: "shipping_address" },
				result: "Customer provided address",
			},
		]);

		const result = await agent.nextAction();

		expect(result.action.tool).toBe("approve_order");
		expect(result.action.params).toEqual({ note: "Looks good, low risk" });
		expect(result.meta.tokensUsed.input).toBe(200);
		expect(result.meta.tokensUsed.output).toBe(25);
		expect(result.meta.model).toBe("gpt-4o");
		expect(result.meta.latency).toBeGreaterThan(0);
		expect(result.meta.cost).toBeUndefined();
	});

	it("returns verbose context when requested", async () => {
		const stateSchema = z.object({ status: z.string() });

		const agent = createAgent({
			provider: { type: "openai", model: "gpt-4o", apiKey: "test-key", baseUrl },
			state: stateSchema,
			tools: [
				{
					name: "approve_order",
					description: "Approve",
					params: z.object({ note: z.string() }),
					validWhen: () => true,
				},
			],
			instructions: () => "test",
			context: {
				budgets: { instructions: 5000, state: 5000, history: 5000, tools: 5000 },
			},
		});

		agent.setState({ status: "pending" });

		const result = await agent.nextAction({ verbose: true });

		expect("context" in result).toBe(true);
		const verbose = result as {
			context: { messages: unknown[]; outputSchema: unknown; validTools: string[] };
		};
		expect(verbose.context.messages).toBeDefined();
		expect(verbose.context.outputSchema).toBeDefined();
		expect(verbose.context.validTools).toContain("approve_order");
	});
});
