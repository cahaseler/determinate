import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { describeIssues } from "../../src/schema/issues";

const issuesOf = (schema: z.ZodType, value: unknown) => {
	const result = schema.safeParse(value);
	if (result.success) throw new Error("expected a failure");
	return result.error.issues;
};

describe("describeIssues", () => {
	it("names the options of a failed union of literals, with the param path", () => {
		const schema = z.object({
			id: z.union([z.literal("iron_ore").describe("Iron"), z.literal("copper_ore")]),
		});
		expect(describeIssues(issuesOf(schema, { id: "gold_ore" }))).toBe(
			'id: expected one of "iron_ore", "copper_ore"',
		);
	});

	it("includes an open branch of a union as a type", () => {
		const schema = z.object({
			quantity: z.union([z.literal("all"), z.literal("half"), z.number().int().positive()]),
		});
		expect(describeIssues(issuesOf(schema, { quantity: "lots" }))).toBe(
			'quantity: expected one of "all", "half", a number',
		);
	});

	it("keeps Zod's own message for other failures and joins several", () => {
		const schema = z.object({ side: z.enum(["buy", "sell"]), count: z.number() });
		expect(describeIssues(issuesOf(schema, { side: "hold", count: "many" }))).toBe(
			'side: Invalid option: expected one of "buy"|"sell"; count: Invalid input: expected number, received string',
		);
	});
});
