import { z } from "zod";
import { ValidationError } from "../errors";

export const historyEntrySchema = z.object({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()),
  result: z.string(),
  success: z.boolean().default(true),
  timestamp: z.string().optional(),
});

export type ValidatedHistoryEntry = z.output<typeof historyEntrySchema>;

const historyArraySchema = z.array(historyEntrySchema);

export function validateHistory(input: unknown): ValidatedHistoryEntry[] {
  const result = historyArraySchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      `Invalid history format: ${result.error.issues.map((i) => i.message).join(", ")}`
    );
  }
  return result.data;
}
