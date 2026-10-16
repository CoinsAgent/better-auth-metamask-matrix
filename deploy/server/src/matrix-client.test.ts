import type { SchemaClient } from "@better-auth/oauth-provider";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import {
	ensureMatrixClient,
	matrixCallback,
	matrixClientId,
} from "./matrix-client.js";
import { walletRegistration } from "./wallet-registration.js";

/** @see https://element-hq.github.io/synapse/latest/openid.html */
it("provisions one immutable confidential Synapse client without weakening wallet registration", async () => {
	const policy = walletRegistration();
	const { auth, signInWithTestUser } = await getTestInstance({
		plugins: [
			policy.plugin,
			jwt({ jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } } }),
			oauthProvider({
				loginPage: "/sign-in",
				consentPage: "/consent",
				cachedTrustedClients: new Set([matrixClientId]),
				clientPrivileges: policy.clientPrivileges,
			}),
		],
	});
	const { adapter } = await auth.$context;
	const credentials = {
		clientId: matrixClientId as "matrix-synapse-local",
		clientSecret: "private-local-matrix-secret-at-least-32-characters",
	};
	await ensureMatrixClient(adapter, credentials);
	await ensureMatrixClient(adapter, credentials);
	const records = await adapter.findMany<SchemaClient>({
		model: "oauthClient",
		where: [{ field: "clientId", value: matrixClientId }],
	});
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({
		redirectUris: [matrixCallback],
		tokenEndpointAuthMethod: "client_secret_basic",
		requirePKCE: true,
		scopes: ["openid", "profile"],
		skipConsent: false,
	});
	expect(records[0]?.clientSecret).not.toBe(credentials.clientSecret);
	const { headers } = await signInWithTestUser();
	const publicClient = await auth.api.getOAuthClientPublic({
		headers,
		query: { client_id: matrixClientId },
	});
	expect(publicClient.client_name).toBe("Matrix · Synapse");
	expect(publicClient.client_secret).toBeUndefined();
	await expect(
		auth.api.updateOAuthClient({
			headers,
			body: { client_id: matrixClientId, update: { client_name: "Changed" } },
		}),
	).rejects.toBeDefined();
	await expect(
		auth.api.createOAuthClient({
			headers,
			body: {
				client_name: "Unsigned",
				redirect_uris: ["http://localhost:5173/oauth/callback"],
				application_type: "native",
			},
		}),
	).rejects.toBeDefined();
});
