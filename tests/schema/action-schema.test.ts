import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { generateActionSchema } from "../../src/schema/action-schema";

interface ActionBranch {
	type: string;
	properties: {
		tool: { type: string; enum: string[] };
		params: { properties?: Record<string, unknown>; required?: string[] };
	};
	required: string[];
	additionalProperties: boolean;
}

describe("action schema generation", () => {
	const tools = [
		{
			name: "approve_order",
			description: "Approve a pending order",
			params: z.object({ note: z.string() }),
		},
		{
			name: "reject_order",
			description: "Reject a pending order",
			params: z.object({ reason: z.string() }),
		},
	];

	it("generates one top-level action branch per tool", () => {
		const schema = generateActionSchema(tools) as { anyOf: ActionBranch[] };
		expect(schema.anyOf).toHaveLength(2);
		expect(schema.anyOf.map((branch) => branch.properties.tool.enum[0])).toEqual([
			"approve_order",
			"reject_order",
		]);
	});

	it("couples each tool discriminator to only its own parameter schema", () => {
		const schema = generateActionSchema(tools) as { anyOf: ActionBranch[] };
		const approve = schema.anyOf.find(
			(branch) => branch.properties.tool.enum[0] === "approve_order",
		);
		const reject = schema.anyOf.find((branch) => branch.properties.tool.enum[0] === "reject_order");

		expect(approve?.properties.params.properties).toHaveProperty("note");
		expect(approve?.properties.params.properties).not.toHaveProperty("reason");
		expect(reject?.properties.params.properties).toHaveProperty("reason");
		expect(reject?.properties.params.properties).not.toHaveProperty("note");
	});

	it("makes every branch strict and requires tool and params", () => {
		const schema = generateActionSchema(tools) as { anyOf: ActionBranch[] };
		for (const branch of schema.anyOf) {
			expect(branch.type).toBe("object");
			expect(branch.additionalProperties).toBe(false);
			expect(branch.required).toEqual(["tool", "params"]);
		}
	});

	it("preserves required parameter fields inside each branch", () => {
		const schema = generateActionSchema(tools) as { anyOf: ActionBranch[] };
		expect(schema.anyOf[0].properties.params.required).toContain("note");
		expect(schema.anyOf[1].properties.params.required).toContain("reason");
	});

	it("uses a direct object schema for a single tool", () => {
		const schema = generateActionSchema([tools[0]]) as unknown as ActionBranch & {
			anyOf?: unknown;
		};
		expect(schema.anyOf).toBeUndefined();
		expect(schema.properties.tool.enum).toEqual(["approve_order"]);
		expect(schema.properties.params.properties).toHaveProperty("note");
	});

	it("throws on an empty tool list", () => {
		expect(() => generateActionSchema([])).toThrow();
	});
});
