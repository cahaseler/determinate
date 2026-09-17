import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { describeClosedParams, UNSET_OPTION } from "../../src/decider/closed-params";
import {
	buildQuestions,
	buildState,
	type DeciderTool,
	resolveDecision,
} from "../../src/decider/questions";
import { OutputError } from "../../src/errors";

const describeTool = (name: string, description: string, params: z.ZodType): DeciderTool => ({
	name,
	description,
	closedParams: describeClosedParams(params),
});

const tools = [
	describeTool(
		"set_priority",
		"Set the ticket priority",
		z.object({
			level: z.enum(["low", "high"]).describe("How urgent the ticket is."),
			kind: z.literal("ticket"),
			notify: z.boolean().optional(),
		}),
	),
	describeTool("reply", "Reply to the customer", z.object({ message: z.string() })),
	describeTool("close", "Close the ticket", z.object({})),
];

describe("buildQuestions", () => {
	it("asks for the tool and for each closed param that has alternatives", () => {
		const questions = buildQuestions(tools);

		expect(Object.keys(questions)).toEqual([
			"tool",
			"param:set_priority:level",
			"param:set_priority:notify",
		]);
		expect(questions.tool?.criteria).toEqual({
			set_priority: "Set the ticket priority",
			reply: "Reply to the customer",
			close: "Close the ticket",
		});
		expect(questions["param:set_priority:level"]?.instructions).toBe(
			'Assuming the next action is "set_priority" (Set the ticket priority), what should its "level" parameter be? How urgent the ticket is.',
		);
		expect(Object.keys(questions["param:set_priority:notify"]?.criteria ?? {})).toEqual([
			"true",
			"false",
			UNSET_OPTION,
		]);
	});

	it("skips the tool question when only one tool is valid", () => {
		expect(Object.keys(buildQuestions(tools.slice(0, 1)))).toEqual([
			"param:set_priority:level",
			"param:set_priority:notify",
		]);
		expect(buildQuestions(tools.slice(2))).toEqual({});
	});
});

describe("buildState", () => {
	it("carries the instructions and history", () => {
		expect(
			buildState({
				instructions: "Triage the ticket",
				history: [{ tool: "reply", params: { message: "hi" }, result: "sent", success: false }],
			}),
		).toEqual({
			instructions: "Triage the ticket",
			history: [{ action: "reply", params: { message: "hi" }, result: "sent", succeeded: false }],
		});
	});
});

describe("resolveDecision", () => {
	const answers = {
		tool: { choice: "set_priority", confidence: 0.9, probabilities: { set_priority: 0.9 } },
		"param:set_priority:level": { choice: "high", confidence: 0.8 },
		"param:set_priority:notify": { choice: UNSET_OPTION, confidence: 0.7 },
	};

	it("maps answers back to typed params, filling single-valued params and omitting unset ones", () => {
		expect(resolveDecision(answers, tools)).toEqual({
			tool: "set_priority",
			toolConfidence: 0.9,
			toolProbabilities: { set_priority: 0.9 },
			params: { level: "high", kind: "ticket" },
			paramsConfidence: 0.7,
		});
	});

	it("maps option keys back to non-string values", () => {
		const decision = resolveDecision(
			{ ...answers, "param:set_priority:notify": { choice: "true", confidence: 1 } },
			tools,
		);
		expect(decision.params?.notify).toBe(true);
	});

	it("leaves params undefined when the chosen tool is free-form", () => {
		const decision = resolveDecision({ tool: { choice: "reply", confidence: 0.6 } }, tools);
		expect(decision.params).toBeUndefined();
		expect(decision.paramsConfidence).toBe(1);
	});

	it("resolves a lone tool without a tool answer", () => {
		expect(resolveDecision({}, tools.slice(2))).toMatchObject({
			tool: "close",
			toolConfidence: 1,
			params: {},
		});
	});

	it("rejects answers outside the declared options", () => {
		expect(() => resolveDecision({ tool: { choice: "delete", confidence: 1 } }, tools)).toThrow(
			OutputError,
		);
		expect(() =>
			resolveDecision({ tool: { choice: "set_priority", confidence: 1 } }, tools),
		).toThrow(OutputError);
		expect(() => resolveDecision({ tool: { choice: "close" } }, tools)).toThrow(OutputError);
	});
});
