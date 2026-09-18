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
	/** Choice option key -> what that value means, for options declared as described literals. */
	labels: Record<string, string>;
}

interface Option {
	value: unknown;
	label?: string;
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

const toOptions = (values: unknown[]): Option[] => values.map((value) => ({ value }));

/**
 * Every value the node admits, or undefined when the set is open (strings,
 * numbers, objects...). A described literal, as in
 * `z.literal("sol").describe("Sol Station")`, keeps its description as a label.
 */
function listOptions(node: JsonSchemaNode): Option[] | undefined {
	if ("const" in node) {
		return isPrimitive(node.const) ? [{ value: node.const, label: node.description }] : undefined;
	}
	if (node.enum) return node.enum.every(isPrimitive) ? toOptions(node.enum) : undefined;
	if (node.type === "boolean") return toOptions([true, false]);
	if (node.type === "null") return toOptions([null]);
	if (!node.anyOf) return undefined;
	const branches = node.anyOf.map(listOptions);
	return branches.every((branch) => branch !== undefined) ? branches.flat() : undefined;
}

function describeProperty(
	name: string,
	node: JsonSchemaNode,
	optional: boolean,
): ClosedParam | undefined {
	const options = listOptions(node);
	if (!options) return undefined;
	const keyed = Object.fromEntries(options.map(({ value }) => [String(value), value]));
	const optionCount = Object.keys(keyed).length + (optional ? 1 : 0);
	const isAmbiguous = Object.keys(keyed).length !== options.length || UNSET_OPTION in keyed;
	if (isAmbiguous || optionCount > MAX_CHOICE_OPTIONS) return undefined;
	const labels = Object.fromEntries(
		options.flatMap(({ value, label }) => (label ? [[String(value), label]] : [])),
	);
	return { name, description: node.description, optional, values: keyed, labels };
}

export interface ParamSurvey {
	/** The params a model that can only choose (not generate) can fill. */
	closed: ClosedParam[];
	/** True when `closed` covers every param the model has to supply. */
	complete: boolean;
}

/**
 * Sorts a tool's params into those that draw from a finite set of primitives
 * and those that need free-form output. Returns undefined when the params are
 * not a closed object. With `omitOptionalFreeForm`, optional params the model
 * cannot fill are dropped (left unset) rather than counted as free-form.
 */
export function surveyParams(
	params: z.ZodType,
	{ omitOptionalFreeForm = false }: { omitOptionalFreeForm?: boolean } = {},
): ParamSurvey | undefined {
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
	const described = Object.entries(root.properties ?? {}).flatMap(([name, node]) => {
		const optional = !required.has(name);
		const param = describeProperty(name, node, optional);
		return !param && optional && omitOptionalFreeForm ? [] : [param];
	});
	return {
		closed: described.filter((param): param is ClosedParam => param !== undefined),
		complete: described.every((param) => param !== undefined),
	};
}

/** The params of a tool a choose-only model can fill outright; undefined when any needs free-form output. */
export function describeClosedParams(
	params: z.ZodType,
	options: { omitOptionalFreeForm?: boolean } = {},
): ClosedParam[] | undefined {
	const survey = surveyParams(params, options);
	return survey?.complete ? survey.closed : undefined;
}
