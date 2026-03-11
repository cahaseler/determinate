import { describe, expect, it } from "bun:test";
import { enforceBudgets } from "../../src/context/budget";
import type { Tokenizer } from "../../src/context/tokenizer";
import { BudgetExceededError } from "../../src/errors";
import type { TokenBudgets } from "../../src/types";

const mockTokenizer: Tokenizer = {
	count: (input) => {
		const str = typeof input === "string" ? input : JSON.stringify(input);
		return str.length;
	},
};

describe("budget enforcement", () => {
	const budgets: TokenBudgets = {
		instructions: 100,
		history: 30,
		tools: 40,
	};

	it("passes when all sections are within budget", () => {
		const sections = {
			instructions: "a".repeat(50),
			history: "c".repeat(20),
			tools: "d".repeat(25),
		};
		expect(() => enforceBudgets(sections, budgets, mockTokenizer)).not.toThrow();
	});

	it("throws BudgetExceededError when instructions exceed budget", () => {
		const sections = {
			instructions: "a".repeat(150),
			history: "c".repeat(10),
			tools: "d".repeat(10),
		};
		try {
			enforceBudgets(sections, budgets, mockTokenizer);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(BudgetExceededError);
			expect((err as BudgetExceededError).section).toBe("instructions");
			expect((err as BudgetExceededError).actual).toBe(150);
			expect((err as BudgetExceededError).budget).toBe(100);
		}
	});

	it("throws for the first section that exceeds budget", () => {
		const sections = {
			instructions: "a".repeat(200),
			history: "c".repeat(10),
			tools: "d".repeat(10),
		};
		try {
			enforceBudgets(sections, budgets, mockTokenizer);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(BudgetExceededError);
			expect((err as BudgetExceededError).section).toBeDefined();
		}
	});

	it("returns token counts for all sections", () => {
		const sections = {
			instructions: "a".repeat(50),
			history: "c".repeat(20),
			tools: "d".repeat(25),
		};
		const counts = enforceBudgets(sections, budgets, mockTokenizer);
		expect(counts.instructions).toBe(50);
		expect(counts.history).toBe(20);
		expect(counts.tools).toBe(25);
	});
});
