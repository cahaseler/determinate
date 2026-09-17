import { z } from "zod";

interface ToolForSchema {
	name: string;
	description: string;
	params: z.ZodType;
}

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
	[key: string]: unknown;
}

export function generateActionSchema(
	tools: ToolForSchema[],
	options: { strictRootObject?: boolean; limitedNumericKeywords?: boolean } = {},
): Record<string, unknown> {
	if (tools.length === 0) {
		throw new Error("Cannot generate action schema with zero tools");
	}

	const actionBranches = tools.map((tool) => {
		let baseSchema = normalizeStrictSchema(
			z.toJSONSchema(tool.params) as JsonSchemaObject,
		) as JsonSchemaObject;
		if (options.limitedNumericKeywords) {
			baseSchema = stripNumericConstraints(baseSchema) as JsonSchemaObject;
		}
		if (options.strictRootObject) {
			baseSchema = stripDynamicObjectSchemas(baseSchema) as JsonSchemaObject;
		}

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

	const firstBranch = actionBranches[0];
	if (!firstBranch) {
		throw new Error("Cannot generate action schema with zero tools");
	}
	if (options.strictRootObject && actionBranches.length > 1) {
		return nestUnionUnderRoot(actionBranches);
	}
	return actionBranches.length === 1 ? firstBranch : { anyOf: actionBranches };
}

function stripDynamicObjectSchemas(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripDynamicObjectSchemas);
	if (!value || typeof value !== "object") return value;
	const schema = Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "propertyNames")
			.map(([key, child]) => [key, stripDynamicObjectSchemas(child)]),
	) as JsonSchemaObject;
	if (schema.type === "object" && !schema.properties && schema.additionalProperties !== false) {
		schema.properties = {};
		schema.required = [];
		schema.additionalProperties = false;
	}
	return schema;
}

function stripNumericConstraints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripNumericConstraints);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(
				([key]) =>
					!["exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum", "multipleOf"].includes(
						key,
					),
			)
			.map(([key, child]) => [key, stripNumericConstraints(child)]),
	);
}

/**
 * OpenAI rejects a union at the schema root but accepts one under a property,
 * so the coupled branches move one level down. `parseActionFromJson` unwraps
 * the result. Each tool keeps its own params and its own required fields.
 */
function nestUnionUnderRoot(
	actionBranches: Array<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		type: "object",
		properties: { action: { anyOf: actionBranches } },
		required: ["action"],
		additionalProperties: false,
	};
}

/**
 * Strict structured-output providers require every object property to be
 * listed in `required`. Preserve optional semantics by making properties that
 * were optional in the source schema nullable; validation removes those null
 * placeholders before applying the original Zod schema.
 */
function normalizeStrictSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeStrictSchema);
	if (!value || typeof value !== "object") return value;

	const schema = value as JsonSchemaObject;
	const normalized: JsonSchemaObject = {};
	for (const [key, child] of Object.entries(schema)) {
		// `const` is unsound in vLLM's xgrammar; a single-value enum means the same everywhere.
		if (key === "const") normalized.enum = [child];
		else normalized[key] = normalizeStrictSchema(child);
	}

	if (schema.properties) {
		const originallyRequired = new Set(schema.required ?? []);
		const properties: Record<string, unknown> = {};
		for (const [name, child] of Object.entries(normalized.properties ?? {})) {
			properties[name] = originallyRequired.has(name) ? child : makeNullable(child);
		}
		normalized.properties = properties;
		normalized.required = Object.keys(properties);
		normalized.additionalProperties = false;
	}

	return normalized;
}

function makeNullable(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { anyOf: [value, { type: "null" }] };
	}
	const schema = value as JsonSchemaObject;
	if (Array.isArray(schema.type) && schema.type.includes("null")) return schema;
	return { anyOf: [schema, { type: "null" }] };
}
