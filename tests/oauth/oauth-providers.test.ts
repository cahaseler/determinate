import { describe, it, expect } from "bun:test";
import { getOAuthProvider, getOAuthProviders } from "../../src/oauth/index";

describe("OAuth registry", () => {
	it("has anthropic provider registered", () => {
		const provider = getOAuthProvider("anthropic");
		expect(provider).toBeDefined();
		expect(provider!.id).toBe("anthropic");
		expect(provider!.name).toContain("Anthropic");
	});

	it("has openai provider registered", () => {
		const provider = getOAuthProvider("openai");
		expect(provider).toBeDefined();
		expect(provider!.id).toBe("openai");
		expect(provider!.name).toContain("ChatGPT");
	});

	it("returns undefined for unknown provider", () => {
		expect(getOAuthProvider("nonexistent")).toBeUndefined();
	});

	it("lists all providers", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBe(2);
		const ids = providers.map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("openai");
	});
});
