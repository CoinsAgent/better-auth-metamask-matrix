import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { optimizeDeps, resolveConfig } from "vite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import demoConfig from "../vite.config";

interface Session {
	sessionScopes: Record<
		string,
		{ accounts: string[]; methods: string[]; notifications: string[] }
	>;
}
interface Transport {
	disconnect(): Promise<void>;
}
function mobileSession(
	session: unknown = { sessionScopes: { "eip155:1": {} } },
) {
	const client = {
		state: "CONNECTED",
		on: vi.fn((_event: string, _listener: (payload: unknown) => void) => {}),
		disconnect: vi.fn(async () => {}),
		sendRequest: vi.fn(
			async (_request: {
				data: { id: string; method: string; params: { scopes: string[] } };
			}) => {},
		),
	};
	const cached = new Map<string, string>();
	if (session)
		cached.set("cache_wallet_getSession", JSON.stringify({ result: session }));
	const store = {
		get: async (key: string) => cached.get(key),
		set: async (key: string, value: string) => {
			cached.set(key, value);
		},
		delete: vi.fn(async (key: string) => {
			cached.delete(key);
		}),
	};
	const transport = new sdk.TestTransport(client, store);
	function respond(result: boolean) {
		const handler = client.on.mock.calls.find(
			([event]) => event === "message",
		)?.[1];
		const request = client.sendRequest.mock.calls[0]?.[0];
		if (!handler || !request)
			throw new Error("No mobile request or response handler");
		handler({ data: { id: request.data.id, jsonrpc: "2.0", result } });
	}
	return { client, cached, transport, respond };
}
let protocol: {
	TestDapp: new (
		options: unknown,
	) => {
		connect(options?: { mode: string }): Promise<void>;
		disconnect(): Promise<void>;
		on(event: string, callback: (payload: unknown) => void): void;
		_createPendingSessionAndRequest(mode: string): {
			request: { expiresAt: number };
		};
	};
};
let directory: string;
let sdk: {
	TestEVM: {
		create(options: {
			core: unknown;
		}): Promise<{ disconnect(): Promise<void> }>;
	};
	TestTransport: new (client: unknown, store: unknown) => Transport;
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "better-auth-sdk-disconnect-"));
	const config = await resolveConfig(
		{
			configFile: false,
			root: fileURLToPath(new URL("../", import.meta.url)),
			cacheDir: directory,
			resolve: demoConfig.resolve,
			logLevel: "silent",
			optimizeDeps: {
				...demoConfig.optimizeDeps,
				include: ["@metamask/connect-evm"],
			},
		},
		"serve",
	);
	const metadata = await optimizeDeps(config, true);
	const file = metadata.optimized["@metamask/connect-evm"]?.file;
	if (!file) throw new Error("SDK was not optimized");
	// Exercise the actual shipped classes without changing the SDK's public exports.
	const testFile = join(directory, "deps", "sdk-disconnect.mjs");
	await writeFile(
		testFile,
		`${await readFile(file, "utf8")}\ninit_mwp();\nexport { MetamaskConnectEVM as TestEVM, MWPTransport as TestTransport };\n`,
	);
	sdk = await import(/* @vite-ignore */ pathToFileURL(testFile).href);
	const require = createRequire(
		fileURLToPath(new URL("../package.json", import.meta.url)),
	);
	const evmRequire = createRequire(require.resolve("@metamask/connect-evm"));
	const coreRequire = createRequire(
		evmRequire.resolve("@metamask/connect-multichain"),
	);
	const module = coreRequire
		.resolve("@metamask/mobile-wallet-protocol-dapp-client")
		.replace(/\.js$/, ".mjs");
	// Keep relative dependency resolution by placing the test wrapper next to the optimized SDK.
	const result = await optimizeDeps(
		await resolveConfig(
			{
				configFile: false,
				root: fileURLToPath(new URL("../", import.meta.url)),
				cacheDir: join(directory, "protocol"),
				resolve: demoConfig.resolve,
				logLevel: "silent",
				optimizeDeps: {
					include: [module],
					noDiscovery: true,
					esbuildOptions: { target: "esnext" },
				},
			},
			"serve",
		),
		true,
	);
	const entry = result.optimized[module]?.file;
	if (!entry) throw new Error("Protocol client was not optimized");
	const wrapper = join(directory, "protocol", "deps", "protocol-test.mjs");
	await writeFile(
		wrapper,
		`${await readFile(entry, "utf8")}\nexport { DappClient as TestDapp };\n`,
	);
	protocol = await import(/* @vite-ignore */ pathToFileURL(wrapper).href);
}, 30_000);
afterEach(() => vi.useRealTimers());
afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

/** @see https://github.com/MetaMask/connect-monorepo/pull/344 */
it("revokes the whole session including non-EVM permissions", async () => {
	const session: Session = {
		sessionScopes: {
			"eip155:1": { accounts: [], methods: [], notifications: [] },
			"solana:test": { accounts: [], methods: [], notifications: [] },
		},
	};
	const core = {
		on: vi.fn(),
		off: vi.fn(),
		status: "disconnected",
		disconnect: vi.fn(),
		provider: { getSession: async () => session },
	};
	const client = await sdk.TestEVM.create({ core });
	await client.disconnect();
	expect(core.disconnect).toHaveBeenCalledWith();
});

/** @see https://github.com/MetaMask/connect-monorepo/blob/main/packages/connect-multichain/src/multichain/transports/mwp/index.ts */
it("keeps the mobile relay open until the wallet acknowledges revocation", async () => {
	const { client, cached, transport, respond } = mobileSession();
	const ending = transport.disconnect();
	await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(1));
	const request = client.sendRequest.mock.calls[0]?.[0];
	if (!request) throw new Error("No revocation request");
	expect(request.data).toMatchObject({
		method: "wallet_revokeSession",
		params: { scopes: [] },
	});
	const closedEarly = client.disconnect.mock.calls.length;
	respond(true);
	await ending;
	expect(closedEarly).toBe(0);
	expect(client.disconnect).toHaveBeenCalledTimes(1);
	expect(cached.has("cache_wallet_getSession")).toBe(false);
});

it("preserves the session for retry when the wallet declines revocation", async () => {
	const { client, cached, transport, respond } = mobileSession();
	const ending = transport.disconnect();
	const rejected = expect(ending).rejects.toThrow("Wallet did not acknowledge");
	await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(1));
	respond(false);
	await rejected;
	expect(client.disconnect).not.toHaveBeenCalled();
	expect(cached.has("cache_wallet_getSession")).toBe(true);
});

it("cancels unapproved QR pairing without trying to resume a nonexistent wallet session", async () => {
	const { client, transport } = mobileSession(null);
	await transport.disconnect();
	expect(client.sendRequest).not.toHaveBeenCalled();
	expect(client.disconnect).toHaveBeenCalledTimes(1);
});

function protocolClient() {
	const transport = {
		on: vi.fn(),
		connect: vi.fn(async () => {}),
		subscribe: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		clear: vi.fn(async () => {}),
	};
	const client = new protocol.TestDapp({
		transport,
		sessionstore: { delete: vi.fn(async () => {}) },
		keymanager: {
			generateKeyPair: () => ({
				publicKey: new Uint8Array(65),
				privateKey: new Uint8Array(32),
			}),
		},
	});
	client.on("error", () => {});
	return { client, transport };
}

it("gives an actual protocol QR five minutes of validity", () => {
	const { client } = protocolClient();
	const { request } = client._createPendingSessionAndRequest("trusted");
	expect(request.expiresAt - Date.now()).toBeGreaterThan(299_000);
	expect(request.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
});

it("settles a cancelled handshake immediately instead of leaving an old timeout running", async () => {
	vi.useFakeTimers();
	const { client, transport } = protocolClient();
	const pending = client.connect({ mode: "trusted" });
	const stopped = expect(pending).rejects.toThrow("cancelled");
	await vi.advanceTimersByTimeAsync(0);
	await client.disconnect();
	await vi.advanceTimersByTimeAsync(0);
	let settled = false;
	void stopped.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(true);
	expect(transport.disconnect).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(400_000);
	await stopped;
	expect(transport.disconnect).toHaveBeenCalledTimes(1);
});

it("cancels pairing even while relay subscription is still pending", async () => {
	vi.useFakeTimers();
	const { client, transport } = protocolClient();
	let subscribed!: () => void;
	transport.subscribe.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				subscribed = resolve;
			}),
	);
	const pending = client.connect({ mode: "trusted" });
	let settled = false;
	const stopped = expect(pending)
		.rejects.toThrow("cancelled")
		.then(() => {
			settled = true;
		});
	await vi.advanceTimersByTimeAsync(0);
	await client.disconnect();
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(true);
	subscribed();
	await vi.advanceTimersByTimeAsync(400_000);
	await stopped;
	expect(transport.disconnect).toHaveBeenCalledTimes(1);
});
