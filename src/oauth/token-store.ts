import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials } from "./types";

const DEFAULT_DIR = join(homedir(), ".determinate");

export class TokenStore {
	private dir: string;

	constructor(dir?: string) {
		this.dir = dir ?? DEFAULT_DIR;
	}

	private path(providerId: string): string {
		return join(this.dir, `${providerId}-credentials.json`);
	}

	async load(providerId: string): Promise<OAuthCredentials | null> {
		try {
			const raw = await readFile(this.path(providerId), "utf-8");
			return JSON.parse(raw) as OAuthCredentials;
		} catch {
			return null;
		}
	}

	async save(providerId: string, credentials: OAuthCredentials): Promise<void> {
		const filePath = this.path(providerId);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
	}

	async clear(providerId: string): Promise<void> {
		try {
			await unlink(this.path(providerId));
		} catch {
			// File may not exist
		}
	}
}
