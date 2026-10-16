import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt, siwe } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoClientMetadata } from "../../shared/client-registration.js";
import { walletRegistration } from "./wallet-registration.js";

async function setup() {
	const policy = walletRegistration();
	const instance = await getTestInstance({
		trustedOrigins: ["http://localhost:3000", "http://localhost:5173"],
		plugins: [
			jwt(),
			siwe({
				domain: "localhost",
				getNonce: async () => "A1b2C3d4E5f6G7h8J",
				verifyMessage: async () => true,
			}),
			oauthProvider({
				loginPage: "/sign-in",
				consentPage: "/consent",
				clientPrivileges: policy.clientPrivileges,
			}),
			policy.plugin,
		],
	});
	const { headers, user } = await instance.signInWithTestUser();
	const wallet = privateKeyToAccount(generatePrivateKey());
	const { adapter } = await instance.auth.$context;
	await adapter.create({
		model: "walletAddress",
		data: {
			userId: user.id,
			address: wallet.address,
			chainId: 1,
			isPrimary: true,
			createdAt: new Date(),
		},
	});
	const request = (
		path: string,
		body: unknown,
		extra?: Record<string, string>,
		sessionHeaders = headers,
	) =>
		instance.auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				method: "POST",
				headers: {
					cookie: sessionHeaders.get("cookie") ?? "",
					origin: "http://localhost:3000",
					"content-type": "application/json",
					...extra,
				},
				body: JSON.stringify(body),
			}),
		);
	async function proof() {
		const response = await request("/client-registration/challenge", {
			address: wallet.address,
			chainId: 1,
		});
		const data = await response.json();
		expect(response.status, JSON.stringify(data)).toBe(200);
		return {
			"x-registration-challenge": data.challengeId as string,
			"x-registration-signature": await wallet.signMessage({
				message: data.message,
			}),
		};
	}
	return { ...instance, headers, user, wallet, request, proof };
}

afterEach(() => vi.restoreAllMocks());

/** @see https://eips.ethereum.org/EIPS/eip-191 */
describe("fresh wallet approval for OAuth client registration", () => {
	it("rejects a signed-in user's registration without wallet proof", async () => {
		const { request } = await setup();
		expect(
			(await request("/oauth2/create-client", demoClientMetadata())).status,
		).toBe(403);
	});
	it("accepts a linked wallet signature exactly once", async () => {
		const { request, proof } = await setup();
		const approval = await proof();
		const response = await request(
			"/oauth2/create-client",
			demoClientMetadata(),
			approval,
		);
		expect(response.status, JSON.stringify(await response.clone().json())).toBe(
			201,
		);
		expect((await response.json()).client_id).toBeTruthy();
		expect(
			(await request("/oauth2/create-client", demoClientMetadata(), approval))
				.status,
		).toBe(403);
	});
	it("rejects a signature from a different wallet", async () => {
		const { request, wallet } = await setup();
		const challenge = await request("/client-registration/challenge", {
			address: wallet.address,
			chainId: 1,
		});
		const data = await challenge.json();
		const signature = await privateKeyToAccount(
			generatePrivateKey(),
		).signMessage({ message: data.message });
		expect(
			(
				await request("/oauth2/create-client", demoClientMetadata(), {
					"x-registration-challenge": data.challengeId,
					"x-registration-signature": signature,
				})
			).status,
		).toBe(403);
	});
	it("rejects expired approval", async () => {
		const { request, proof } = await setup();
		const approval = await proof();
		const later = Date.now() + 121_000;
		vi.spyOn(Date, "now").mockReturnValue(later);
		expect(
			(await request("/oauth2/create-client", demoClientMetadata(), approval))
				.status,
		).toBe(403);
	});
	it("rejects registration metadata changed after signing", async () => {
		const { request, proof } = await setup();
		expect(
			(
				await request(
					"/oauth2/create-client",
					{ ...demoClientMetadata(), client_name: "Changed application" },
					await proof(),
				)
			).status,
		).toBe(403);
	});
	it("rejects an unlinked wallet and an anonymous challenge request", async () => {
		const { request, wallet } = await setup();
		const other = privateKeyToAccount(generatePrivateKey());
		expect(
			(
				await request("/client-registration/challenge", {
					address: other.address,
					chainId: 1,
				})
			).status,
		).toBe(403);
		expect(
			(
				await request(
					"/client-registration/challenge",
					{ address: wallet.address, chainId: 1 },
					undefined,
					new Headers(),
				)
			).status,
		).toBe(401);
	});
	it("rejects proof used by a different user", async () => {
		const { auth, request, proof } = await setup();
		const approval = await proof();
		const other = await auth.api.signUpEmail({
			body: {
				email: "other-wallet-test@example.com",
				password: "password123",
				name: "Other",
			},
			returnHeaders: true,
		});
		const cookie = other.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(
			(
				await request(
					"/oauth2/create-client",
					demoClientMetadata(),
					approval,
					new Headers({ cookie }),
				)
			).status,
		).toBe(403);
	});
	it("rejects proof after the same user starts a different session", async () => {
		const instance = await setup();
		const approval = await instance.proof();
		const next = await instance.signInWithTestUser();
		expect(
			(
				await instance.request(
					"/oauth2/create-client",
					demoClientMetadata(),
					approval,
					next.headers,
				)
			).status,
		).toBe(403);
	});
	it("rejects approval after the wallet is unlinked", async () => {
		const { auth, user, request, proof } = await setup();
		const approval = await proof();
		const { adapter } = await auth.$context;
		await adapter.deleteMany({
			model: "walletAddress",
			where: [{ field: "userId", value: user.id }],
		});
		expect(
			(await request("/oauth2/create-client", demoClientMetadata(), approval))
				.status,
		).toBe(403);
	});
	it("rejects a login signature reused as a registration signature", async () => {
		const { request, proof, wallet } = await setup();
		const approval = await proof();
		approval["x-registration-signature"] = await wallet.signMessage({
			message: "Sign in with Ethereum",
		});
		expect(
			(await request("/oauth2/create-client", demoClientMetadata(), approval))
				.status,
		).toBe(403);
	});
	it("rejects proof sent from a different trusted origin", async () => {
		const { request, proof } = await setup();
		const approval = await proof();
		expect(
			(
				await request("/oauth2/create-client", demoClientMetadata(), {
					...approval,
					origin: "http://localhost:5173",
				})
			).status,
		).toBe(403);
	});
	it("rejects malformed signatures without a server error", async () => {
		const { request, proof } = await setup();
		const approval = await proof();
		expect(
			(
				await request("/oauth2/create-client", demoClientMetadata(), {
					...approval,
					"x-registration-signature": "not-a-signature",
				})
			).status,
		).toBe(403);
	});
	it("does not let concurrent requests reuse one approval", async () => {
		const { request, proof } = await setup();
		const approval = await proof();
		const responses = await Promise.all([
			request("/oauth2/create-client", demoClientMetadata(), approval),
			request("/oauth2/create-client", demoClientMetadata(), approval),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			201, 403,
		]);
	});
	it("blocks the administrative creation endpoint without a fresh approval", async () => {
		const { auth, headers } = await setup();
		await expect(
			auth.api.adminCreateOAuthClient({ headers, body: demoClientMetadata() }),
		).rejects.toMatchObject({ statusCode: 401 });
	});
});
