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

	const actionBranches = tools.map((tool) => {
		const baseSchema = z.toJSONSchema(tool.params) as JsonSchemaObject;

		return {
			type: "object",
			properties: {
				tool: { type: "string", enum: [tool.name] },
				params: baseSchema,
			},
			required: ["tool", "params"],
			additionalProperties: false,
		};
	});

	return actionBranches.length === 1 ? actionBranches[0]! : { anyOf: actionBranches };
}
