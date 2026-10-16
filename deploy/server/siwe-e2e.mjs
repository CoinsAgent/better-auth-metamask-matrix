// End-to-end SIWE test against the running better-auth server (:3100).
// Signs a real ERC-4361 message with a throwaway key — no browser needed.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { registerWalletClient } from "./wallet-registration-e2e.mjs";

const BASE = process.env.TEST_SERVER_URL ?? "http://localhost:3100";
// better-auth requires a trusted Origin on POSTs (it is a trustedOrigin list entry).
const ORIGIN = "http://localhost:5173";

const account = privateKeyToAccount(generatePrivateKey());
console.log("wallet:", account.address);

function grabCookie(res) {
	const sc = res.headers.getSetCookie?.() ?? [];
	return sc.map((c) => c.split(";")[0]).join("; ");
}

// 1) nonce
const nonceRes = await fetch(`${BASE}/api/auth/siwe/nonce`, {
	method: "POST",
	headers: { "content-type": "application/json", origin: ORIGIN },
	body: "{}",
});
const nonceJson = await nonceRes.json();
assert.equal(nonceRes.ok, true, JSON.stringify(nonceJson));
assert.ok(nonceJson.nonce);
const cookie = grabCookie(nonceRes);

// 2) build + sign SIWE message
const message = createSiweMessage({
	address: account.address,
	chainId: 1,
	domain: "localhost",
	uri: BASE,
	version: "1",
	nonce: nonceJson.nonce,
	statement: "Sign in with Ethereum to the app.",
});
const signature = await account.signMessage({ message });

// 3) verify -> session
const verifyRes = await fetch(`${BASE}/api/auth/siwe/verify`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie, origin: ORIGIN },
	body: JSON.stringify({ message, signature }),
});
const verifyJson = await verifyRes.json();
assert.equal(verifyRes.ok, true, JSON.stringify(verifyJson));
assert.equal(verifyJson.success, true);
const sessionCookie = grabCookie(verifyRes) || cookie;

// 4) read the session back
const meRes = await fetch(`${BASE}/api/me`, {
	headers: { cookie: sessionCookie },
});
const session = await meRes.json();
assert.equal(meRes.ok, true);
assert.equal(session?.user.id, verifyJson.user.id);

// Registration requires a separate, fresh signature from the linked wallet.
const registeredClient = await registerWalletClient(
	BASE,
	account,
	sessionCookie,
);

// Repeat wallet login from the signed OAuth login page, then exchange the code.
const verifier = randomBytes(32).toString("base64url");
const query = new URLSearchParams({
	client_id: registeredClient.client_id,
	response_type: "code",
	redirect_uri: "http://localhost:5173/oauth/callback",
	scope: "openid profile email offline_access",
	state: "siwe-state",
	prompt: "login consent",
	code_challenge: createHash("sha256").update(verifier).digest("base64url"),
	code_challenge_method: "S256",
});
const authorization = await fetch(
	`${BASE}/api/auth/oauth2/authorize?${query}`,
	{
		redirect: "manual",
		headers: {
			cookie: sessionCookie,
			origin: ORIGIN,
			accept: "application/json",
		},
	},
);
const loginResult = await authorization.json();
assert.equal(authorization.ok, true, JSON.stringify(loginResult));
const loginURL = new URL(loginResult.url);
assert.equal(loginURL.pathname, "/sign-in");
const nextNonce = await fetch(`${BASE}/api/auth/siwe/nonce`, {
	method: "POST",
	headers: { "content-type": "application/json", origin: ORIGIN },
	body: JSON.stringify({ oauth_query: loginURL.search.slice(1) }),
});
const nextMessage = createSiweMessage({
	address: account.address,
	chainId: 1,
	domain: "localhost",
	uri: ORIGIN,
	version: "1",
	nonce: (await nextNonce.json()).nonce,
});
const reauthenticated = await fetch(`${BASE}/api/auth/siwe/verify`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		origin: ORIGIN,
		accept: "application/json",
	},
	body: JSON.stringify({
		message: nextMessage,
		signature: await account.signMessage({ message: nextMessage }),
		oauth_query: loginURL.search.slice(1),
	}),
});
const resumed = await reauthenticated.json();
assert.equal(reauthenticated.ok, true, JSON.stringify(resumed));
const consentURL = new URL(resumed.url);
assert.equal(consentURL.pathname, "/consent");
const consent = await fetch(`${BASE}/api/auth/oauth2/consent`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		origin: ORIGIN,
		cookie: grabCookie(reauthenticated),
		accept: "application/json",
	},
	body: JSON.stringify({
		accept: true,
		oauth_query: consentURL.search.slice(1),
	}),
});
const approved = await consent.json();
assert.equal(consent.ok, true, JSON.stringify(approved));
const callback = new URL(approved.url);
assert.equal(callback.searchParams.get("state"), "siwe-state");
const exchange = await fetch(`${BASE}/api/auth/oauth2/token`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		grant_type: "authorization_code",
		client_id: registeredClient.client_id,
		redirect_uri: "http://localhost:5173/oauth/callback",
		code: callback.searchParams.get("code"),
		code_verifier: verifier,
	}),
});
const tokens = await exchange.json();
assert.equal(exchange.ok, true, JSON.stringify(tokens));
assert.ok(tokens.access_token);

// 5) nonce replay must fail
const replay = await fetch(`${BASE}/api/auth/siwe/verify`, {
	method: "POST",
	headers: { "content-type": "application/json", origin: ORIGIN },
	body: JSON.stringify({ message, signature }),
});
assert.ok(replay.status >= 400);
console.log(
	"SIWE E2E passed: wallet login, registration, forced SIWE reauthentication, consent, PKCE exchange, nonce replay rejection",
);
