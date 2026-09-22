import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { OutputError, ProviderError } from "../../src/errors";
import { createAgent } from "../../src/index";
import type { ToolDefinition, VerboseActionResult } from "../../src/types";

type Body = Record<string, unknown>;

const stateSchema = z.object({ ticket: z.string(), closable: z.boolean().default(true) });

const tools = [
	{
		name: "set_priority",
		description: "Set the ticket priority",
		params: z.object({ level: z.enum(["low", "high"]), notify: z.boolean().optional() }),
		validWhen: () => true,
	},
	{
		name: "reply",
		description: "Reply to the customer",
		params: z.object({ message: z.string() }),
		validWhen: () => true,
	},
	{
		name: "close",
		description: "Close the ticket",
		params: z.object({}),
		validWhen: (s: z.infer<typeof stateSchema>) => s.closable,
	},
];

const answer = (choice: string, confidence = 0.95) => ({
	type: "choice",
	choice,
	confidence,
	probabilities: { [choice]: confidence },
});

describe("agent with a decider", () => {
	let deciderServer: ReturnType<typeof Bun.serve>;
	let llmServer: ReturnType<typeof Bun.serve>;
	let deciderRequests: Array<{ authorization: string | null; body: Body }>;
	let llmRequests: Body[];
	let respondAsDecider: (body: Body) => Response;
	let llmAction: { tool: string; params: Body };

	beforeAll(() => {
		deciderServer = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const body = (await req.json()) as Body;
				deciderRequests.push({ authorization: req.headers.get("authorization"), body });
				return respondAsDecider(body);
			},
		});
		llmServer = Bun.serve({
			port: 0,
			fetch: async (req) => {
				llmRequests.push((await req.json()) as Body);
				return Response.json({
					id: "test-id",
					object: "chat.completion",
					model: "gpt-4o",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: JSON.stringify(llmAction) },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 200, completion_tokens: 25, total_tokens: 225 },
				});
			},
		});
	});

	afterAll(() => {
		deciderServer.stop();
		llmServer.stop();
	});

	beforeEach(() => {
		deciderRequests = [];
		llmRequests = [];
		llmAction = { tool: "reply", params: { message: "On it" } };
	});

	const answerWith = (answers: Record<string, unknown>) => {
		respondAsDecider = () =>
			Response.json({
				model: "jev-1.13.0",
				answers,
				usage: { input_tokens: 1000, output_tokens: 30 },
			});
	};

	const createTestAgent = ({
		minConfidence,
		omitOptionalFreeForm,
		agentTools = tools,
	}: {
		minConfidence?: number;
		omitOptionalFreeForm?: boolean;
		agentTools?: ToolDefinition<z.infer<typeof stateSchema>>[];
	} = {}) => {
		const agent = createAgent({
			provider: {
				type: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
				baseUrl: `http://localhost:${llmServer.port}/v1`,
			},
			decider: {
				type: "typesafe",
				apiKey: "ts-key",
				baseUrl: `http://localhost:${deciderServer.port}`,
				minConfidence,
				omitOptionalFreeForm,
				pricing: { input: 0.042, output: 0 },
			},
			pricing: { input: 2.5, output: 10 },
			state: stateSchema,
			tools: agentTools,
			instructions: (s) => `Triage this ticket: ${s.ticket}`,
			context: { budgets: { instructions: 5000, history: 5000, tools: 5000 } },
		});
		agent.setState({ ticket: "Site is down!", closable: true });
		return agent;
	};

	/** Tools the LLM was offered: one branch when narrowed, otherwise the union nested under `action`. */
	const llmToolEnum = () => {
		type Branch = { properties: { tool: { enum: string[] } } };
		const format = llmRequests[0]?.response_format as {
			json_schema: { schema: Branch & { properties: { action?: { anyOf: Branch[] } } } };
		};
		const { schema } = format.json_schema;
		return (schema.properties.action?.anyOf ?? [schema]).flatMap(
			(branch) => branch.properties.tool.enum,
		);
	};

	it("returns a closed-set action without calling the LLM", async () => {
		answerWith({
			tool: answer("set_priority", 0.9),
			"param:set_priority:level": answer("high", 0.8),
			"param:set_priority:notify": answer("(unset)", 0.85),
		});
		const agent = createTestAgent({ minConfidence: 0.5 });
		agent.setHistory([{ tool: "reply", params: { message: "Looking" }, result: "sent" }]);

		const result = await agent.nextAction();

		expect(result.action).toEqual({ tool: "set_priority", params: { level: "high" } });
		expect(llmRequests).toHaveLength(0);
		expect(result.meta.model).toBe("jev-1.13.0");
		expect(result.meta.tokensUsed).toEqual({ input: 1000, output: 30 });
		expect(result.meta.cost).toBeCloseTo(0.000042, 9);
		expect(result.meta.decider).toMatchObject({
			decided: "action",
			confidence: 0.8,
			toolProbabilities: { set_priority: 0.9 },
		});
		expect(result.meta.decider?.fallbackReason).toBeUndefined();

		const [request] = deciderRequests;
		expect(request?.authorization).toBe("Bearer ts-key");
		expect(request?.body.model).toBe("jev-latest");
		expect(request?.body.state).toEqual({
			instructions: "Triage this ticket: Site is down!",
			history: [
				{ action: "reply", params: { message: "Looking" }, result: "sent", succeeded: true },
			],
		});
		expect(Object.keys(request?.body.questions as Body)).toEqual([
			"tool",
			"param:set_priority:level",
			"param:set_priority:notify",
		]);
	});

	it("takes the cost the route reports over the configured pricing", async () => {
		respondAsDecider = () =>
			Response.json({
				model: "jev-1.13.0",
				answers: {
					tool: answer("set_priority", 0.9),
					"param:set_priority:level": answer("high", 0.8),
					"param:set_priority:notify": answer("(unset)", 0.85),
				},
				usage: { input_tokens: 1000, output_tokens: 30, cost: 0.00003 },
			});
		const agent = createTestAgent({ minConfidence: 0.5 });

		const result = await agent.nextAction();

		expect(llmRequests).toHaveLength(0);
		expect(result.meta.decider?.reportedCost).toBeCloseTo(0.00003, 9);
		expect(result.meta.cost).toBeCloseTo(0.00003, 9);
	});

	it("narrows the LLM call to the chosen tool when its params are free-form", async () => {
		answerWith({ tool: answer("reply", 0.9) });

		const result = await createTestAgent().nextAction();

		expect(result.action).toEqual({ tool: "reply", params: { message: "On it" } });
		expect(llmToolEnum()).toEqual(["reply"]);
		expect(result.meta.model).toBe("gpt-4o");
		expect(result.meta.tokensUsed).toEqual({ input: 200, output: 25 });
		expect(result.meta.cost).toBeCloseTo(0.00075 + 0.000042, 9);
		expect(result.meta.decider).toMatchObject({ decided: "tool", confidence: 0.9 });
		expect(result.meta.decider?.fallbackReason).toBeUndefined();
	});

	it("hands the whole decision to the LLM when tool confidence is below the threshold", async () => {
		answerWith({
			tool: answer("close", 0.4),
		});

		const result = await createTestAgent({ minConfidence: 0.6 }).nextAction();

		expect(result.action.tool).toBe("reply");
		expect(llmToolEnum()).toEqual(["set_priority", "reply", "close"]);
		expect(result.meta.decider).toMatchObject({
			decided: "none",
			confidence: 0.4,
			fallbackReason: "low-confidence",
		});
	});

	it("keeps the tool but asks the LLM for params when param confidence is low", async () => {
		answerWith({
			tool: answer("set_priority", 0.9),
			"param:set_priority:level": answer("low", 0.3),
			"param:set_priority:notify": answer("true", 0.9),
		});
		llmAction = { tool: "set_priority", params: { level: "high", notify: null } };

		const result = await createTestAgent({ minConfidence: 0.6 }).nextAction();

		expect(result.action).toEqual({ tool: "set_priority", params: { level: "high" } });
		expect(llmToolEnum()).toEqual(["set_priority"]);
		expect(result.meta.decider).toMatchObject({
			decided: "tool",
			fallbackReason: "low-confidence",
		});
	});

	it("asks the LLM for params when closed-set answers fail the tool's Zod schema", async () => {
		const refined = tools.map((tool) =>
			tool.name === "set_priority"
				? {
						...tool,
						params: z
							.object({ level: z.enum(["low", "high"]), notify: z.boolean().optional() })
							.refine((p) => p.level !== "high" || p.notify === true),
					}
				: tool,
		);
		answerWith({
			tool: answer("set_priority"),
			"param:set_priority:level": answer("high"),
			"param:set_priority:notify": answer("false"),
		});
		llmAction = { tool: "set_priority", params: { level: "high", notify: true } };

		const result = await createTestAgent({ agentTools: refined }).nextAction();

		expect(result.action.params).toEqual({ level: "high", notify: true });
		expect(llmToolEnum()).toEqual(["set_priority"]);
		expect(result.meta.decider).toMatchObject({
			decided: "tool",
			fallbackReason: "invalid-output",
		});
	});

	it("falls back to the LLM when the decider returns an undeclared option", async () => {
		answerWith({ tool: answer("delete_everything") });

		const result = await createTestAgent().nextAction();

		expect(result.action.tool).toBe("reply");
		expect(result.meta.decider).toMatchObject({
			decided: "none",
			fallbackReason: "invalid-output",
		});
	});

	it("falls back to the LLM when the decider stays unavailable", async () => {
		respondAsDecider = () => new Response("overloaded", { status: 529 });

		const result = await createTestAgent().nextAction();

		expect(deciderRequests).toHaveLength(3);
		expect(result.action.tool).toBe("reply");
		expect(result.meta.decider).toMatchObject({
			decided: "none",
			fallbackReason: "unavailable",
			fallbackDetail: "HTTP 529: overloaded",
			tokensUsed: { input: 0, output: 0 },
		});
	});

	it("treats any 5xx as transient, not only the listed ones", async () => {
		respondAsDecider = () => new Response("gateway timeout", { status: 504 });

		const result = await createTestAgent().nextAction();

		expect(deciderRequests).toHaveLength(3);
		expect(result.action.tool).toBe("reply");
		expect(result.meta.decider?.fallbackReason).toBe("unavailable");
	});

	it("falls back to the LLM when a successful response is not JSON", async () => {
		respondAsDecider = () => new Response("<html>Bad gateway</html>", { status: 200 });

		const result = await createTestAgent().nextAction();

		expect(deciderRequests).toHaveLength(3);
		expect(result.action.tool).toBe("reply");
		expect(result.meta.decider?.fallbackReason).toBe("unavailable");
	});

	it("throws rather than hiding a rejected decider request", async () => {
		respondAsDecider = () => new Response("invalid api key", { status: 401 });

		await expect(createTestAgent().nextAction()).rejects.toThrow(ProviderError);
		expect(deciderRequests).toHaveLength(1);
		expect(llmRequests).toHaveLength(0);
	});

	it("resolves a lone parameterless tool without calling anything", async () => {
		const result = await createTestAgent({ agentTools: tools.slice(2) }).nextAction();

		expect(result.action).toEqual({ tool: "close", params: {} });
		expect(deciderRequests).toHaveLength(0);
		expect(llmRequests).toHaveLength(0);
		expect(result.meta.decider).toMatchObject({ decided: "action", confidence: 1 });
	});

	it("skips the decider for a lone free-form tool", async () => {
		const result = await createTestAgent({ agentTools: tools.slice(1, 2) }).nextAction();

		expect(deciderRequests).toHaveLength(0);
		expect(llmRequests).toHaveLength(1);
		expect(result.meta.decider).toBeUndefined();
	});

	it("offers state-built enums to the decider and skips optional free-form params", async () => {
		const assign: ToolDefinition<z.infer<typeof stateSchema>> = {
			name: "assign",
			description: "Assign the ticket to an engineer who is on call",
			params: (s) =>
				z.object({
					engineer: z.enum(s.ticket.includes("down") ? ["ana", "raj"] : ["lee"]),
					thoughts: z.string().optional(),
				}),
			validWhen: () => true,
		};
		answerWith({ tool: answer("assign"), "param:assign:engineer": answer("raj") });

		const result = await createTestAgent({
			omitOptionalFreeForm: true,
			agentTools: [assign, ...tools.slice(1)],
		}).nextAction();

		expect(result.action).toEqual({ tool: "assign", params: { engineer: "raj" } });
		expect(llmRequests).toHaveLength(0);
		const questions = deciderRequests[0]?.body.questions as Record<string, { criteria: Body }>;
		expect(Object.keys(questions["param:assign:engineer"]?.criteria ?? {})).toEqual(["ana", "raj"]);
	});

	it("validates LLM params against the state-built schema", async () => {
		const assign: ToolDefinition<z.infer<typeof stateSchema>> = {
			name: "assign",
			description: "Assign the ticket",
			params: () => z.object({ engineer: z.enum(["ana", "raj"]), note: z.string() }),
			validWhen: () => true,
		};
		answerWith({ tool: answer("assign") });
		llmAction = { tool: "assign", params: { engineer: "lee", note: "urgent" } };

		await expect(
			createTestAgent({ agentTools: [assign, ...tools.slice(1)] }).nextAction({ outputRetries: 0 }),
		).rejects.toThrow(OutputError);
	});

	it("settles the closed params of a tool that also has free text, and fixes them for the LLM", async () => {
		const report = {
			name: "report",
			description: "Report back",
			params: z.object({
				outcome: z.enum(["complete", "not_possible"]).describe("How it went"),
				reason: z.string(),
			}),
			validWhen: () => true,
		};
		answerWith({
			tool: answer("report", 0.9),
			"param:report:outcome": answer("not_possible", 0.85),
		});
		llmAction = { tool: "report", params: { outcome: "not_possible", reason: "No station here" } };
		const agent = createTestAgent({ minConfidence: 0.5, agentTools: [report, ...tools] });

		const result = await agent.nextAction();

		expect(result.action).toEqual({
			tool: "report",
			params: { outcome: "not_possible", reason: "No station here" },
		});
		expect(llmToolEnum()).toEqual(["report"]);
		const schema = JSON.stringify(llmRequests[0]?.response_format);
		expect(schema).toContain(
			'"outcome":{"type":"string","enum":["not_possible"],"description":"How it went"}',
		);
		expect(result.meta.decider).toMatchObject({
			decided: "tool",
			confidence: 0.85,
			settledParams: ["outcome"],
		});
		expect(Object.keys(deciderRequests[0]?.body.questions as Body)).toContain(
			"param:report:outcome",
		);
	});

	it("leaves a mixed tool's params to the LLM when its settled answer is unsure", async () => {
		const report = {
			name: "report",
			description: "Report back",
			params: z.object({ outcome: z.enum(["complete", "not_possible"]), reason: z.string() }),
			validWhen: () => true,
		};
		answerWith({
			tool: answer("report", 0.9),
			"param:report:outcome": answer("complete", 0.4),
		});
		llmAction = { tool: "report", params: { outcome: "not_possible", reason: "Nothing here" } };
		const agent = createTestAgent({ minConfidence: 0.5, agentTools: [report, ...tools] });

		const result = await agent.nextAction();

		expect(result.action.params).toEqual({ outcome: "not_possible", reason: "Nothing here" });
		expect(result.meta.decider).toMatchObject({ decided: "tool", confidence: 0.9 });
		expect(result.meta.decider?.settledParams).toBeUndefined();
	});

	it("includes the decider request in verbose output", async () => {
		answerWith({ tool: answer("close") });

		const result = (await createTestAgent().nextAction({ verbose: true })) as VerboseActionResult;

		expect(result.action).toEqual({ tool: "close", params: {} });
		expect(result.context.validTools).toEqual(["set_priority", "reply", "close"]);
		expect(result.context.deciderRequest).toEqual(deciderRequests[0]?.body);
	});
});
