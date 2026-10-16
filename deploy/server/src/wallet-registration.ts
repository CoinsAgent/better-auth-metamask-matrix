import type { OAuthOptions } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	getSessionFromCtx,
	sessionMiddleware,
} from "better-auth/api";
import { generateRandomString } from "better-auth/crypto";
import { getAddress, verifyMessage } from "viem";
import * as z from "zod";
import { demoClientMetadata } from "../../shared/client-registration.js";

const lifetime = 120_000;
const prefix = "client-registration:";
const proofSchema = z.object({
	userId: z.string(),
	sessionId: z.string(),
	address: z.string(),
	chainId: z.number(),
	origin: z.string(),
	message: z.string(),
	expiresAt: z.number(),
});

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function matchesMetadata(body: unknown) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const metadata = Object.fromEntries(
		Object.entries(body).filter(([key]) => key !== "oauth_query"),
	);
	return canonical(metadata) === canonical(demoClientMetadata());
}

/** Require a single-use, session-bound wallet approval for each demo client creation. */
export function walletRegistration() {
	// A request cannot manufacture Headers object identity from an HTTP header.
	const approvedRequests = new WeakMap<
		Headers,
		{ userId: string; sessionId: string }
	>();
	const clientPrivileges: NonNullable<OAuthOptions["clientPrivileges"]> = ({
		action,
		headers,
		user,
		session,
	}) => {
		if (action !== "create")
			return action !== "configure-client-credentials-scopes";
		const approval = approvedRequests.get(headers);
		approvedRequests.delete(headers);
		return Boolean(
			approval &&
				approval.userId === user?.id &&
				approval.sessionId === session?.id,
		);
	};
	const plugin = {
		id: "wallet-registration",
		endpoints: {
			registrationChallenge: createAuthEndpoint(
				"/client-registration/challenge",
				{
					method: "POST",
					use: [sessionMiddleware],
					metadata: { noStore: true },
					body: z
						.object({
							address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
							chainId: z.number().int().positive(),
							oauth_query: z.string().optional(),
						})
						.strict(),
				},
				async (ctx) => {
					const { user, session } = ctx.context.session;
					const address = getAddress(ctx.body.address);
					const wallet = await ctx.context.adapter.findOne({
						model: "walletAddress",
						where: [
							{ field: "userId", value: user.id },
							{ field: "address", value: address },
							{ field: "chainId", value: ctx.body.chainId },
						],
					});
					if (!wallet)
						throw new APIError("FORBIDDEN", {
							message:
								"This wallet is not linked to your account. Sign in with Ethereum first.",
						});
					const origin = ctx.headers?.get("origin");
					if (!origin)
						throw new APIError("FORBIDDEN", {
							message: "A trusted browser origin is required.",
						});
					const challengeId = generateRandomString(32, "a-z", "A-Z", "0-9");
					const expiresAt = Date.now() + lifetime;
					const message = [
						"Approve OAuth client registration",
						`Origin: ${origin}`,
						`User: ${user.id}`,
						`Session: ${session.id}`,
						`Wallet: ${address}`,
						`Chain ID: ${ctx.body.chainId}`,
						`Action: create OAuth client`,
						`Registration: ${canonical(demoClientMetadata())}`,
						`Nonce: ${challengeId}`,
						`Expires: ${new Date(expiresAt).toISOString()}`,
					].join("\n");
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: `${prefix}${challengeId}`,
						expiresAt: new Date(expiresAt),
						value: JSON.stringify({
							userId: user.id,
							sessionId: session.id,
							address,
							chainId: ctx.body.chainId,
							origin,
							message,
							expiresAt,
						}),
					});
					return ctx.json({ challengeId, message, expiresAt });
				},
			),
		},
		hooks: {
			before: [
				{
					matcher: (ctx) => ctx.path === "/oauth2/create-client",
					handler: createAuthMiddleware(async (ctx) => {
						const session = await getSessionFromCtx(ctx);
						if (!session) throw new APIError("UNAUTHORIZED");
						const challengeId = ctx.headers?.get("x-registration-challenge");
						const signature = ctx.headers?.get("x-registration-signature");
						if (!challengeId || !signature || !matchesMetadata(ctx.body))
							throw new APIError("FORBIDDEN", {
								message:
									"A fresh wallet signature approving this registration is required.",
							});
						const challenge =
							await ctx.context.internalAdapter.consumeVerificationValue(
								`${prefix}${challengeId}`,
							);
						if (!challenge)
							throw new APIError("FORBIDDEN", {
								message:
									"Approval expired or was already used. Sign a new challenge.",
							});
						const proof = proofSchema.parse(JSON.parse(challenge.value));
						if (
							proof.userId !== session.user.id ||
							proof.sessionId !== session.session.id ||
							proof.origin !== ctx.headers?.get("origin") ||
							proof.expiresAt <= Date.now()
						)
							throw new APIError("FORBIDDEN", {
								message: "Approval does not match this session or has expired.",
							});
						// Check ownership again in case the wallet was unlinked since challenge issuance.
						const wallet = await ctx.context.adapter.findOne({
							model: "walletAddress",
							where: [
								{ field: "userId", value: session.user.id },
								{ field: "address", value: proof.address },
								{ field: "chainId", value: proof.chainId },
							],
						});
						let valid = false;
						try {
							valid =
								Boolean(wallet) &&
								(await verifyMessage({
									address: getAddress(proof.address),
									message: proof.message,
									signature: signature as `0x${string}`,
								}));
						} catch {
							/* malformed signatures are denied */
						}
						if (!valid)
							throw new APIError("FORBIDDEN", {
								message: "Invalid wallet registration signature.",
							});
						if (ctx.headers)
							approvedRequests.set(ctx.headers, {
								userId: session.user.id,
								sessionId: session.session.id,
							});
					}),
				},
			],
		},
		rateLimit: [
			{
				pathMatcher: (path) => path === "/client-registration/challenge",
				window: 60,
				max: 10,
			},
		],
	} satisfies BetterAuthPlugin;
	return { plugin, clientPrivileges };
}
