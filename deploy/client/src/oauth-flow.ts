const issuer = "http://localhost:3100/api/auth";
const redirectURI = "http://localhost:5173/oauth/callback";
const pendingKey = "demo.oauth.pending";

export interface Tokens {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in: number;
	scope: string;
}

/** Produce the S256 PKCE challenge for an unpadded base64url verifier. */
export async function challenge(verifier: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function randomValue() {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Start a public-client authorization request; no client secret belongs in a browser. */
export async function startAuthorization(clientId: string) {
	const verifier = randomValue();
	const state = randomValue();
	sessionStorage.setItem(
		pendingKey,
		JSON.stringify({ verifier, state, clientId }),
	);
	const query = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectURI,
		response_type: "code",
		scope: "openid profile email offline_access",
		state,
		code_challenge: await challenge(verifier),
		code_challenge_method: "S256",
		prompt: "login consent",
	});
	window.location.assign(`${issuer}/oauth2/authorize?${query}`);
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
	const response = await fetch(`${issuer}/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const data = await response.json();
	if (!response.ok)
		throw new Error(
			data.error_description ?? data.error ?? "Token request failed",
		);
	return data;
}

/** Validate the callback before exchanging the single-use authorization code. */
export async function finishAuthorization(search: string) {
	const query = new URLSearchParams(search);
	const raw = sessionStorage.getItem(pendingKey);
	sessionStorage.removeItem(pendingKey);
	if (!raw)
		throw new Error("No pending authorization request. Start a new flow.");
	const pending: { verifier: string; state: string; clientId: string } =
		JSON.parse(raw);
	if (query.get("state") !== pending.state)
		throw new Error("OAuth state mismatch");
	if (query.get("iss") !== issuer) throw new Error("OAuth issuer mismatch");
	if (query.has("error"))
		throw new Error(
			query.get("error_description") ??
				query.get("error") ??
				"Authorization denied",
		);
	const code = query.get("code");
	if (!code) throw new Error("Missing authorization code");
	const tokens = await tokenRequest({
		grant_type: "authorization_code",
		client_id: pending.clientId,
		redirect_uri: redirectURI,
		code,
		code_verifier: pending.verifier,
	});
	return { tokens, clientId: pending.clientId };
}

export function refreshTokens(clientId: string, refreshToken: string) {
	return tokenRequest({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken,
	});
}

export async function userInfo(accessToken: string): Promise<unknown> {
	const response = await fetch(`${issuer}/oauth2/userinfo`, {
		headers: { authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) throw new Error("UserInfo rejected the access token");
	return response.json();
}

export async function revokeToken(
	clientId: string,
	token: string,
	hint: string,
) {
	const response = await fetch(`${issuer}/oauth2/revoke`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			token,
			token_type_hint: hint,
		}),
	});
	if (!response.ok) throw new Error("Token revocation failed");
}

/** Revoke the demo's current access and its optional refresh token. */
export async function revokeTokens(clientId: string, tokens: Tokens) {
	// This provider deletes associated opaque access tokens when revoking refresh.
	if (tokens.refresh_token)
		await revokeToken(clientId, tokens.refresh_token, "refresh_token");
	else await revokeToken(clientId, tokens.access_token, "access_token");
}
