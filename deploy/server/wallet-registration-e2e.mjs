import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const origin = "http://localhost:5173";
export const registrationMetadata = {
	client_name: "Local PKCE demo",
	application_type: "native",
	redirect_uris: ["http://localhost:5173/oauth/callback"],
	token_endpoint_auth_method: "none",
	grant_types: ["authorization_code", "refresh_token"],
	scope: "openid profile email offline_access",
};

export async function walletLogin(base) {
	const account = privateKeyToAccount(generatePrivateKey());
	const nonce = await fetch(`${base}/api/auth/siwe/nonce`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: "{}",
	});
	const message = createSiweMessage({
		address: account.address,
		chainId: 1,
		domain: "localhost",
		uri: origin,
		version: "1",
		nonce: (await nonce.json()).nonce,
	});
	const response = await fetch(`${base}/api/auth/siwe/verify`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({
			message,
			signature: await account.signMessage({ message }),
		}),
	});
	assert.equal(response.ok, true, await response.clone().text());
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	return { account, cookie };
}

export async function registerWalletClient(base, account, cookie) {
	const unsigned = await fetch(`${base}/api/auth/oauth2/create-client`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/json" },
		body: JSON.stringify(registrationMetadata),
	});
	assert.equal(
		unsigned.status,
		403,
		"A session alone must not authorize client registration",
	);
	const challengeResponse = await fetch(
		`${base}/api/auth/client-registration/challenge`,
		{
			method: "POST",
			headers: { cookie, origin, "content-type": "application/json" },
			body: JSON.stringify({ address: account.address, chainId: 1 }),
		},
	);
	const challenge = await challengeResponse.json();
	assert.equal(challengeResponse.ok, true, JSON.stringify(challenge));
	const headers = {
		cookie,
		origin,
		"content-type": "application/json",
		"x-registration-challenge": challenge.challengeId,
		"x-registration-signature": await account.signMessage({
			message: challenge.message,
		}),
	};
	const request = () =>
		fetch(`${base}/api/auth/oauth2/create-client`, {
			method: "POST",
			headers,
			body: JSON.stringify(registrationMetadata),
		});
	const response = await request();
	const client = await response.json();
	assert.equal(response.status, 201, JSON.stringify(client));
	assert.ok(client.client_id);
	assert.equal(
		(await request()).status,
		403,
		"Wallet registration approval must be single-use",
	);
	return client;
}
