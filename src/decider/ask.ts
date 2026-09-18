import { ValidationError } from "../errors";
import type { DeciderConfig, TokenUsage } from "../types";
import { MAX_CHOICE_OPTIONS } from "./closed-params";
import { type ChoiceAnswer, type ChoiceQuestion, readChoice } from "./questions";
import { askTypeSafe, DEFAULT_DECIDER_MODEL } from "./typesafe";

/** One closed question: what to decide, and the options with a description each (or none). */
export interface Question {
	question: string;
	options: Record<string, string | null>;
}

export interface Answer {
	choice: string;
	/** How decisively the decider chose (0–1): relative to the other options, not a probability of being right. */
	confidence: number;
	probabilities?: Record<string, number>;
}

export interface AskMeta {
	model: string;
	tokensUsed: TokenUsage;
	latency: number;
	/** Present when `pricing` is configured. */
	cost?: number;
}

export interface AskResult<Q extends string> {
	answers: Record<Q, Answer>;
	meta: AskMeta;
}

export interface Decider {
	/** Several closed questions about one state, answered in parallel: one answer cannot depend on another. */
	ask<Q extends string>(input: {
		state: unknown;
		questions: Record<Q, Question>;
		signal?: AbortSignal;
	}): Promise<AskResult<Q>>;
	/** One closed question about one state. */
	choose(input: {
		state: unknown;
		question: string;
		options: Record<string, string | null>;
		signal?: AbortSignal;
	}): Promise<Answer & { meta: AskMeta }>;
}

const toChoiceQuestion = (id: string, { question, options }: Question): ChoiceQuestion => {
	const count = Object.keys(options).length;
	if (count < 2 || count > MAX_CHOICE_OPTIONS) {
		throw new ValidationError(
			`Question "${id}" has ${count} options; the decider chooses among 2 to ${MAX_CHOICE_OPTIONS}`,
		);
	}
	return { type: "choice", instructions: question, criteria: options };
};

const readAnswers = <Q extends string>(
	answers: Record<string, ChoiceAnswer>,
	questions: Record<Q, Question>,
): Record<Q, Answer> =>
	Object.fromEntries(
		(Object.entries(questions) as [Q, Question][]).map(([id, { options }]) => [
			id,
			readChoice(answers, id, Object.keys(options)),
		]),
	) as Record<Q, Answer>;

/**
 * The decider on its own, for any closed question: triage, a rating on a scale, a
 * yes/no gate, a pick among candidates the consumer assembled. The same model and
 * request shape `createAgent` uses for its tool decisions, without an action union
 * around it. Transient failures throw `DeciderUnavailableError` after a short retry;
 * rejected requests throw `ProviderError`; an answer outside the options throws
 * `OutputError`. Nothing falls back to an LLM here: the consumer decides what to do.
 */
export function createDecider(config: DeciderConfig): Decider {
	const model = config.model ?? DEFAULT_DECIDER_MODEL;

	const ask: Decider["ask"] = async ({ state, questions, signal }) => {
		const body = {
			state,
			model,
			questions: Object.fromEntries(
				(Object.entries(questions) as [string, Question][]).map(([id, question]) => [
					id,
					toChoiceQuestion(id, question),
				]),
			),
		};
		const start = performance.now();
		const response = await askTypeSafe({ config, body, signal });
		const { input, output } = response.tokensUsed;
		return {
			answers: readAnswers(response.answers, questions),
			meta: {
				model: response.model,
				tokensUsed: response.tokensUsed,
				latency: performance.now() - start,
				cost: config.pricing
					? (input * config.pricing.input + output * config.pricing.output) / 1_000_000
					: undefined,
			},
		};
	};

	return {
		ask,
		choose: async ({ state, question, options, signal }) => {
			const { answers, meta } = await ask({
				state,
				questions: { choice: { question, options } },
				signal,
			});
			return { ...answers.choice, meta };
		},
	};
}
