import { describe, expect, it } from "bun:test";
import { createProvider } from "../../src/providers/factory";

describe("provider factory", () => {
	it("throws for unknown provider type", () => {
		expect(() => createProvider({ type: "unknown" as unknown as "openai", model: "x" })).toThrow();
	});

	it("creates an openai provider", () => {
		const provider = createProvider({
			type: "openai",
			model: "gpt-4o",
			apiKey: "test-key",
		});
		expect(provider).toBeDefined();
	});

	it("creates an anthropic provider", () => {
		const provider = createProvider({
			type: "anthropic",
			model: "claude-sonnet-4-5-20250514",
			apiKey: "test-key",
		});
		expect(provider).toBeDefined();
	});

	it("creates a vllm provider with baseUrl", () => {
		const provider = createProvider({
			type: "vllm",
			model: "local-model",
			baseUrl: "http://localhost:8000/v1",
		});
		expect(provider).toBeDefined();
	});

	it("creates an openrouter provider", () => {
		const provider = createProvider({
			type: "openrouter",
			model: "anthropic/claude-sonnet-4-5-20250514",
			apiKey: "test-key",
		});
		expect(provider).toBeDefined();
	});
});
