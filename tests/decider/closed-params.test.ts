import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { describeClosedParams, UNSET_OPTION } from "../../src/decider/closed-params";

describe("describeClosedParams", () => {
	it("describes enums, booleans, literals and literal unions", () => {
		const params = z.object({
			level: z.enum(["low", "high"]).describe("How urgent"),
			notify: z.boolean(),
			kind: z.literal("refund"),
			tier: z.union([z.literal(1), z.literal(2)]),
		});

		expect(describeClosedParams(params)).toEqual([
			{
				name: "level",
				description: "How urgent",
				optional: false,
				values: { low: "low", high: "high" },
			},
			{
				name: "notify",
				description: undefined,
				optional: false,
				values: { true: true, false: false },
			},
			{ name: "kind", description: undefined, optional: false, values: { refund: "refund" } },
			{ name: "tier", description: undefined, optional: false, values: { "1": 1, "2": 2 } },
		]);
	});

	it("treats a tool without params as closed", () => {
		expect(describeClosedParams(z.object({}))).toEqual([]);
	});

	it("marks optional and defaulted params as optional, and keeps null as a value", () => {
		const described = describeClosedParams(
			z.object({
				a: z.enum(["x", "y"]).optional(),
				b: z.enum(["x", "y"]).default("x"),
				c: z.enum(["x"]).nullable(),
			}),
		);

		expect(described?.map(({ optional }) => optional)).toEqual([true, true, false]);
		expect(described?.[2]?.values).toEqual({ x: "x", null: null });
	});

	it("returns undefined when any param is free-form", () => {
		expect(describeClosedParams(z.object({ note: z.string() }))).toBeUndefined();
		expect(describeClosedParams(z.object({ amount: z.number() }))).toBeUndefined();
		expect(
			describeClosedParams(z.object({ level: z.enum(["a"]), tags: z.array(z.enum(["a"])) })),
		).toBeUndefined();
		expect(describeClosedParams(z.object({ nested: z.object({}) }))).toBeUndefined();
	});

	it("returns undefined for open-ended objects and non-objects", () => {
		expect(describeClosedParams(z.record(z.string(), z.boolean()))).toBeUndefined();
		expect(describeClosedParams(z.looseObject({}))).toBeUndefined();
		expect(describeClosedParams(z.enum(["a", "b"]))).toBeUndefined();
	});

	it("returns undefined when option keys would be ambiguous or too many", () => {
		expect(
			describeClosedParams(z.object({ v: z.union([z.literal(1), z.literal("1")]) })),
		).toBeUndefined();
		expect(describeClosedParams(z.object({ v: z.enum([UNSET_OPTION, "a"]) }))).toBeUndefined();
		const wide = Array.from({ length: 256 }, (_, i) => `option_${i}`);
		expect(describeClosedParams(z.object({ v: z.enum(wide) }))).toBeUndefined();
	});

	it("returns undefined for schemas JSON Schema cannot represent", () => {
		expect(describeClosedParams(z.object({ when: z.date() }))).toBeUndefined();
	});

	it("drops optional free-form params only when asked to", () => {
		const params = z.object({
			target: z.enum(["a", "b"]),
			thoughts: z.string().optional(),
			retries: z.number().default(1),
		});

		expect(describeClosedParams(params)).toBeUndefined();
		expect(
			describeClosedParams(params, { omitOptionalFreeForm: true })?.map(({ name }) => name),
		).toEqual(["target"]);
	});

	it("never drops a required free-form param", () => {
		const params = z.object({ target: z.enum(["a", "b"]), message: z.string() });
		expect(describeClosedParams(params, { omitOptionalFreeForm: true })).toBeUndefined();
	});
});
