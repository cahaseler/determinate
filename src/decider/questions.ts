import { OutputError } from "../errors";
import type { HistoryEntry } from "../types";
import { type ClosedParam, UNSET_OPTION } from "./closed-params";

export const TOOL_QUESTION = "tool";

export interface DeciderTool {
	name: string;
	description: string;
	/** Undefined when the tool has free-form params the decider cannot fill. */
	closedParams?: ClosedParam[];
	/** The closed params of a tool that also has free-form ones; the decider settles these and the LLM writes the rest. */
	partialParams?: ClosedParam[];
}

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string | null>;
}

export interface ChoiceAnswer {
	choice?: unknown;
	confidence?: unknown;
	probabilities?: Record<string, number>;
}

export interface Decision {
	tool: string;
	toolConfidence: number;
	toolProbabilities?: Record<string, number>;
	/** Undefined when the chosen tool has free-form params. */
	params?: Record<string, unknown>;
	/** Lowest confidence among the chosen tool's param answers; 1 when none were needed. */
	paramsConfidence: number;
	/** For a tool with free-form params: the closed ones the decider answered, and how surely. */
	settled?: { params: Record<string, unknown>; confidence: number };
}

/** Components are encoded so names containing ":" cannot make two params share an ID. */
const paramQuestionId = (tool: string, param: string): string =>
	`param:${encodeURIComponent(tool)}:${encodeURIComponent(param)}`;

const listOptions = ({ values, optional }: ClosedParam): string[] => [
	...Object.keys(values),
	...(optional ? [UNSET_OPTION] : []),
];

/** A param with a single admissible option needs no question. */
const hasAlternatives = (param: ClosedParam): boolean => listOptions(param).length > 1;

const askParam = (tool: DeciderTool, param: ClosedParam): ChoiceQuestion => ({
	type: "choice",
	instructions: [
		`Assuming the next action is "${tool.name}" (${tool.description}), what should its "${param.name}" parameter be?`,
		param.description,
	]
		.filter(Boolean)
		.join(" "),
	criteria: Object.fromEntries(
		listOptions(param).map((option) => [
			option,
			option === UNSET_OPTION ? "Leave this parameter out." : (param.labels[option] ?? null),
		]),
	),
});

export const DEFAULT_TOOL_QUESTION = "Which action should be taken next?";

const askTool = (tools: DeciderTool[], question: string): ChoiceQuestion => ({
	type: "choice",
	instructions: question,
	criteria: Object.fromEntries(tools.map(({ name, description }) => [name, description])),
});

export function buildQuestions(
	tools: DeciderTool[],
	{ question = DEFAULT_TOOL_QUESTION }: { question?: string } = {},
): Record<string, ChoiceQuestion> {
	const paramQuestions = tools.flatMap((tool) =>
		(tool.closedParams ?? tool.partialParams ?? [])
			.filter(hasAlternatives)
			.map((param) => [paramQuestionId(tool.name, param.name), askParam(tool, param)] as const),
	);
	return Object.fromEntries([
		...(tools.length > 1 ? [[TOOL_QUESTION, askTool(tools, question)] as const] : []),
		...paramQuestions,
	]);
}

/** State is whatever the consumer chose to show the model: its instructions, plus what has happened so far. */
export const buildState = ({
	instructions,
	history,
}: {
	instructions: string;
	history: HistoryEntry[];
}): Record<string, unknown> => ({
	instructions,
	history: history.map(({ tool, params, result, success }) => ({
		action: tool,
		params,
		result,
		succeeded: success !== false,
	})),
});

export function readChoice(
	answers: Record<string, ChoiceAnswer>,
	id: string,
	options: string[],
): { choice: string; confidence: number; probabilities?: Record<string, number> } {
	const { choice, confidence, probabilities } = answers[id] ?? {};
	if (typeof choice !== "string" || !options.includes(choice) || typeof confidence !== "number") {
		throw new OutputError(
			`Decider answer for "${id}" is not one of [${options.join(", ")}] with a numeric confidence`,
			JSON.stringify(answers[id] ?? null),
		);
	}
	return { choice, confidence, probabilities };
}

export function resolveDecision(
	answers: Record<string, ChoiceAnswer>,
	tools: DeciderTool[],
): Decision {
	const toolAnswer =
		tools.length > 1
			? readChoice(
					answers,
					TOOL_QUESTION,
					tools.map(({ name }) => name),
				)
			: { choice: tools[0]?.name ?? "", confidence: 1 };
	const tool = tools.find(({ name }) => name === toolAnswer.choice);
	const decision = {
		tool: toolAnswer.choice,
		toolConfidence: toolAnswer.confidence,
		toolProbabilities: toolAnswer.probabilities,
		paramsConfidence: 1,
	};
	const asked = tool?.closedParams ?? tool?.partialParams;
	if (!tool || !asked) return decision;

	const paramAnswers = asked.map((param) => ({
		param,
		...(hasAlternatives(param)
			? readChoice(answers, paramQuestionId(tool.name, param.name), listOptions(param))
			: { choice: listOptions(param)[0] ?? UNSET_OPTION, confidence: 1 }),
	}));
	const params = Object.fromEntries(
		paramAnswers
			.filter(({ choice }) => choice !== UNSET_OPTION)
			.map(({ param, choice }) => [param.name, param.values[choice]]),
	);
	const confidence = Math.min(1, ...paramAnswers.map((answer) => answer.confidence));
	return tool.closedParams
		? { ...decision, params, paramsConfidence: confidence }
		: { ...decision, settled: { params, confidence } };
}
