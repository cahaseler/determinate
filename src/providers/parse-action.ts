import { OutputError } from "../errors";
import type { Action } from "../types";

export function parseActionFromJson(raw: string): Action {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const dsmlAction = parseDeepSeekToolCall(raw);
		if (dsmlAction) return dsmlAction;
		throw new OutputError("Failed to parse response as JSON or a DeepSeek tool call", raw);
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

function parseDeepSeekToolCall(raw: string): Action | null {
	const invokePattern = /<｜DSML｜invoke\s+name="([^"]+)">([\s\S]*?)<\/｜DSML｜invoke>/g;
	const invokes = [...raw.matchAll(invokePattern)];
	if (invokes.length !== 1) return null;

	const tool = invokes[0]?.[1];
	const body = invokes[0]?.[2];
	if (!tool || body === undefined) return null;

	const params: Record<string, unknown> = {};
	const parameterPattern = /<｜DSML｜parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?>([\s\S]*?)<\/｜DSML｜parameter>/g;
	for (const match of body.matchAll(parameterPattern)) {
		const name = match[1];
		const stringValue = match[2];
		const rawValue = match[3]?.trim();
		if (!name || rawValue === undefined) return null;
		if (stringValue === "true") {
			params[name] = rawValue;
			continue;
		}
		try {
			params[name] = JSON.parse(rawValue);
		} catch {
			params[name] = rawValue;
		}
	}

	const unparsedBody = body.replace(parameterPattern, "").trim();
	if (unparsedBody) return null;
	return { tool, params };
}
