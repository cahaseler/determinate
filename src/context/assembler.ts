import { randomUUID } from "node:crypto";
import { NoValidToolsError } from "../errors";
import { generateActionSchema } from "../schema/action-schema";
import type { HistoryEntry, ProviderConfig, TokenBudgets, ToolDefinition } from "../types";
import { enforceBudgets } from "./budget";
import type { Tokenizer } from "./tokenizer";

interface AssembleInput<TState> {
	state: TState;
	tools: ToolDefinition<TState>[];
	history: HistoryEntry[];
	instructions: (state: TState) => string;
	budgets: TokenBudgets;
	tokenizer: Tokenizer;
	providerType: ProviderConfig["type"];
}

interface AssembledPayload {
	messages: unknown[];
	outputSchema: Record<string, unknown>;
	validTools: string[];
}

export function assembleContext<TState>(input: AssembleInput<TState>): AssembledPayload {
	const { state, tools, history, instructions, budgets, tokenizer, providerType } = input;

	// 1. Filter tools by validWhen
	const validTools = tools.filter((t) => t.validWhen(state));
	if (validTools.length === 0) {
		throw new NoValidToolsError();
	}

	// 2. Generate output schema
	const outputSchema = generateActionSchema(validTools);

	// 3. Build instructions text
	const instructionsText = instructions(state);
	const toolInstructions = validTools
		.filter((t) => t.instructions)
		.map((t) => `[${t.name}]: ${t.instructions}`)
		.join("\n");
	const fullInstructions = toolInstructions
		? `${instructionsText}\n\nTool-specific instructions:\n${toolInstructions}`
		: instructionsText;

	// 4. Build tool descriptions
	const toolDescriptions = validTools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

	// 5. Serialize state
	const stateText = JSON.stringify(state, null, 2);

	// 6. Build history messages (needed for accurate budget counting)
	const historyMessages: unknown[] = [];
	for (const entry of history) {
		const callId = randomUUID();

		if (providerType === "anthropic") {
			historyMessages.push({
				role: "assistant",
				content: [{ type: "tool_use", id: callId, name: entry.tool, input: entry.params }],
			});
			historyMessages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: callId,
						content: entry.result,
						is_error: entry.success === false,
					},
				],
			});
		} else {
			historyMessages.push({
				role: "assistant",
				tool_calls: [
					{
						id: callId,
						type: "function",
						function: { name: entry.tool, arguments: JSON.stringify(entry.params) },
					},
				],
			});
			historyMessages.push({
				role: "tool",
				tool_call_id: callId,
				content: entry.result,
			});
		}
	}

	// 7. Enforce budgets
	const historyText = historyMessages.length > 0 ? JSON.stringify(historyMessages) : "";
	enforceBudgets(
		{
			instructions: fullInstructions,
			state: stateText,
			history: historyText,
			tools: toolDescriptions,
		},
		budgets,
		tokenizer,
	);

	// 8. Build final messages
	const messages: unknown[] = [];
	messages.push({
		role: "system",
		content: `${fullInstructions}\n\nAvailable actions:\n${toolDescriptions}\n\nRespond with a JSON object choosing one action and its parameters.`,
	});
	messages.push(...historyMessages);
	messages.push({
		role: "user",
		content: `Current state:\n${stateText}\n\nChoose the next action.`,
	});

	return { messages, outputSchema, validTools: validTools.map((t) => t.name) };
}
