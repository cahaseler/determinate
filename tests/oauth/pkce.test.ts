import { describe, expect, it } from "bun:test";
import { generatePKCE } from "../../src/oauth/pkce";

describe("PKCE", () => {
	it("generates a verifier and challenge", async () => {
		const { verifier, challenge } = await generatePKCE();
		expect(typeof verifier).toBe("string");
		expect(typeof challenge).toBe("string");
		expect(verifier.length).toBeGreaterThan(0);
		expect(challenge.length).toBeGreaterThan(0);
	});

	it("generates different values each time", async () => {
		const a = await generatePKCE();
		const b = await generatePKCE();
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.challenge).not.toBe(b.challenge);
	});

	it("verifier and challenge are base64url encoded (no +, /, =)", async () => {
		const { verifier, challenge } = await generatePKCE();
		expect(verifier).not.toContain("+");
		expect(verifier).not.toContain("/");
		expect(verifier).not.toContain("=");
		expect(challenge).not.toContain("+");
		expect(challenge).not.toContain("/");
		expect(challenge).not.toContain("=");
	});
});
