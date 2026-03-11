import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

interface ToolForSchema {
  name: string;
  description: string;
  params: z.ZodType;
}

export function generateActionSchema(
  tools: ToolForSchema[]
): Record<string, unknown> {
  if (tools.length === 0) {
    throw new Error("Cannot generate action schema with zero tools");
  }

  const toolNames = tools.map((t) => t.name);

  const paramBranches = tools.map((tool) => {
    const baseSchema = zodToJsonSchema(tool.params, {
      $refStrategy: "none",
    }) as Record<string, any>;

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

  const paramsProperty =
    paramBranches.length === 1
      ? paramBranches[0]
      : { anyOf: paramBranches };

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
