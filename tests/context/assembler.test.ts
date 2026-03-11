import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { assembleContext } from "../../src/context/assembler";
import type { Tokenizer } from "../../src/context/tokenizer";
import { BudgetExceededError, NoValidToolsError } from "../../src/errors";
import type { HistoryEntry, TokenBudgets, ToolDefinition } from "../../src/types";

const mockTokenizer: Tokenizer = {
	count: (input) => {
		const str = typeof input === "string" ? input : JSON.stringify(input);
		return str.length;
	},
};

const stateSchema = z.object({
	status: z.enum(["pending", "approved"]),
	score: z.number(),
});

type TestState = z.infer<typeof stateSchema>;

const tools: ToolDefinition<TestState>[] = [
	{
		name: "approve",
		description: "Approve the item",
		params: z.object({ note: z.string() }),
		validWhen: (s) => s.status === "pending" && s.score < 0.7,
	},
	{
		name: "reject",
		description: "Reject the item",
		params: z.object({ reason: z.string() }),
		validWhen: (s) => s.status === "pending" && s.score >= 0.7,
	},
	{
		name: "ship",
		description: "Ship the item",
		params: z.object({ carrier: z.string() }),
		validWhen: (s) => s.status === "approved",
	},
];

const bigBudgets: TokenBudgets = {
	instructions: 10000,
	state: 10000,
	history: 10000,
	tools: 10000,
};

describe("context assembler", () => {
	it("filters tools by validWhen and returns valid tool names", () => {
		const result = assembleContext({
			state: { status: "pending", score: 0.3 },
			tools,
			history: [],
			instructions: () => "Do your job",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		expect(result.validTools).toEqual(["approve"]);
	});

	it("includes instructions in system message", () => {
		const result = assembleContext({
			state: { status: "pending", score: 0.3 },
			tools,
			history: [],
			instructions: (s) => `Process item with score ${s.score}`,
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		const systemMsg = result.messages.find((m: any) => m.role === "system") as any;
		expect(systemMsg.content).toContain("0.3");
	});

	it("includes state in user message", () => {
		const result = assembleContext({
			state: { status: "pending", score: 0.3 },
			tools,
			history: [],
			instructions: () => "x",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		const userMsg = result.messages.find((m: any) => m.role === "user") as any;
		expect(userMsg.content).toContain("pending");
		expect(userMsg.content).toContain("0.3");
	});

	it("throws NoValidToolsError when no tools match", () => {
		expect(() =>
			assembleContext({
				state: { status: "approved", score: 0.3 },
				tools: [tools[0], tools[1]],
				history: [],
				instructions: () => "x",
				budgets: bigBudgets,
				tokenizer: mockTokenizer,
				providerType: "openai",
			}),
		).toThrow(NoValidToolsError);
	});

	it("formats history as tool-calling messages for openai", () => {
		const history: HistoryEntry[] = [
			{ tool: "approve", params: { note: "ok" }, result: "Approved", success: true },
		];
		const result = assembleContext({
			state: { status: "approved", score: 0.3 },
			tools,
			history,
			instructions: () => "x",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		const assistantMsg = result.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
		const toolMsg = result.messages.find((m: any) => m.role === "tool");
		expect(assistantMsg).toBeDefined();
		expect(toolMsg).toBeDefined();
	});

	it("formats history as tool-calling messages for anthropic", () => {
		const history: HistoryEntry[] = [
			{ tool: "approve", params: { note: "ok" }, result: "Approved", success: true },
		];
		const result = assembleContext({
			state: { status: "approved", score: 0.3 },
			tools,
			history,
			instructions: () => "x",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "anthropic",
		});
		const assistantMsg = result.messages.find(
			(m: any) => m.role === "assistant" && Array.isArray(m.content),
		) as any;
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg.content[0].type).toBe("tool_use");
		const userResultMsg = result.messages.find(
			(m: any) =>
				m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
		);
		expect(userResultMsg).toBeDefined();
	});

	it("throws BudgetExceededError when a section is too large", () => {
		expect(() =>
			assembleContext({
				state: { status: "pending", score: 0.3 },
				tools,
				history: [],
				instructions: () => "x".repeat(100),
				budgets: { ...bigBudgets, instructions: 10 },
				tokenizer: mockTokenizer,
				providerType: "openai",
			}),
		).toThrow(BudgetExceededError);
	});

	it("generates an output schema from valid tools", () => {
		const result = assembleContext({
			state: { status: "pending", score: 0.3 },
			tools,
			history: [],
			instructions: () => "x",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		expect(result.outputSchema).toBeDefined();
		expect((result.outputSchema as any).properties?.tool).toBeDefined();
		expect((result.outputSchema as any).properties?.params).toBeDefined();
	});

	it("includes per-tool instructions for valid tools", () => {
		const toolsWithInstructions: ToolDefinition<TestState>[] = [
			{
				name: "approve",
				description: "Approve",
				params: z.object({ note: z.string() }),
				validWhen: (s) => s.status === "pending",
				instructions: "Only approve if compliant with policy X",
			},
		];
		const result = assembleContext({
			state: { status: "pending", score: 0.3 },
			tools: toolsWithInstructions,
			history: [],
			instructions: () => "Base instructions",
			budgets: bigBudgets,
			tokenizer: mockTokenizer,
			providerType: "openai",
		});
		const systemMsg = result.messages.find((m: any) => m.role === "system") as any;
		expect(systemMsg.content).toContain("policy X");
	});
});
