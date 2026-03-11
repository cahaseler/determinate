import { describe, expect, it } from "bun:test";
import { validateHistory } from "../../src/schema/history-schema";

describe("history validation", () => {
	it("accepts a valid history entry with all fields", () => {
		const entry = {
			tool: "approve_order",
			params: { note: "looks good" },
			result: "Order approved",
			success: true,
			timestamp: "2026-03-11T10:00:00Z",
		};
		expect(() => validateHistory([entry])).not.toThrow();
	});

	it("accepts entry with only required fields, defaults success to true", () => {
		const entry = {
			tool: "approve_order",
			params: { note: "ok" },
			result: "Done",
		};
		const validated = validateHistory([entry]);
		expect(validated[0].success).toBe(true);
	});

	it("accepts empty history array", () => {
		expect(() => validateHistory([])).not.toThrow();
	});

	it("rejects entry missing tool field", () => {
		const entry = { params: {}, result: "x" };
		expect(() => validateHistory([entry as any])).toThrow();
	});

	it("rejects entry with wrong type for result", () => {
		const entry = { tool: "x", params: {}, result: 42 };
		expect(() => validateHistory([entry as any])).toThrow();
	});

	it("rejects non-array input", () => {
		expect(() => validateHistory("not an array" as any)).toThrow();
	});
});
