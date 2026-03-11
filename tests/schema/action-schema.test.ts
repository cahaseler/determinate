import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { generateActionSchema } from "../../src/schema/action-schema";

interface SchemaProperties {
	tool?: { enum?: string[] };
	params?: {
		anyOf?: Array<{
			properties: Record<string, { type?: string; enum?: string[] }>;
			required?: string[];
			additionalProperties?: boolean;
		}>;
		properties?: Record<string, unknown>;
	};
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

	it("generates a valid JSON schema object", () => {
		const schema = generateActionSchema(tools);
		expect(schema.type).toBe("object");
		expect(schema.properties).toBeDefined();
	});

	it("includes tool as a property with enum of tool names", () => {
		const schema = generateActionSchema(tools);
		const props = schema.properties as SchemaProperties;
		expect(props.tool?.enum).toContain("approve_order");
		expect(props.tool?.enum).toContain("reject_order");
		expect(props.tool?.enum).toHaveLength(2);
	});

	it("includes params with anyOf branches for multiple tools", () => {
		const schema = generateActionSchema(tools);
		const props = schema.properties as SchemaProperties;
		expect(props.params?.anyOf).toBeDefined();
		expect(props.params?.anyOf).toHaveLength(2);
	});

	it("each anyOf branch includes a tool_name enum discriminant", () => {
		const schema = generateActionSchema(tools);
		const props = schema.properties as SchemaProperties;
		const branches = props.params?.anyOf ?? [];
		expect(branches).toHaveLength(2);
		for (const branch of branches) {
			expect(branch.properties.tool_name.type).toBe("string");
			expect(branch.properties.tool_name.enum).toBeDefined();
			expect(branch.properties.tool_name.enum).toHaveLength(1);
		}
		const toolNames = branches.map((b) => b.properties.tool_name.enum?.[0]);
		expect(toolNames).toContain("approve_order");
		expect(toolNames).toContain("reject_order");
	});

	it("sets additionalProperties to false on root and branches", () => {
		const schema = generateActionSchema(tools);
		expect(schema.additionalProperties).toBe(false);
		const props = schema.properties as SchemaProperties;
		const branches = props.params?.anyOf ?? [];
		expect(branches).toHaveLength(2);
		for (const branch of branches) {
			expect(branch.additionalProperties).toBe(false);
		}
	});

	it("marks tool and params as required", () => {
		const schema = generateActionSchema(tools);
		expect(schema.required).toContain("tool");
		expect(schema.required).toContain("params");
	});

	it("handles single tool without anyOf wrapper", () => {
		const schema = generateActionSchema([tools[0]]);
		const props = schema.properties as SchemaProperties;
		expect(props.tool?.enum).toEqual(["approve_order"]);
		const params = props.params as { anyOf?: unknown; properties?: Record<string, unknown> };
		expect(params.anyOf).toBeUndefined();
		expect(params.properties).toBeDefined();
	});

	it("throws on empty tools array", () => {
		expect(() => generateActionSchema([])).toThrow();
	});

	it("all branch properties are listed in required", () => {
		const schema = generateActionSchema(tools);
		const props = schema.properties as SchemaProperties;
		const branches = props.params?.anyOf ?? [];
		expect(branches.length).toBeGreaterThan(0);
		for (const branch of branches) {
			const propNames = Object.keys(branch.properties);
			for (const name of propNames) {
				expect(branch.required).toContain(name);
			}
		}
	});
});
