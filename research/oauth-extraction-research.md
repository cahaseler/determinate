# OAuth Extraction Feasibility: pi-ai (pi-mono)

**Date:** 2026-03-11
**Source:** https://github.com/badlogic/pi-mono (packages/ai/src/utils/oauth/)
**License:** MIT

## Summary

The OAuth module in pi-ai is **cleanly separated** and can be extracted with minimal effort. It consists of 8 files totaling ~1,300 lines of TypeScript with only one internal dependency that would need addressing (the GitHub Copilot provider imports `getModels` from the model registry). The Anthropic and OpenAI providers have **zero** coupling to pi-ai internals beyond shared types.

## File Inventory

| File | Lines | External Deps | Internal Coupling |
|------|-------|---------------|-------------------|
| `types.ts` | 60 | None | Imports `Api`, `Model` from `../../types.js` (type-only, for `OAuthProviderInterface.modifyModels`) |
| `pkce.ts` | 34 | None (Web Crypto API) | None |
| `index.ts` | 163 | None | None (re-exports + registry) |
| `anthropic.ts` | 139 | None (fetch) | `generatePKCE`, types |
| `openai-codex.ts` | 456 | `node:crypto`, `node:http` (lazy) | `generatePKCE`, types |
| `github-copilot.ts` | 397 | None (fetch) | `getModels("github-copilot")` from `../../models.js`, types, `Api`/`Model` |
| `google-gemini-cli.ts` | 600 | `node:http` (lazy) | `generatePKCE`, types |
| `google-antigravity.ts` | 458 | `node:http` (lazy) | `generatePKCE`, types |

**Total:** 8 files, ~2,300 lines

## Provider-by-Provider Analysis

### Anthropic OAuth (anthropic.ts) -- EASIEST TO EXTRACT

**Flow type:** Authorization Code + PKCE (manual code paste, no local server)

**Endpoints:**
- Authorize: `https://claude.ai/oauth/authorize`
- Token: `https://console.anthropic.com/v1/oauth/token`
- Redirect: `https://console.anthropic.com/oauth/code/callback`
- Scopes: `org:create_api_key user:profile user:inference`

**Client ID:** Base64-encoded in source: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

**Login flow:**
1. Generate PKCE verifier/challenge
2. Build authorize URL, present to user
3. User pastes back `code#state` string
4. POST to token endpoint with authorization_code grant
5. Returns `{ refresh, access, expires }`

**Token format:** Standard OAuth2 (access_token, refresh_token, expires_in)

**Refresh flow:** POST to token endpoint with refresh_token grant, same client_id

**Storage:** Caller-managed. The module returns `OAuthCredentials` (`{ refresh, access, expires }`); persistence is not handled by the module.

**Coupling to pi-ai:** NONE beyond shared types. Fully self-contained.

**Extraction effort:** Copy `anthropic.ts`, `pkce.ts`, and the relevant types from `types.ts`. Done.

### OpenAI Codex OAuth (openai-codex.ts) -- EASY TO EXTRACT

**Flow type:** Authorization Code + PKCE with local HTTP callback server (port 1455) + manual paste fallback

**Endpoints:**
- Authorize: `https://auth.openai.com/oauth/authorize`
- Token: `https://auth.openai.com/oauth/token`
- Redirect: `http://localhost:1455/auth/callback`
- Scopes: `openid profile email offline_access`

**Client ID:** `app_EMoamEEZ73f0CkXaXp7hrann` (not encoded)

**Login flow:**
1. Generate PKCE verifier/challenge + random state
2. Build authorize URL with special params (`codex_cli_simplified_flow`, `id_token_add_organizations`, `originator`)
3. Start local HTTP server on port 1455 to catch callback
4. Race between: browser callback arriving at local server, manual code paste via `onManualCodeInput`, or `onPrompt` fallback
5. Exchange code for tokens via POST (x-www-form-urlencoded)
6. Decode JWT to extract `chatgpt_account_id` from the `https://api.openai.com/auth` claim
7. Returns `{ refresh, access, expires, accountId }`

**Token format:** JWT access token containing account ID; standard refresh token

**Refresh flow:** POST with refresh_token grant, re-extracts accountId from new JWT

**Node.js dependencies:** `node:crypto` (randomBytes for state) and `node:http` (callback server), both lazy-loaded to avoid breaking browser builds.

**Storage:** Caller-managed.

**Coupling to pi-ai:** NONE beyond shared types.

**Extraction effort:** Copy `openai-codex.ts`, `pkce.ts`, and types. The lazy Node.js imports are self-contained.

### GitHub Copilot OAuth (github-copilot.ts) -- MODERATE COUPLING

**Flow type:** GitHub Device Code flow (RFC 8628)

**Endpoints:**
- Device code: `https://{domain}/login/device/code`
- Access token: `https://{domain}/login/oauth/access_token`
- Copilot token: `https://api.{domain}/copilot_internal/v2/token`
- Domain defaults to `github.com`, supports GitHub Enterprise

**Client ID:** Base64-encoded: `Iv1.b507a08c87ecfe98`

**Login flow:**
1. Prompt user for optional GitHub Enterprise domain
2. POST device code request (scope: `read:user`)
3. Display verification URL + user code to user
4. Poll for access token with adaptive backoff (handles `slow_down` responses, WSL clock drift)
5. Exchange GitHub access token for Copilot token via `copilot_internal/v2/token`
6. After login, enable all known models via `POST /models/{id}/policy`
7. Returns `{ refresh: githubAccessToken, access: copilotToken, expires, enterpriseUrl }`

**Token format:** Copilot token is NOT a JWT -- it's a semicolon-delimited string (`tid=...;exp=...;proxy-ep=...`). The `proxy-ep` field determines the API base URL.

**Refresh flow:** GET to `copilot_internal/v2/token` with Bearer auth using the GitHub access token (stored as `refresh`).

**Coupling to pi-ai:**
- `import { getModels } from "../../models.js"` -- used in `enableAllGitHubCopilotModels()` to iterate known models and POST policy acceptance
- `import type { Api, Model } from "../../types.js"` -- used in `modifyModels()` to set baseUrl on models
- The `modifyModels()` method on the provider interface itself references the `Model<Api>` type

**Extraction effort:** The model-enabling logic (`enableAllGitHubCopilotModels`) would need to either be removed, made optional, or have the model list passed in as a parameter. The `modifyModels` interface method could be dropped or simplified.

### Google Gemini CLI (google-gemini-cli.ts) -- MODERATE COMPLEXITY

**Flow type:** Authorization Code + PKCE with local HTTP callback server (port 8085)

**Key details:**
- Uses Google Cloud Code Assist (`cloudcode-pa.googleapis.com`) for project discovery/provisioning
- Has complex onboarding logic (tier selection, long-running operation polling, VPC SC detection)
- Requires `client_secret` (unlike Anthropic/OpenAI)
- Returns `{ refresh, access, expires, projectId, email }`

**Coupling to pi-ai:** NONE beyond shared types.

**Extraction effort:** Self-contained but large (~600 lines). The project discovery/provisioning logic is specific to Google Cloud Code Assist.

### Google Antigravity (google-antigravity.ts) -- MODERATE COMPLEXITY

**Flow type:** Authorization Code + PKCE with local HTTP callback server (port 51121)

**Key details:**
- Very similar to Gemini CLI but different OAuth credentials, scopes, and port
- Accesses additional models (Gemini 3, Claude, GPT-OSS) via Google Cloud
- Simpler project discovery than Gemini CLI (has a fallback default project ID)

**Coupling to pi-ai:** NONE beyond shared types.

## Architecture of the Type System

The `OAuthProviderInterface` is the key abstraction:

```typescript
interface OAuthProviderInterface {
    readonly id: OAuthProviderId;      // string
    readonly name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    usesCallbackServer?: boolean;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}
```

The `OAuthLoginCallbacks` interface handles UI abstraction cleanly:

```typescript
interface OAuthLoginCallbacks {
    onAuth: (info: { url: string; instructions?: string }) => void;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
    signal?: AbortSignal;
}
```

The `OAuthCredentials` type is minimal and extensible:

```typescript
type OAuthCredentials = {
    refresh: string;
    access: string;
    expires: number;
    [key: string]: unknown;  // allows accountId, projectId, email, etc.
};
```

**Storage is 100% caller-managed.** The OAuth module never reads/writes files. The test helper (`test/oauth.ts`) shows how storage works: read from `~/.pi/agent/auth.json`, call `getOAuthApiKey()`, save refreshed credentials back.

## External Dependencies

The OAuth module uses **zero npm dependencies**. Everything is built on:
- `fetch` (global)
- `URL`, `URLSearchParams` (global)
- `atob`/`btoa` (global)
- `crypto.subtle` (Web Crypto API, for PKCE)
- `node:crypto` (OpenAI Codex only, for randomBytes -- lazy loaded)
- `node:http` (OpenAI Codex, Gemini CLI, Antigravity -- for local callback servers, lazy loaded)

## Extraction Assessment

### What Can Be Copied Verbatim

1. **`pkce.ts`** -- Zero changes needed
2. **`anthropic.ts`** -- Zero changes needed
3. **`openai-codex.ts`** -- Zero changes needed
4. **`google-gemini-cli.ts`** -- Zero changes needed
5. **`google-antigravity.ts`** -- Zero changes needed
6. **`index.ts`** -- Minor changes (drop deprecated functions if desired)

### What Needs Modification

1. **`types.ts`** -- Remove `import type { Api, Model } from "../../types.js"`. The `modifyModels?` method on `OAuthProviderInterface` either needs its own `Model` type or gets removed. If we only need Anthropic and OpenAI, this method is unused.

2. **`github-copilot.ts`** -- The `enableAllGitHubCopilotModels()` function imports `getModels` from pi-ai's model registry. Options:
   - Remove the auto-enable behavior (users enable models manually)
   - Accept a model list as a parameter
   - Hardcode the model IDs

3. **`github-copilot.ts`** -- The `modifyModels()` method references `Model<Api>`. Same solution as types.ts.

### Recommended Extraction Strategy

**If only Anthropic + OpenAI are needed (likely for next-action-agent):**

Copy 4 files, ~700 lines total:
- `pkce.ts` (34 lines) -- verbatim
- `types.ts` (60 lines) -- remove `Api`/`Model` imports and `modifyModels` from interface
- `anthropic.ts` (139 lines) -- verbatim
- `openai-codex.ts` (456 lines) -- verbatim

Plus a simplified `index.ts` (~30 lines) for the provider registry.

**Total extraction effort: ~1 hour, including tests.**

No npm dependencies to add. The only Node.js built-ins used are `node:crypto` and `node:http` (both lazy-loaded in openai-codex.ts).

**If all 5 providers are needed:**

Copy all 8 files. Modify:
- `types.ts`: Define a minimal `Model` type or make `modifyModels` generic
- `github-copilot.ts`: Decouple from `getModels()` (pass model list in, or hardcode)

**Total extraction effort: ~2-3 hours.**

### Alternative: Use as npm Dependency

The package `@mariozechner/pi-ai` exports OAuth as a separate entrypoint (`@mariozechner/pi-ai/oauth`). However, this brings in all of pi-ai's dependencies (~12 npm packages including OpenAI SDK, Anthropic SDK, AWS SDK, etc.), which is heavy for just OAuth.

### Alternative: Vendor Just the OAuth Files

Since the module has zero npm dependencies and is MIT licensed, vendoring the specific files is the lightest approach. The callback-based UI abstraction (`OAuthLoginCallbacks`) makes integration with any CLI framework straightforward.

## Key Findings

1. **The OAuth module is remarkably well-isolated.** It was clearly designed for reuse -- no file I/O, no framework coupling, callback-driven UI.
2. **Anthropic uses PKCE but no local server** -- simplest flow, user pastes a code.
3. **OpenAI Codex uses PKCE + local server** -- more complex but handles fallback to manual paste.
4. **GitHub Copilot uses Device Code flow** (RFC 8628) -- the only provider using this standard flow.
5. **All credential storage is caller-managed** -- the module returns credentials and never persists anything.
6. **Client IDs are base64-encoded in source** (trivial obfuscation, not security).
7. **The `originator` parameter in OpenAI Codex defaults to `"pi"`** -- we'd want to change this to identify our app.
