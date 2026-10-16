import { siwe } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import { demoSiweClient } from "./siwe-client";

/** @see https://www.better-auth.com/docs/plugins/siwe */
it("notifies the session hook when SIWE verification creates a session", async () => {
	const { client } = await getTestInstance(
		{
			plugins: [
				siwe({
					domain: "localhost",
					getNonce: async () => "A1b2C3d4E5f6G7h8J",
					verifyMessage: async ({ signature }) =>
						signature === "test-signature",
				}),
			],
		},
		{ clientOptions: { plugins: [demoSiweClient()] } },
	);
	const sessionSignal = client.$store.atoms.$sessionSignal;
	const before = sessionSignal.get();
	const nonce = await client.siwe.nonce();
	expect(nonce.error).toBeNull();
	const result = await client.siwe.verify({
		message: `localhost wants you to sign in with your Ethereum account:\n0x000000000000000000000000000000000000dEaD\n\nSign in.\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 1\nNonce: ${nonce.data?.nonce}\nIssued At: ${new Date().toISOString()}`,
		signature: "test-signature",
	});
	expect(result.error).toBeNull();
	expect(result.data?.success).toBe(true);
	await expect.poll(() => sessionSignal.get()).not.toBe(before);
});
