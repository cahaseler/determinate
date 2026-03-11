import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/oauth/token-store";

describe("TokenStore", () => {
	let tempDir: string;
	let store: TokenStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "naa-test-"));
		store = new TokenStore(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns null for non-existent credentials", async () => {
		const result = await store.load("nonexistent");
		expect(result).toBeNull();
	});

	it("saves and loads credentials", async () => {
		const creds = { refresh: "r", access: "a", expires: Date.now() + 3600000 };
		await store.save("test-provider", creds);
		const loaded = await store.load("test-provider");
		expect(loaded).toEqual(creds);
	});

	it("overwrites existing credentials", async () => {
		await store.save("test", { refresh: "old", access: "old", expires: 1 });
		await store.save("test", { refresh: "new", access: "new", expires: 2 });
		const loaded = await store.load("test");
		expect(loaded?.refresh).toBe("new");
	});

	it("clears credentials", async () => {
		await store.save("test", { refresh: "r", access: "a", expires: 1 });
		await store.clear("test");
		const loaded = await store.load("test");
		expect(loaded).toBeNull();
	});

	it("clear does not throw for non-existent credentials", async () => {
		await expect(store.clear("nonexistent")).resolves.toBeUndefined();
	});
});
