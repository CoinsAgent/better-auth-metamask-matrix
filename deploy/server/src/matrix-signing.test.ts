import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import { ensureMatrixSigningKey } from "./matrix-signing.js";

/** @see https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#oidc_providers */
it("provisions RS256 when upgrading a demo database that already has an EdDSA key", async () => {
	const instance = await getTestInstance({
		plugins: [
			jwt({ jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } } }),
			oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
		],
	});
	const context = await instance.auth.$context;
	// Existing deployments keep their old verification keys during this migration.
	await context.adapter.create({
		model: "jwks",
		data: {
			publicKey: "{}",
			privateKey: "{}",
			alg: "EdDSA",
			crv: "Ed25519",
			createdAt: new Date(),
		},
	});
	await ensureMatrixSigningKey(context);
	await ensureMatrixSigningKey(context);
	const keys = await context.adapter.findMany({ model: "jwks" });
	expect(keys).toHaveLength(2);
	const { headers } = await instance.signInWithTestUser();
	const { token } = await instance.auth.api.getToken({ headers });
	expect(JSON.parse(atob(token.split(".")[0]!)).alg).toBe("RS256");
});
