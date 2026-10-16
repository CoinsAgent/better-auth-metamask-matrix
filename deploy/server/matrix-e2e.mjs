import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const authBase = process.env.TEST_SERVER_URL ?? "http://localhost:3100";
const matrix = "http://localhost:8008";
const element = "http://localhost:8088/";
const origin = "http://localhost:5173";
const cookies = new Map();
async function request(url, body) {
	const response = await fetch(url, {
		redirect: "manual",
		method: body ? "POST" : "GET",
		headers: {
			accept: "text/html",
			cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
			...(body ? { origin, "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	for (const value of response.headers.getSetCookie()) {
		const [name, ...rest] = value.split(";")[0].split("=");
		cookies.set(name, rest.join("="));
	}
	return response;
}
async function json(url, body) {
	const response = await request(url, body);
	const data = await response.json();
	assert.equal(response.ok, true, JSON.stringify(data));
	return data;
}
async function redirect(response) {
	const href = response.headers.get("location");
	if (href) return new URL(href, response.url);
	const data = await response.json();
	assert.ok(data.url, JSON.stringify(data));
	return new URL(data.url);
}
const account = privateKeyToAccount(generatePrivateKey());
async function walletSignIn(oauthQuery) {
	const extra = oauthQuery ? { oauth_query: oauthQuery } : {};
	const { nonce } = await json(`${authBase}/api/auth/siwe/nonce`, extra);
	const message = createSiweMessage({
		address: account.address,
		chainId: 1,
		domain: "localhost",
		uri: origin,
		version: "1",
		nonce,
	});
	return json(`${authBase}/api/auth/siwe/verify`, {
		message,
		signature: await account.signMessage({ message }),
		...extra,
	});
}
async function matrixLogin() {
	const entry = await request(
		`${matrix}/_matrix/client/v3/login/sso/redirect/oidc-betterauth?redirectUrl=${encodeURIComponent(element)}`,
	);
	const authorize = await redirect(entry);
	assert.equal(authorize.origin, authBase);
	assert.equal(authorize.searchParams.get("client_id"), "matrix-synapse-local");
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	let next = await redirect(await request(authorize));
	if (next.pathname === "/sign-in") {
		const login = await walletSignIn(next.search.slice(1));
		next = new URL(login.url);
	}
	if (next.pathname === "/consent") {
		const consent = await json(`${authBase}/api/auth/oauth2/consent`, {
			accept: true,
			oauth_query: next.search.slice(1),
		});
		next = new URL(consent.url);
	}
	assert.equal(next.pathname, "/_synapse/client/oidc/callback");
	const callback = await request(next);
	let destination = callback.headers.get("location");
	if (!destination) {
		const html = await callback.text();
		// Synapse may interpose its whitelisted-client confirmation page.
		destination = html
			.match(/href="(http:\/\/localhost:8088\/[^\"]*loginToken[^\"]*)"/)?.[1]
			?.replaceAll("&amp;", "&");
		assert.ok(
			destination,
			`Synapse callback failed (${callback.status}): ${html.slice(0, 2000)}`,
		);
	}
	const loginToken = new URL(destination).searchParams.get("loginToken");
	assert.ok(loginToken, "Synapse must issue a one-use Matrix login token");
	const response = await fetch(`${matrix}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "m.login.token",
			token: loginToken,
			initial_device_display_name: "Wallet integration test",
		}),
	});
	const session = await response.json();
	assert.equal(response.ok, true, JSON.stringify(session));
	assert.ok(session.access_token);
	const whoami = await fetch(`${matrix}/_matrix/client/v3/account/whoami`, {
		headers: { authorization: `Bearer ${session.access_token}` },
	});
	assert.equal(whoami.ok, true);
	assert.equal((await whoami.json()).user_id, session.user_id);
	const profile = await fetch(
		`${matrix}/_matrix/client/v3/profile/${encodeURIComponent(session.user_id)}/displayname`,
	);
	assert.equal(profile.ok, true);
	assert.equal(
		(await profile.json()).displayname,
		account.address,
		"Synapse must fetch the wallet display name from OIDC UserInfo",
	);
	// A Matrix login token cannot be replayed.
	const replay = await fetch(`${matrix}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "m.login.token", token: loginToken }),
	});
	assert.equal(replay.ok, false);
	return session;
}
const first = await matrixLogin();
// Start another independent provider login with the SAME wallet and no auth cookie.
for (const key of cookies.keys())
	if (key.startsWith("better-auth")) cookies.delete(key);
const second = await matrixLogin();
assert.equal(
	first.user_id,
	second.user_id,
	"The same wallet must retain the same Matrix identity",
);
assert.match(first.user_id, /^@ba_[a-z0-9_=-]+:localhost$/);
for (const session of [first, second]) {
	const logout = await fetch(`${matrix}/_matrix/client/v3/logout`, {
		method: "POST",
		headers: { authorization: `Bearer ${session.access_token}` },
		body: "{}",
	});
	assert.equal(logout.ok, true);
}
console.log(
	"Matrix E2E passed: SIWE → consent → Synapse OIDC + PKCE → Matrix token → whoami; repeat wallet login retains identity; login token replay rejected; Matrix logout.",
);
