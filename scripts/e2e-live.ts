#!/usr/bin/env bun
/**
 * Live end-to-end tests against a real LLM provider.
 *
 * Usage:
 *   # Against local vLLM (default):
 *   bun scripts/e2e-live.ts
 *
 *   # Against OpenAI:
 *   PROVIDER=openai OPENAI_API_KEY=sk-... bun scripts/e2e-live.ts
 *
 *   # Against Anthropic:
 *   PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... bun scripts/e2e-live.ts
 *
 *   # Custom vLLM URL/model:
 *   VLLM_BASE_URL=http://localhost:8000/v1 VLLM_MODEL=Qwen/Qwen3.5-4B bun scripts/e2e-live.ts
 */

import { z } from "zod";
import { createAgent } from "../src/index";
import type { ProviderConfig } from "../src/types";

// ── Configuration ──────────────────────────────────────────────────

function getProviderConfig(): ProviderConfig {
	const provider = process.env.PROVIDER ?? "vllm";

	switch (provider) {
		case "vllm":
			return {
				type: "vllm",
				model: process.env.VLLM_MODEL ?? "Qwen/Qwen3.5-4B",
				apiKey: "not-needed",
				baseUrl: process.env.VLLM_BASE_URL ?? "http://localhost:8000/v1",
			};
		case "openai":
			return {
				type: "openai",
				model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
				apiKey: process.env.OPENAI_API_KEY,
			};
		case "anthropic":
			return {
				type: "anthropic",
				model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
				apiKey: process.env.ANTHROPIC_API_KEY,
			};
		default:
			throw new Error(`Unknown provider: ${provider}`);
	}
}

// ── Test runner ────────────────────────────────────────────────────

interface TestResult {
	name: string;
	passed: boolean;
	duration: number;
	error?: string;
	details?: Record<string, unknown>;
}

const results: TestResult[] = [];

async function runTest(
	name: string,
	fn: () => Promise<Record<string, unknown> | void>,
): Promise<void> {
	const start = performance.now();
	process.stdout.write(`  ${name} ... `);
	try {
		const details = await fn();
		const duration = performance.now() - start;
		results.push({ name, passed: true, duration, details: details ?? undefined });
		console.log(`PASS (${(duration / 1000).toFixed(1)}s)`);
	} catch (err) {
		const duration = performance.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		results.push({ name, passed: false, duration, error: message });
		console.log(`FAIL (${(duration / 1000).toFixed(1)}s)`);
		console.log(`    ${message}`);
	}
}

// ── Tests ──────────────────────────────────────────────────────────

const providerConfig = getProviderConfig();
console.log(
	`\nRunning live e2e tests against ${providerConfig.type} (${providerConfig.model})\n`,
);

// Warmup: first inference can be very slow (Triton autotuning, CUDA graph capture)
await runTest("warmup request", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({ x: z.number() }),
		tools: [
			{
				name: "ping",
				description: "Simple ping",
				params: z.object({ msg: z.string().describe("A message") }),
				validWhen: () => true,
			},
		],
		instructions: () => "Respond with a ping.",
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});
	agent.setState({ x: 1 });
	const result = await agent.nextAction({ timeout: 300000 });
	return { action: result.action, model: result.meta.model };
});

// Test 1: Basic single-tool decision
await runTest("basic single-tool decision", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({
			temperature: z.number(),
			unit: z.enum(["celsius", "fahrenheit"]),
		}),
		tools: [
			{
				name: "set_thermostat",
				description: "Set the thermostat to a target temperature in the current unit",
				params: z.object({
					target: z.number().describe("Target temperature to set"),
				}),
				validWhen: () => true,
			},
		],
		instructions: (s) =>
			`You are a smart home controller. The current temperature is ${s.temperature}°${s.unit === "celsius" ? "C" : "F"}. It's too cold. Set the thermostat to a comfortable temperature (around 22°C or 72°F).`,
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});

	agent.setState({ temperature: 15, unit: "celsius" });
	const result = await agent.nextAction({ timeout: 120000 });

	if (result.action.tool !== "set_thermostat") {
		throw new Error(`Expected tool "set_thermostat", got "${result.action.tool}"`);
	}
	if (typeof result.action.params.target !== "number") {
		throw new Error(`Expected numeric target, got ${typeof result.action.params.target}`);
	}

	return {
		action: result.action,
		tokensUsed: result.meta.tokensUsed,
		cost: result.meta.cost,
		model: result.meta.model,
	};
});

// Test 2: Multi-tool choice (model must pick the right one)
await runTest("multi-tool choice based on state", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({
			taskType: z.enum(["email", "calendar", "chat"]),
			message: z.string(),
		}),
		tools: [
			{
				name: "send_email",
				description: "Send an email to someone",
				params: z.object({
					to: z.string().describe("Recipient email address"),
					subject: z.string().describe("Email subject line"),
					body: z.string().describe("Email body text"),
				}),
				validWhen: (s) => s.taskType === "email",
			},
			{
				name: "create_event",
				description: "Create a calendar event",
				params: z.object({
					title: z.string().describe("Event title"),
					date: z.string().describe("Event date in YYYY-MM-DD format"),
				}),
				validWhen: (s) => s.taskType === "calendar",
			},
			{
				name: "send_chat",
				description: "Send a chat message",
				params: z.object({
					channel: z.string().describe("Chat channel name"),
					message: z.string().describe("Message text"),
				}),
				validWhen: (s) => s.taskType === "chat",
			},
		],
		instructions: (s) =>
			`You are a productivity assistant. The user wants to perform a "${s.taskType}" task. Their request: "${s.message}". Choose the appropriate action and fill in reasonable parameters.`,
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});

	agent.setState({
		taskType: "email",
		message: "Send a quick note to alice@example.com about the meeting tomorrow",
	});
	const result = await agent.nextAction({ timeout: 120000 });

	if (result.action.tool !== "send_email") {
		throw new Error(`Expected "send_email", got "${result.action.tool}"`);
	}
	const params = result.action.params as { to: string; subject: string; body: string };
	if (!params.to || !params.subject || !params.body) {
		throw new Error(`Missing required params: ${JSON.stringify(params)}`);
	}

	return { action: result.action, model: result.meta.model };
});

// Test 3: validWhen filtering (only one tool available despite multiple defined)
await runTest("validWhen filters tools correctly", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({
			balance: z.number(),
			isPremium: z.boolean(),
		}),
		tools: [
			{
				name: "basic_support",
				description: "Provide basic customer support response",
				params: z.object({
					response: z.string().describe("Support response to the customer"),
				}),
				validWhen: () => true,
			},
			{
				name: "issue_refund",
				description: "Issue a refund to the customer",
				params: z.object({
					amount: z.number().describe("Refund amount in dollars"),
					reason: z.string().describe("Reason for the refund"),
				}),
				validWhen: (s) => s.isPremium && s.balance > 100,
			},
		],
		instructions: () =>
			"You are a customer support agent. The customer is asking for help. Provide basic support.",
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});

	// Non-premium, low balance — issue_refund should be filtered out
	agent.setState({ balance: 10, isPremium: false });
	const result = await agent.nextAction({ timeout: 120000 });

	if (result.action.tool !== "basic_support") {
		throw new Error(
			`Expected "basic_support" (only valid tool), got "${result.action.tool}"`,
		);
	}

	return { action: result.action, model: result.meta.model };
});

// Test 4: History context (model should reference prior actions)
await runTest("history context influences decision", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({
			step: z.number(),
			data: z.object({ collected: z.array(z.string()) }),
		}),
		tools: [
			{
				name: "collect_data",
				description: "Collect a piece of data from the user",
				params: z.object({
					field: z.string().describe("The field name to collect (e.g. 'name', 'email', 'phone')"),
				}),
				validWhen: (s) => s.step < 3,
			},
			{
				name: "submit_form",
				description: "Submit the completed form with all collected data",
				params: z.object({
					summary: z.string().describe("Brief summary of the submission"),
				}),
				validWhen: (s) => s.step >= 3,
			},
		],
		instructions: (s) =>
			`You are a form-filling assistant. You need to collect: name, email, phone. So far you have collected: [${s.data.collected.join(", ")}]. Collect the next missing field.`,
		context: {
			budgets: { instructions: 5000, state: 2000, history: 10000, tools: 2000 },
		},
	});

	agent.setState({ step: 1, data: { collected: ["name"] } });
	agent.setHistory([
		{
			tool: "collect_data",
			params: { field: "name" },
			result: "User provided: John Doe",
			success: true,
		},
	]);

	const result = await agent.nextAction({ timeout: 120000 });

	if (result.action.tool !== "collect_data") {
		throw new Error(`Expected "collect_data", got "${result.action.tool}"`);
	}
	const field = (result.action.params as { field: string }).field;
	if (field === "name") {
		throw new Error("Model tried to collect 'name' again despite it being in history");
	}

	return { action: result.action, model: result.meta.model };
});

// Test 5: Verbose mode returns context
await runTest("verbose mode returns assembled context", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({ value: z.number() }),
		tools: [
			{
				name: "increment",
				description: "Increment the counter",
				params: z.object({
					amount: z.number().describe("Amount to increment by"),
				}),
				validWhen: () => true,
			},
		],
		instructions: () => "Increment the counter by 1.",
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});

	agent.setState({ value: 42 });
	const result = await agent.nextAction({ verbose: true, timeout: 30000 });

	if (!("context" in result)) {
		throw new Error("Verbose result missing 'context' field");
	}
	const verbose = result as any;
	if (!verbose.context.messages || !verbose.context.outputSchema) {
		throw new Error("Verbose context missing messages or outputSchema");
	}
	if (!verbose.context.validTools.includes("increment")) {
		throw new Error("validTools doesn't include 'increment'");
	}

	return {
		action: result.action,
		numMessages: verbose.context.messages.length,
		schemaKeys: Object.keys(verbose.context.outputSchema),
		validTools: verbose.context.validTools,
	};
});

// Test 6: Timeout handling
await runTest("timeout aborts long requests", async () => {
	const agent = createAgent({
		provider: providerConfig,
		state: z.object({ x: z.number() }),
		tools: [
			{
				name: "noop",
				description: "Do nothing",
				params: z.object({ reason: z.string() }),
				validWhen: () => true,
			},
		],
		instructions: () => "Do nothing.",
		context: {
			budgets: { instructions: 5000, state: 2000, history: 5000, tools: 2000 },
		},
	});

	agent.setState({ x: 1 });

	try {
		await agent.nextAction({ timeout: 1 }); // 1ms — should definitely time out
		throw new Error("Expected timeout error but request succeeded");
	} catch (err: any) {
		if (err.name !== "AbortError" && !err.message.includes("abort")) {
			throw new Error(`Expected AbortError, got ${err.name}: ${err.message}`);
		}
	}

	return { status: "correctly threw AbortError" };
});

// ── Summary ────────────────────────────────────────────────────────

console.log("\n─── Results ───\n");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

for (const r of results) {
	const status = r.passed ? "PASS" : "FAIL";
	const duration = (r.duration / 1000).toFixed(1);
	console.log(`  ${status}  ${r.name} (${duration}s)`);
	if (r.details) {
		console.log(`        ${JSON.stringify(r.details)}`);
	}
	if (r.error) {
		console.log(`        Error: ${r.error}`);
	}
}

console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

if (failed > 0) {
	process.exit(1);
}
