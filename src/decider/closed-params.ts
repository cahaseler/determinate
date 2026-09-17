import { z } from "zod";

/** Choice option offered for optional params, meaning "leave this param out". */
export const UNSET_OPTION = "(unset)";

/** A Choice question may declare at most this many options. */
export const MAX_CHOICE_OPTIONS = 255;

export interface ClosedParam {
	name: string;
	description?: string;
	optional: boolean;
	/** Choice option key -> the param value it stands for. */
	values: Record<string, unknown>;
}

interface JsonSchemaNode {
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	anyOf?: JsonSchemaNode[];
	description?: string;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	additionalProperties?: unknown;
}

const isPrimitive = (value: unknown): boolean =>
	value === null || ["string", "number", "boolean"].includes(typeof value);

/** Every value the node admits, or undefined when the set is open (strings, numbers, objects...). */
function listValues(node: JsonSchemaNode): unknown[] | undefined {
	if ("const" in node) return isPrimitive(node.const) ? [node.const] : undefined;
	if (node.enum) return node.enum.every(isPrimitive) ? node.enum : undefined;
	if (node.type === "boolean") return [true, false];
	if (node.type === "null") return [null];
	if (!node.anyOf) return undefined;
	const branches = node.anyOf.map(listValues);
	return branches.every((branch) => branch !== undefined) ? branches.flat() : undefined;
}

function describeProperty(
	name: string,
	node: JsonSchemaNode,
	optional: boolean,
): ClosedParam | undefined {
	const values = listValues(node);
	if (!values) return undefined;
	const keyed = Object.fromEntries(values.map((value) => [String(value), value]));
	const optionCount = Object.keys(keyed).length + (optional ? 1 : 0);
	const isAmbiguous = Object.keys(keyed).length !== values.length || UNSET_OPTION in keyed;
	if (isAmbiguous || optionCount > MAX_CHOICE_OPTIONS) return undefined;
	return { name, description: node.description, optional, values: keyed };
}

/**
 * Describes a tool's params when every one of them draws from a finite set of
 * primitives, so a model that can only choose (not generate) can fill them.
 * Returns undefined when any param needs free-form output.
 */
export function describeClosedParams(params: z.ZodType): ClosedParam[] | undefined {
	let root: JsonSchemaNode;
	try {
		// Input mode keeps defaulted fields optional, so leaving one unset lets Zod apply the default.
		root = z.toJSONSchema(params, { io: "input" }) as JsonSchemaNode;
	} catch {
		return undefined;
	}
	const isClosedObject =
		root.type === "object" &&
		(root.additionalProperties === undefined || root.additionalProperties === false);
	if (!isClosedObject) return undefined;

	const required = new Set(root.required ?? []);
	const described = Object.entries(root.properties ?? {}).map(([name, node]) =>
		describeProperty(name, node, !required.has(name)),
	);
	return described.every((param) => param !== undefined) ? described : undefined;
}
