import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import {
	oauthProvider,
	verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { generateRandomString } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { jwt, siwe } from "better-auth/plugins";
import Database from "better-sqlite3";
import { createPublicClient, http, verifyMessage } from "viem";
import { mainnet } from "viem/chains";
import {
	ensureMatrixClient,
	matrixClientId,
	readMatrixCredentials,
} from "./matrix-client.js";
import { ensureMatrixSigningKey } from "./matrix-signing.js";
import { walletRegistration } from "./wallet-registration.js";

const PORT = Number(process.env.PORT ?? 3100);
const CLIENT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
// SIWE "domain" must match the domain inside the signed ERC-4361 message.
// The browser client signs with `location.hostname`, so default to localhost.
const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? "localhost";
const ETH_RPC_URL = process.env.ETH_RPC_URL ?? "https://cloudflare-eth.com";

const DB_PATH = resolve(
	process.env.DB_PATH ?? resolve(process.cwd(), "data/auth.db"),
);
mkdirSync(dirname(DB_PATH), { recursive: true });

// Best-effort ENS lookup. Never let a slow/blocked RPC stall sign-in.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((res) => setTimeout(() => res(fallback), ms)),
	]);
}

const registration = walletRegistration();
const matrixCredentials = readMatrixCredentials();

export const auth = betterAuth({
	database: new Database(DB_PATH),
	baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
	secret:
		process.env.BETTER_AUTH_SECRET ??
		"dev-only-insecure-secret-change-me-please-32chars",
	// Basic usage: email + password (docs/basic-usage)
	emailAndPassword: {
		enabled: true,
	},
	trustedOrigins: CLIENT_ORIGINS,
	disabledPaths: ["/token"],
	socialProviders: {
		...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: process.env.GITHUB_CLIENT_ID,
						clientSecret: process.env.GITHUB_CLIENT_SECRET,
					},
				}
			: {}),
	},
	plugins: [
		registration.plugin,
		jwt({ jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } } }),
		oauthProvider({
			loginPage: "http://localhost:5173/sign-in",
			consentPage: "http://localhost:5173/consent",
			scopes: ["openid", "profile", "email", "offline_access"],
			grantTypes: ["authorization_code", "refresh_token"],
			clientPrivileges: registration.clientPrivileges,
			cachedTrustedClients: new Set([matrixClientId]),
		}),
		// Web3 login via Sign in with Ethereum (docs/plugins/siwe)
		siwe({
			domain: SIWE_DOMAIN,
			emailDomainName: SIWE_DOMAIN,
			// Wallet-only accounts don't need an email address.
			anonymous: true,
			getNonce: async () =>
				// ERC-4361 nonce: 8-250 alphanumeric characters.
				generateRandomString(32, "a-z", "A-Z", "0-9"),
			verifyMessage: async ({ message, signature, address }) => {
				try {
					return await verifyMessage({
						address: address as `0x${string}`,
						message,
						signature: signature as `0x${string}`,
					});
				} catch (error) {
					console.error("[siwe] verification failed:", error);
					return false;
				}
			},
			ensLookup: async ({ walletAddress }) => {
				const fallback = { name: walletAddress, avatar: "" };
				return withTimeout(
					(async () => {
						try {
							const client = createPublicClient({
								chain: mainnet,
								transport: http(ETH_RPC_URL),
							});
							const name = await client.getEnsName({
								address: walletAddress as `0x${string}`,
							});
							if (!name) return fallback;
							const avatar = await client.getEnsAvatar({ name });
							return { name, avatar: avatar ?? "" };
						} catch {
							return fallback;
						}
					})(),
					6000,
					fallback,
				);
			},
		}),
	],
});

// Create/upgrade the SQLite schema (user/session/account/verification/walletAddress).
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
if (matrixCredentials) {
	const context = await auth.$context;
	await ensureMatrixSigningKey(context);
	await ensureMatrixClient(context.adapter, matrixCredentials);
	console.log("[matrix] local Synapse OIDC client ready");
}
console.log("[better-auth] database schema is up to date");

const authHandler = toNodeHandler(auth);

const server = createServer(async (req, res) => {
	const origin = req.headers.origin;
	// CORS so a separately-hosted client can talk to this server directly.
	if (origin && CLIENT_ORIGINS.includes(origin))
		res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	res.setHeader(
		"Access-Control-Allow-Headers",
		"authorization, content-type, x-registration-challenge, x-registration-signature",
	);
	res.setHeader(
		"Access-Control-Allow-Methods",
		"GET, POST, PUT, PATCH, DELETE, OPTIONS",
	);
	if (req.method === "OPTIONS") {
		res.writeHead(204).end();
		return;
	}

	const url = req.url ?? "/";

	// Provider landing page shares the demo's frontend and visual design.
	if (req.method === "GET" && (url === "/" || url === "/provider")) {
		res.writeHead(302, { location: "http://localhost:5173/provider" }).end();
		return;
	}

	if (url.startsWith("/api/auth/") || url.startsWith("/.well-known/")) {
		await authHandler(req, res);
		return;
	}

	if (url.startsWith("/api/consent-details?")) {
		const query = url.slice(url.indexOf("?") + 1);
		const { secret } = await auth.$context;
		const session = await auth.api.getSession({
			headers: fromNodeHeaders(req.headers),
		});
		if (!session || !(await verifyOAuthQueryParams(query, secret))) {
			res.writeHead(400).end();
			return;
		}
		const params = new URLSearchParams(query);
		res.setHeader("content-type", "application/json");
		try {
			const clientId = params.get("client_id") ?? "";
			const client = await auth.api.getOAuthClientPublic({
				headers: fromNodeHeaders(req.headers),
				query: { client_id: clientId },
			});
			res.end(
				JSON.stringify({
					scope: params.get("scope"),
					clientId,
					clientName: client.client_name,
				}),
			);
		} catch {
			res
				.writeHead(400)
				.end(JSON.stringify({ error: "Application not found or disabled" }));
		}
		return;
	}

	if (url === "/api/demo-config") {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				github: Boolean(
					process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
				),
				matrix: Boolean(matrixCredentials),
			}),
		);
		return;
	}

	// A protected-ish server endpoint that reads the session via auth.api.
	if (url.startsWith("/api/me")) {
		const session = await auth.api.getSession({
			headers: fromNodeHeaders(req.headers),
		});
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(session ?? null));
		return;
	}

	if (url === "/health") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ ok: true, service: "better-auth-server" }));
		return;
	}

	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
	console.log(`[better-auth] server listening on http://localhost:${PORT}`);
	console.log(
		`[better-auth] auth endpoints:  http://localhost:${PORT}/api/auth`,
	);
	console.log(`[better-auth] SIWE domain:    ${SIWE_DOMAIN}`);
	console.log(`[better-auth] sqlite database: ${DB_PATH}`);
});
