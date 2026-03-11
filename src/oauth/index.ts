import { anthropicOAuthProvider } from "./anthropic";
import { openaiOAuthProvider } from "./openai";
import { TokenStore } from "./token-store";
import type { OAuthCredentials, OAuthProviderInterface } from "./types";

export { anthropicOAuthProvider } from "./anthropic";
export { openaiOAuthProvider } from "./openai";
export { TokenStore } from "./token-store";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProviderId,
	OAuthProviderInterface,
} from "./types";

const providers = new Map<string, OAuthProviderInterface>([
	["anthropic", anthropicOAuthProvider],
	["openai", openaiOAuthProvider],
]);

export function getOAuthProvider(id: string): OAuthProviderInterface | undefined {
	return providers.get(id);
}

export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(providers.values());
}

/**
 * Get an API key from stored OAuth credentials.
 * If credentials are expired but refreshable, refreshes transparently.
 * Returns null if no stored credentials exist.
 */
export async function getOAuthApiKey(
	providerId: string,
	store?: TokenStore,
): Promise<{ apiKey: string; credentials: OAuthCredentials } | null> {
	const provider = providers.get(providerId);
	if (!provider) return null;

	const tokenStore = store ?? new TokenStore();
	const credentials = await tokenStore.load(providerId);
	if (!credentials) return null;

	// Check if expired
	if (Date.now() >= credentials.expires) {
		try {
			const refreshed = await provider.refreshToken(credentials);
			await tokenStore.save(providerId, refreshed);
			return { apiKey: provider.getApiKey(refreshed), credentials: refreshed };
		} catch {
			// Refresh failed — credentials are invalid
			return null;
		}
	}

	return { apiKey: provider.getApiKey(credentials), credentials };
}
