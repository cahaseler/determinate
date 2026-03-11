import { BudgetExceededError } from "../errors";
import type { TokenBudgets } from "../types";
import type { Tokenizer } from "./tokenizer";

export interface SectionContents {
	instructions: string;
	history: string;
	tools: string;
}

export function enforceBudgets(
	sections: SectionContents,
	budgets: TokenBudgets,
	tokenizer: Tokenizer,
): Record<keyof TokenBudgets, number> {
	const counts: Record<string, number> = {};

	for (const key of ["instructions", "history", "tools"] as const) {
		const count = tokenizer.count(sections[key]);
		counts[key] = count;
		if (count > budgets[key]) {
			throw new BudgetExceededError(key, count, budgets[key]);
		}
	}

	return counts as Record<keyof TokenBudgets, number>;
}
