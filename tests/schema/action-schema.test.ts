import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { generateActionSchema } from "../../src/schema/action-schema";

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
    const toolProp = (schema.properties as any).tool;
    expect(toolProp.enum).toContain("approve_order");
    expect(toolProp.enum).toContain("reject_order");
    expect(toolProp.enum).toHaveLength(2);
  });

  it("includes params with anyOf branches for multiple tools", () => {
    const schema = generateActionSchema(tools);
    const params = (schema.properties as any).params;
    expect(params.anyOf).toBeDefined();
    expect(params.anyOf).toHaveLength(2);
  });

  it("each anyOf branch includes a tool_name enum discriminant", () => {
    const schema = generateActionSchema(tools);
    const branches = (schema.properties as any).params.anyOf;
    // Should use single-value enum, not const
    for (const branch of branches) {
      expect(branch.properties.tool_name.type).toBe("string");
      expect(branch.properties.tool_name.enum).toBeDefined();
      expect(branch.properties.tool_name.enum).toHaveLength(1);
    }
    const toolNames = branches.map((b: any) => b.properties.tool_name.enum[0]);
    expect(toolNames).toContain("approve_order");
    expect(toolNames).toContain("reject_order");
  });

  it("sets additionalProperties to false on root and branches", () => {
    const schema = generateActionSchema(tools);
    expect(schema.additionalProperties).toBe(false);
    const branches = (schema.properties as any).params.anyOf;
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
    const toolProp = (schema.properties as any).tool;
    expect(toolProp.enum).toEqual(["approve_order"]);
    // Single tool: params is the schema directly, no anyOf
    const params = (schema.properties as any).params;
    expect(params.anyOf).toBeUndefined();
    expect(params.properties).toBeDefined();
  });

  it("throws on empty tools array", () => {
    expect(() => generateActionSchema([])).toThrow();
  });

  it("all branch properties are listed in required", () => {
    const schema = generateActionSchema(tools);
    const branches = (schema.properties as any).params.anyOf;
    for (const branch of branches) {
      const propNames = Object.keys(branch.properties);
      for (const name of propNames) {
        expect(branch.required).toContain(name);
      }
    }
  });
});
