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
		return generateStrictRootSchema(actionBranches);
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

function generateStrictRootSchema(
	actionBranches: Array<Record<string, unknown>>,
): Record<string, unknown> {
	const toolNames: string[] = [];
	const variants = new Map<string, unknown[]>();
	for (const branch of actionBranches) {
		const properties = branch.properties as Record<string, JsonSchemaObject>;
		const tool = properties.tool?.enum as string[];
		toolNames.push(...tool);
		const params = properties.params?.properties ?? {};
		for (const [name, schema] of Object.entries(params)) {
			const existing = variants.get(name) ?? [];
			if (!existing.some((candidate) => JSON.stringify(candidate) === JSON.stringify(schema))) {
				existing.push(schema);
			}
			variants.set(name, existing);
		}
	}

	const mergedParams = Object.fromEntries(
		[...variants].map(([name, schemas]) => [
			name,
			makeNullable(schemas.length === 1 ? schemas[0] : { anyOf: schemas }),
		]),
	);
	return {
		type: "object",
		properties: {
			tool: { type: "string", enum: toolNames },
			params: {
				type: "object",
				properties: mergedParams,
				required: Object.keys(mergedParams),
				additionalProperties: false,
			},
		},
		required: ["tool", "params"],
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
		normalized[key] = normalizeStrictSchema(child);
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
