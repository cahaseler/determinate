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

	it("makes optional parameters required but nullable for strict providers", () => {
		const schema = generateActionSchema([
			{
				name: "travel",
				description: "Travel",
				params: z.object({
					destination: z.string(),
					thoughts: z.string().optional(),
				}),
			},
		]) as unknown as ActionBranch;
		const params = schema.properties.params;
		expect(params.required).toEqual(["destination", "thoughts"]);
		expect(params.properties?.thoughts).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("includes null in optional enum values", () => {
		const schema = generateActionSchema([
			{
				name: "transfer",
				description: "Transfer",
				params: z.object({ target: z.enum(["self", "faction"]).optional() }),
			},
		]) as unknown as ActionBranch;
		expect(schema.properties.params.properties?.target).toEqual({
			anyOf: [{ type: "string", enum: ["self", "faction"] }, { type: "null" }],
		});
	});

	it("uses a direct object schema for a single tool", () => {
		const schema = generateActionSchema([tools[0]]) as unknown as ActionBranch & {
			anyOf?: unknown;
		};
		expect(schema.anyOf).toBeUndefined();
		expect(schema.properties.tool.enum).toEqual(["approve_order"]);
		expect(schema.properties.params.properties).toHaveProperty("note");
	});

	it("uses an OpenAI-compatible strict root object when requested", () => {
		const schema = generateActionSchema(tools, { strictRootObject: true }) as {
			type: string;
			anyOf?: unknown;
			properties: {
				tool: { enum: string[] };
				params: { properties: Record<string, unknown>; required: string[] };
			};
		};
		expect(schema.type).toBe("object");
		expect(schema.anyOf).toBeUndefined();
		expect(schema.properties.tool.enum).toEqual(["approve_order", "reject_order"]);
		expect(schema.properties.params.required).toEqual(["note", "reason"]);
		expect(schema.properties.params.properties.note).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("strips unsupported numeric constraints for limited providers", () => {
		const schema = generateActionSchema(
			[
				{
					name: "buy",
					description: "Buy",
					params: z.object({ quantity: z.number().positive().max(10) }),
				},
			],
			{ limitedNumericKeywords: true },
		) as unknown as ActionBranch;
		const quantity = schema.properties.params.properties?.quantity as Record<string, unknown>;
		expect(quantity.exclusiveMinimum).toBeUndefined();
		expect(quantity.maximum).toBeUndefined();
		expect(quantity.type).toBe("number");
	});

	it("removes dynamic map keywords from OpenAI strict schemas", () => {
		const schema = generateActionSchema(
			[
				{
					name: "bulk",
					description: "Bulk",
					params: z.object({ jobs: z.array(z.record(z.string(), z.unknown())).optional() }),
				},
				tools[0],
			],
			{ strictRootObject: true },
		) as {
			properties: { params: { properties: Record<string, unknown> } };
		};
		const serialized = JSON.stringify(schema);
		expect(serialized).not.toContain("propertyNames");
		expect(serialized).not.toContain('"additionalProperties":{}');
	});

	it("throws on an empty tool list", () => {
		expect(() => generateActionSchema([])).toThrow();
	});
});
