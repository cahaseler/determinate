import { describe, expect, it } from "bun:test";
import { estimateCost } from "../../src/providers/pricing";

describe("cost estimation", () => {
	it("estimates cost for a known OpenAI model", () => {
		const cost = estimateCost("gpt-4o", { input: 1000, output: 500 });
		expect(cost).toBeDefined();
		expect(cost).toBeGreaterThan(0);
	});

	it("estimates cost for a known Anthropic model", () => {
		const cost = estimateCost("claude-sonnet-4-5-20250514", {
			input: 1000,
			output: 500,
		});
		expect(cost).toBeDefined();
		expect(cost).toBeGreaterThan(0);
	});

	it("returns undefined for unknown models", () => {
		const cost = estimateCost("unknown-model-xyz", { input: 1000, output: 500 });
		expect(cost).toBeUndefined();
	});

	it("returns undefined for local models", () => {
		const cost = estimateCost("my-local-llama", { input: 1000, output: 500 });
		expect(cost).toBeUndefined();
	});

	it("scales linearly with token count", () => {
		const cost1 = estimateCost("gpt-4o", { input: 1000, output: 0 });
		const cost2 = estimateCost("gpt-4o", { input: 2000, output: 0 });
		expect(cost2).toBe((cost1 as number) * 2);
	});
});
