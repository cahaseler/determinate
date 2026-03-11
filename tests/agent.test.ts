import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ValidationError } from "../src/errors";
import { createAgent } from "../src/index";

const stateSchema = z.object({
	status: z.enum(["pending", "approved"]),
	score: z.number(),
});

const baseConfig = {
	provider: {
		type: "openai" as const,
		model: "gpt-4o",
		apiKey: "test-key",
	},
	state: stateSchema,
	tools: [
		{
			name: "approve",
			description: "Approve",
			params: z.object({ note: z.string() }),
			validWhen: (s: z.infer<typeof stateSchema>) => s.status === "pending",
		},
	],
	instructions: () => "Process the item",
	context: {
		budgets: {
			instructions: 5000,
			history: 5000,
			tools: 5000,
		},
	},
};

describe("agent", () => {
	it("creates an agent instance", () => {
		const agent = createAgent(baseConfig);
		expect(agent).toBeDefined();
	});

	it("setState validates against schema", () => {
		const agent = createAgent(baseConfig);
		expect(() => agent.setState({ status: "pending", score: 0.5 })).not.toThrow();
	});

	it("setState rejects invalid state", () => {
		const agent = createAgent(baseConfig);
		expect(() =>
			agent.setState({ status: "invalid", score: 0.5 } as unknown as z.infer<typeof stateSchema>),
		).toThrow(ValidationError);
	});

	it("getState returns the current state", () => {
		const agent = createAgent(baseConfig);
		agent.setState({ status: "pending", score: 0.5 });
		const state = agent.getState();
		expect(state).toEqual({ status: "pending", score: 0.5 });
	});

	it("getState throws if state not set", () => {
		const agent = createAgent(baseConfig);
		expect(() => agent.getState()).toThrow();
	});

	it("setHistory validates format", () => {
		const agent = createAgent(baseConfig);
		expect(() =>
			agent.setHistory([{ tool: "approve", params: { note: "ok" }, result: "Done" }]),
		).not.toThrow();
	});

	it("setHistory rejects invalid format", () => {
		const agent = createAgent(baseConfig);
		expect(() =>
			agent.setHistory([{ bad: "data" }] as unknown as {
				tool: string;
				params: Record<string, unknown>;
				result: string;
			}[]),
		).toThrow(ValidationError);
	});

	it("getHistory returns current history", () => {
		const agent = createAgent(baseConfig);
		const history = [{ tool: "approve", params: { note: "ok" }, result: "Done" }];
		agent.setHistory(history);
		const result = agent.getHistory();
		expect(result[0].tool).toBe("approve");
		expect(result[0].success).toBe(true);
	});

	it("getHistory returns empty array if not set", () => {
		const agent = createAgent(baseConfig);
		expect(agent.getHistory()).toEqual([]);
	});

	it("nextAction throws if state not set", async () => {
		const agent = createAgent(baseConfig);
		await expect(agent.nextAction()).rejects.toThrow();
	});
});
