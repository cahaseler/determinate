import type { Tokenizer } from "./tokenizer";
import type { TokenBudgets } from "../types";
import { BudgetExceededError } from "../errors";

export interface SectionContents {
  instructions: string;
  state: string;
  history: string;
  tools: string;
}

export function enforceBudgets(
  sections: SectionContents,
  budgets: TokenBudgets,
  tokenizer: Tokenizer
): Record<keyof TokenBudgets, number> {
  const counts: Record<string, number> = {};

  for (const key of ["instructions", "state", "history", "tools"] as const) {
    const count = tokenizer.count(sections[key]);
    counts[key] = count;
    if (count > budgets[key]) {
      throw new BudgetExceededError(key, count, budgets[key]);
    }
  }

  return counts as Record<keyof TokenBudgets, number>;
}
