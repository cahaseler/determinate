import { OutputError } from "../errors";
import type { Action } from "../types";

export function parseActionFromJson(raw: string): Action {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new OutputError("Failed to parse response as JSON", raw);
	}

	const action = parsed as { tool?: string; params?: Record<string, unknown> };
	if (
		typeof action.tool !== "string" ||
		typeof action.params !== "object" ||
		action.params === null
	) {
		throw new OutputError("Response missing required 'tool' or 'params' fields", raw);
	}

	return { tool: action.tool, params: action.params as Record<string, unknown> };
}
