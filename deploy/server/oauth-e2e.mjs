import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
	registerWalletClient,
	walletLogin,
} from "./wallet-registration-e2e.mjs";

const base = process.env.TEST_SERVER_URL ?? "http://localhost:3100";
const issuer = `${base}/api/auth`;
let cookie = "";
async function request(path, body, extra = {}) {
	const response = await fetch(`${issuer}${path}`, {
		redirect: "manual",
		method: body ? "POST" : "GET",
		headers: {
			cookie,
			origin: "http://localhost:5173",
			...(body ? { "content-type": "application/json" } : {}),
			...extra,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length)
		cookie = cookies.map((value) => value.split(";")[0]).join("; ");
	return response;
}
async function json(path, body) {
	const response = await request(path, body);
	const data = await response.json();
	assert.equal(response.ok, true, JSON.stringify(data));
	return data;
}
async function token(body) {
	return fetch(`${issuer}/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
}
const owner = await walletLogin(base);
const client = await registerWalletClient(base, owner.account, owner.cookie);
const verifier = randomBytes(32).toString("base64url");
const email = `oauth-${Date.now()}@example.com`;
await json("/sign-up/email", {
	email,
	password: "password123",
	name: "OAuth test",
});
const params = new URLSearchParams({
	client_id: client.client_id,
	redirect_uri: "http://localhost:5173/oauth/callback",
	response_type: "code",
	scope: "openid profile email offline_access",
	state: "test-state",
	code_challenge: createHash("sha256").update(verifier).digest("base64url"),
	code_challenge_method: "S256",
	prompt: "login consent",
});
const authorization = await request(`/oauth2/authorize?${params}`, undefined, {
	accept: "text/html",
});
assert.ok([200, 302].includes(authorization.status));
const loginURL = new URL(
	authorization.headers.get("location") ?? (await authorization.json()).url,
);
assert.equal(loginURL.pathname, "/sign-in");
const loggedIn = await json("/sign-in/email", {
	email,
	password: "password123",
	oauth_query: loginURL.search.slice(1),
});
const consentURL = new URL(loggedIn.url);
assert.equal(consentURL.pathname, "/consent");
const details = await fetch(`${base}/api/consent-details${consentURL.search}`, {
	headers: { cookie },
});
assert.equal(details.ok, true);
assert.equal((await details.json()).clientName, "Local PKCE demo");
const denied = await json("/oauth2/consent", {
	accept: false,
	oauth_query: consentURL.search.slice(1),
});
assert.equal(new URL(denied.url).searchParams.get("error"), "access_denied");
const approved = await json("/oauth2/consent", {
	accept: true,
	oauth_query: consentURL.search.slice(1),
});
const callback = new URL(approved.url);
assert.equal(callback.searchParams.get("state"), "test-state");
assert.equal(callback.searchParams.get("iss"), issuer);
const body = {
	grant_type: "authorization_code",
	code: callback.searchParams.get("code"),
	client_id: client.client_id,
	redirect_uri: "http://localhost:5173/oauth/callback",
	code_verifier: verifier,
};
const exchanged = await token(body);
const tokens = await exchanged.json();
assert.equal(exchanged.ok, true, JSON.stringify(tokens));
assert.ok(tokens.access_token);
assert.ok(tokens.refresh_token);
assert.ok(tokens.id_token);
const info = await fetch(`${issuer}/oauth2/userinfo`, {
	headers: { authorization: `Bearer ${tokens.access_token}` },
});
assert.equal(info.ok, true);
assert.equal((await info.json()).name, "OAuth test");
const refreshed = await token({
	grant_type: "refresh_token",
	client_id: client.client_id,
	refresh_token: tokens.refresh_token,
});
assert.equal(refreshed.ok, true);
const rotated = await refreshed.json();
assert.notEqual(rotated.refresh_token, tokens.refresh_token);
const revoked = await fetch(`${issuer}/oauth2/revoke`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		client_id: client.client_id,
		token: rotated.refresh_token,
		token_type_hint: "refresh_token",
	}),
});
assert.equal(revoked.ok, true);
const revokedInfo = await fetch(`${issuer}/oauth2/userinfo`, {
	headers: { authorization: `Bearer ${rotated.access_token}` },
});
assert.equal(
	revokedInfo.ok,
	false,
	"Revoking the refresh token must also cut off its associated opaque access token",
);
assert.equal(
	(
		await token({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: rotated.refresh_token,
		})
	).ok,
	false,
);
assert.equal(
	(await token(body)).ok,
	false,
	"authorization codes must be single-use",
);
const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
assert.equal(discovery.ok, true);
assert.equal((await discovery.json()).issuer, issuer);
console.log(
	"OAuth E2E passed: registration, consent deny/allow, PKCE exchange, code replay rejection, UserInfo, rotation, revocation, discovery",
);
