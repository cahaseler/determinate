import { z } from "zod";

interface ToolForSchema {
	name: string;
	description: string;
	params: z.ZodType;
}

interface JsonSchemaObject {
	properties?: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
}

export function generateActionSchema(tools: ToolForSchema[]): Record<string, unknown> {
	if (tools.length === 0) {
		throw new Error("Cannot generate action schema with zero tools");
	}

	const toolNames = tools.map((t) => t.name);

	const paramBranches = tools.map((tool) => {
		const baseSchema = z.toJSONSchema(tool.params) as JsonSchemaObject;

		return {
			type: "object",
			properties: {
				tool_name: { type: "string", enum: [tool.name] },
				...(baseSchema.properties ?? {}),
			},
			required: ["tool_name", ...(baseSchema.required ?? [])],
			additionalProperties: false,
		};
	});

	const paramsProperty = paramBranches.length === 1 ? paramBranches[0] : { anyOf: paramBranches };

	return {
		type: "object",
		properties: {
			tool: {
				type: "string",
				enum: toolNames,
			},
			params: paramsProperty,
		},
		required: ["tool", "params"],
		additionalProperties: false,
	};
}
