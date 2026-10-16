import { siweClient } from "better-auth/client/plugins";
import { jwt, siwe } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import { oauthProvider } from "./oauth";

/** @see https://www.better-auth.com/docs/plugins/oauth-provider */
it.each([
	"/siwe/nonce",
	"/siwe/get-nonce",
])("resumes forced SIWE OAuth login with a signed query on %s", async (noncePath) => {
	const { auth, signInWithTestUser } = await getTestInstance(
		{
			plugins: [
				jwt(),
				oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
				siwe({
					domain: "localhost",
					getNonce: async () => "A1b2C3d4E5f6G7h8J",
					verifyMessage: async () => true,
				}),
			],
		},
		{ clientOptions: { plugins: [siweClient()] } },
	);
	const { headers } = await signInWithTestUser();
	const registered = await auth.api.createOAuthClient({
		headers,
		body: {
			client_name: "SIWE OAuth test",
			application_type: "native",
			redirect_uris: ["http://localhost:5173/oauth/callback"],
			token_endpoint_auth_method: "none",
			scope: "openid profile",
		},
	});
	const query = new URLSearchParams({
		response_type: "code",
		client_id: registered.client_id,
		redirect_uri: "http://localhost:5173/oauth/callback",
		scope: "openid profile",
		state: "test",
		prompt: "login consent",
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
	});
	const response = await auth.handler(
		new Request(`http://localhost:3000/api/auth/oauth2/authorize?${query}`, {
			headers: { accept: "text/html" },
		}),
	);
	const login = new URL(
		response.headers.get("location")!,
		"http://localhost:3000",
	);
	const nonceResponse = await auth.handler(
		new Request(`http://localhost:3000/api/auth${noncePath}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
			},
			body: JSON.stringify({ oauth_query: login.search.slice(1) }),
		}),
	);
	const nonce = await nonceResponse.json();
	expect(nonceResponse.status, JSON.stringify(nonce)).toBe(200);
	const verificationRequest = new Request(
		"http://localhost:3000/api/auth/siwe/verify",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				accept: "application/json",
			},
			body: JSON.stringify({
				message: `localhost wants you to sign in with your Ethereum account:\n0x000000000000000000000000000000000000dEaD\n\nSign in.\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 1\nNonce: ${nonce.nonce}\nIssued At: ${new Date().toISOString()}`,
				signature: "test",
				oauth_query: login.search.slice(1),
			}),
		},
	);
	const tamperedBody = await verificationRequest.clone().json();
	tamperedBody.oauth_query += "&scope=openid%20email";
	const tampered = await auth.handler(
		new Request(verificationRequest.clone(), {
			body: JSON.stringify(tamperedBody),
		}),
	);
	expect(tampered.status).toBe(400);
	expect(await tampered.json()).toMatchObject({ error: "invalid_signature" });
	const verification = await auth.handler(verificationRequest);
	const body = await verification.json();
	expect(verification.status, JSON.stringify(body)).toBe(200);
	expect(new URL(body.url, "http://localhost:3000").pathname).toBe("/consent");
	expect(verification.headers.get("set-cookie")).toContain("session_token");
});
