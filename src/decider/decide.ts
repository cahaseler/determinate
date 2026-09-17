import { OutputError } from "../errors";
import type {
	Action,
	DeciderConfig,
	DeciderFallbackReason,
	DeciderMeta,
	HistoryEntry,
	ResolvedTool,
} from "../types";
import { describeClosedParams, MAX_CHOICE_OPTIONS } from "./closed-params";
import { buildQuestions, buildState, type Decision, resolveDecision } from "./questions";
import {
	askTypeSafe,
	DEFAULT_DECIDER_MODEL,
	type DeciderResponse,
	DeciderUnavailableError,
} from "./typesafe";

export interface DeciderOutcome {
	meta: DeciderMeta;
	request: Record<string, unknown>;
	/** A complete, validated action. No LLM call is needed. */
	action?: Action;
	/** The chosen tool, when the LLM still has to fill its params. */
	tool?: string;
}

interface ConsultInput<TState> {
	config: DeciderConfig;
	/** Tools that passed validWhen. */
	tools: ResolvedTool<TState>[];
	instructions: string;
	history: HistoryEntry[];
	signal?: AbortSignal;
}

/** Failures the LLM can cover for. Anything else (bad credentials, aborts) propagates. */
function explainFailure(err: unknown): DeciderFallbackReason | undefined {
	if (err instanceof DeciderUnavailableError) return "unavailable";
	if (err instanceof OutputError) return "invalid-output";
	return undefined;
}

/** Settles how much of the decision to trust: the whole action, just the tool, or nothing. */
function judgeDecision<TState>(
	decision: Decision,
	tools: ResolvedTool<TState>[],
	minConfidence: number,
): Pick<DeciderMeta, "decided" | "confidence" | "fallbackReason"> & { action?: Action } {
	const { tool, toolConfidence, params, paramsConfidence } = decision;
	if (toolConfidence < minConfidence) {
		return { decided: "none", confidence: toolConfidence, fallbackReason: "low-confidence" };
	}
	if (!params) return { decided: "tool", confidence: toolConfidence };
	if (paramsConfidence < minConfidence) {
		return { decided: "tool", confidence: toolConfidence, fallbackReason: "low-confidence" };
	}
	// Closed-set answers still have to satisfy the authoritative Zod schema (refinements, defaults).
	const parsed = tools.find(({ name }) => name === tool)?.params.safeParse(params);
	if (!parsed?.success) {
		return { decided: "tool", confidence: toolConfidence, fallbackReason: "invalid-output" };
	}
	return {
		decided: "action",
		confidence: Math.min(toolConfidence, paramsConfidence),
		action: { tool, params: parsed.data as Record<string, unknown> },
	};
}

/**
 * Asks the decider for the next action. Returns undefined when it has nothing
 * to contribute: a lone tool with free-form params, or more tools than one
 * Choice question can hold.
 */
export async function consultDecider<TState>({
	config,
	tools,
	instructions,
	history,
	signal,
}: ConsultInput<TState>): Promise<DeciderOutcome | undefined> {
	const deciderTools = tools.map(({ name, description, params }) => ({
		name,
		description,
		closedParams: describeClosedParams(params, config),
	}));
	const question = typeof config.question === "function" ? config.question() : config.question;
	const questions = buildQuestions(deciderTools, { question });
	const isForced = Object.keys(questions).length === 0;
	if (tools.length > MAX_CHOICE_OPTIONS || (isForced && !deciderTools[0]?.closedParams)) {
		return undefined;
	}

	const model = config.model ?? DEFAULT_DECIDER_MODEL;
	const request = { state: buildState({ instructions, history }), model, questions };
	const unanswered: DeciderResponse = { answers: {}, tokensUsed: { input: 0, output: 0 }, model };
	const start = performance.now();
	let response = unanswered;

	try {
		// One valid tool whose params each admit one value leaves nothing to ask.
		response = isForced ? unanswered : await askTypeSafe({ config, body: request, signal });
		const decision = resolveDecision(response.answers, deciderTools);
		const { action, ...judged } = judgeDecision(decision, tools, config.minConfidence ?? 0);
		return {
			request,
			action,
			tool: judged.decided === "tool" ? decision.tool : undefined,
			meta: {
				...judged,
				model: response.model,
				tokensUsed: response.tokensUsed,
				latency: performance.now() - start,
				toolProbabilities: decision.toolProbabilities,
			},
		};
	} catch (err) {
		const fallbackReason = explainFailure(err);
		if (!fallbackReason || signal?.aborted) throw err;
		return {
			request,
			meta: {
				decided: "none",
				model: response.model,
				tokensUsed: response.tokensUsed,
				latency: performance.now() - start,
				fallbackReason,
			},
		};
	}
}
