import type { betterAuth } from "better-auth";
import { symmetricEncrypt } from "better-auth/crypto";
import { generateExportedKeyPair } from "better-auth/plugins/jwt";

type Context = Awaited<ReturnType<typeof betterAuth>["$context"]>;
type SigningContext = {
	adapter: Pick<Context["adapter"], "findOne" | "create">;
	secretConfig: Context["secretConfig"];
};

/** Add a Synapse-compatible signing key while retaining old JWT verification keys. */
export async function ensureMatrixSigningKey(context: SigningContext) {
	const existing = await context.adapter.findOne({
		model: "jwks",
		where: [
			{ field: "alg", value: "RS256" },
			{ field: "expiresAt", value: null },
		],
	});
	if (existing) return;
	const { publicWebKey, privateWebKey } = await generateExportedKeyPair({
		jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
	});
	await context.adapter.create({
		model: "jwks",
		data: {
			alg: "RS256",
			publicKey: JSON.stringify(publicWebKey),
			privateKey: JSON.stringify(
				await symmetricEncrypt({
					key: context.secretConfig,
					data: JSON.stringify(privateWebKey),
				}),
			),
			createdAt: new Date(),
		},
	});
}
