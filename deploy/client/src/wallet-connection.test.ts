import { createEVMClient } from "@metamask/connect-evm";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@metamask/connect-evm", () => ({ createEVMClient: vi.fn() }));

import type { WalletProvider } from "./wallet-connection";
import { createWalletConnection, signWalletMessage } from "./wallet-connection";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("lets MetaMask Connect select the extension rather than bypassing it with another injected wallet", async () => {
	const otherWallet: WalletProvider = { request: vi.fn() };
	const metaMask: WalletProvider = { request: vi.fn() };
	vi.stubGlobal("window", { ethereum: otherWallet });
	const createMobile = vi.fn(async () => ({
		connect: async () => ({ accounts: ["0xaddress"] }),
		getProvider: () => metaMask,
		disconnect: vi.fn(),
	}));
	const connection = createWalletConnection(createMobile);
	await expect(connection.getProvider()).resolves.toBe(metaMask);
	expect(createMobile).toHaveBeenCalledTimes(1);
});
it("shows the live QR URI before connection and reuses the connected mobile provider", async () => {
	vi.stubGlobal("window", {});
	const pairing = deferred<{ accounts: string[] }>();
	const provider: WalletProvider = { request: vi.fn() };
	const connect = vi.fn(() => pairing.promise);
	const createMobile = vi.fn(async (show: (uri: string) => void) => ({
		connect: () => {
			show("metamask://pairing-test");
			return connect();
		},
		getProvider: () => provider,
		disconnect: vi.fn(),
	}));
	const connection = createWalletConnection(createMobile);
	const first = connection.getProvider();
	const second = connection.getProvider();
	await vi.waitFor(() =>
		expect(connection.getSnapshot().uri).toBe("metamask://pairing-test"),
	);
	expect(createMobile).toHaveBeenCalledTimes(1);
	pairing.resolve({ accounts: ["0xaddress"] });
	await expect(first).resolves.toBe(provider);
	await expect(second).resolves.toBe(provider);
	expect(connection.getSnapshot()).toMatchObject({
		uri: null,
		connecting: false,
		address: "0xaddress",
	});
	await expect(connection.getProvider()).resolves.toBe(provider);
	expect(connect).toHaveBeenCalledTimes(1);
});
it("clears failed pairing codes and permits a fresh connection", async () => {
	vi.stubGlobal("window", {});
	let attempts = 0;
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async (show) => ({
		connect: async () => {
			show(`pairing-${++attempts}`);
			if (attempts === 1) throw new Error("Connection rejected");
			return { accounts: ["0xaddress"] };
		},
		getProvider: () => provider,
		disconnect: vi.fn(),
	}));
	await expect(connection.getProvider()).rejects.toThrow("Connection rejected");
	expect(connection.getSnapshot()).toMatchObject({
		uri: null,
		connecting: false,
		error: "Connection rejected",
	});
	await expect(connection.getProvider()).resolves.toBe(provider);
	expect(attempts).toBe(2);
});

it("keeps a QR available longer and renews it automatically while preserving the pending login", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", {});
	const first = deferred<{ accounts: string[] }>();
	const second = deferred<{ accounts: string[] }>();
	let attempts = 0;
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async (show) => {
		const attempt = ++attempts;
		return {
			connect: () => {
				show(`pairing-${attempt}`);
				return attempt === 1 ? first.promise : second.promise;
			},
			getProvider: () => provider,
			disconnect: vi.fn(async () => {}),
		};
	});
	const pairing = connection.getProvider();
	await vi.advanceTimersByTimeAsync(0);
	expect(connection.getSnapshot().uri).toBe("pairing-1");
	await vi.advanceTimersByTimeAsync(90_000);
	expect(connection.getSnapshot().uri).toBe("pairing-1");
	await vi.advanceTimersByTimeAsync(210_000);
	expect(connection.getSnapshot()).toMatchObject({
		uri: "pairing-2",
		error: null,
		connecting: true,
	});
	second.resolve({ accounts: ["0xaddress"] });
	await expect(pairing).resolves.toBe(provider);
});

it("retries a transport timeout with a fresh QR instead of exposing an error", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", {});
	const first = deferred<{ accounts: string[] }>();
	const second = deferred<{ accounts: string[] }>();
	let attempts = 0;
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async (show) => {
		const attempt = ++attempts;
		return {
			connect: () => {
				show(`pairing-${attempt}`);
				return attempt === 1 ? first.promise : second.promise;
			},
			getProvider: () => provider,
			disconnect: vi.fn(async () => {}),
		};
	});
	const pairing = connection.getProvider();
	await vi.advanceTimersByTimeAsync(0);
	first.reject(new Error("Transport request timed out"));
	await vi.advanceTimersByTimeAsync(1_000);
	expect(connection.getSnapshot()).toMatchObject({
		uri: "pairing-2",
		error: null,
		connecting: true,
	});
	second.resolve({ accounts: ["0xaddress"] });
	await pairing;
});

it("stops automatic QR renewal when the user cancels or logs out", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", {});
	const provider: WalletProvider = { request: vi.fn() };
	const createMobile = vi.fn(async (show: (uri: string) => void) => ({
		connect: () => {
			show("pairing-1");
			return new Promise<{ accounts: string[] }>(() => {});
		},
		getProvider: () => provider,
		disconnect: vi.fn(async () => {}),
	}));
	const connection = createWalletConnection(createMobile);
	const pairing = connection.getProvider();
	const cancelled = expect(pairing).rejects.toThrow("cancelled");
	await vi.advanceTimersByTimeAsync(0);
	await connection.disconnect();
	await cancelled;
	await vi.advanceTimersByTimeAsync(900_000);
	expect(createMobile).toHaveBeenCalledTimes(1);
	expect(connection.getSnapshot()).toEqual({
		uri: null,
		connecting: false,
		address: null,
		error: null,
	});
});

it("recovers an expired stored pairing before the first replacement QR is available", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", {});
	let attempts = 0;
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async (show) => {
		if (++attempts === 1) throw new Error("Transport request timed out");
		return {
			connect: async () => {
				show("replacement-QR");
				return { accounts: ["0xaddress"] };
			},
			getProvider: () => provider,
			disconnect: vi.fn(async () => {}),
		};
	});
	const pairing = connection.startAutoPairing();
	await vi.advanceTimersByTimeAsync(1_000);
	await expect(pairing).resolves.toBe(provider);
	expect(attempts).toBe(2);
	expect(connection.getSnapshot().error).toBeNull();
});
it("cancelled connections cannot overwrite a later connection", async () => {
	vi.stubGlobal("window", {});
	const old = deferred<{ accounts: string[] }>();
	const next = deferred<{ accounts: string[] }>();
	let attempts = 0;
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async (show) => {
		const current = ++attempts;
		return {
			connect: () => {
				show(`pairing-${current}`);
				return current === 1 ? old.promise : next.promise;
			},
			getProvider: () => provider,
			disconnect: vi.fn(),
		};
	});
	const first = connection.getProvider();
	await vi.waitFor(() =>
		expect(connection.getSnapshot().uri).toBe("pairing-1"),
	);
	connection.cancel();
	await expect(first).rejects.toThrow("cancelled");
	const second = connection.getProvider();
	await vi.waitFor(() =>
		expect(connection.getSnapshot().uri).toBe("pairing-2"),
	);
	old.resolve({ accounts: ["old-address"] });
	await Promise.resolve();
	expect(connection.getSnapshot().uri).toBe("pairing-2");
	next.resolve({ accounts: ["new-address"] });
	await second;
	expect(connection.getSnapshot().address).toBe("new-address");
});
it("signs UTF-8 text as a hex personal_sign payload compatible with MetaMask Mobile", async () => {
	const request = vi.fn().mockResolvedValue("0xsignature");
	await expect(
		signWalletMessage({ request }, "hello", "0xaddress"),
	).resolves.toBe("0xsignature");
	expect(request).toHaveBeenCalledWith({
		method: "personal_sign",
		params: ["0x68656c6c6f", "0xaddress"],
	});
});

it("allows a new pairing when MetaMask Mobile disconnects", async () => {
	vi.stubGlobal("window", {});
	let disconnected: () => void = () => {};
	const provider: WalletProvider = { request: vi.fn() };
	const createMobile = vi.fn(
		async (_show: (uri: string) => void, onDisconnect: () => void) => {
			disconnected = onDisconnect;
			return {
				connect: async () => ({ accounts: ["0xaddress"] }),
				getProvider: () => provider,
				disconnect: vi.fn(),
			};
		},
	);
	const connection = createWalletConnection(createMobile);
	await connection.getProvider();
	disconnected();
	expect(connection.getSnapshot().address).toBeNull();
	await expect(connection.getProvider()).resolves.toBe(provider);
	expect(createMobile).toHaveBeenCalledTimes(2);
});

it("clears wallet identity on logout and waits for SDK disconnection before reconnecting", async () => {
	const released = deferred<void>();
	const provider: WalletProvider = { request: vi.fn() };
	const disconnect = vi.fn(() => released.promise);
	const createMobile = vi.fn(async () => ({
		connect: async () => ({ accounts: ["0xold-address"] }),
		getProvider: () => provider,
		disconnect,
	}));
	const connection = createWalletConnection(createMobile);
	await connection.getProvider();
	const ending = connection.disconnect();
	expect(connection.getSnapshot()).toEqual({
		uri: null,
		connecting: false,
		address: null,
		error: null,
	});
	const reconnecting = connection.getProvider();
	await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
	expect(createMobile).toHaveBeenCalledTimes(1);
	released.resolve();
	await ending;
	await reconnecting;
	expect(createMobile).toHaveBeenCalledTimes(2);
});

it("disconnects an SDK that finishes initializing after logout without connecting it", async () => {
	const provider: WalletProvider = { request: vi.fn() };
	const client = {
		connect: vi.fn(async () => ({ accounts: ["0xold-address"] })),
		getProvider: () => provider,
		disconnect: vi.fn(async () => {}),
	};
	const initialization = deferred<typeof client>();
	const createMobile = vi.fn(() => initialization.promise);
	const connection = createWalletConnection(createMobile);
	const pairing = connection.getProvider();
	await vi.waitFor(() => expect(createMobile).toHaveBeenCalledTimes(1));
	const ending = connection.disconnect();
	await expect(pairing).rejects.toThrow("cancelled");
	initialization.resolve(client);
	await ending;
	expect(client.disconnect).toHaveBeenCalledTimes(1);
	expect(client.connect).not.toHaveBeenCalled();
	expect(connection.getSnapshot()).toEqual({
		uri: null,
		connecting: false,
		address: null,
		error: null,
	});
});

it("does not automatically reconnect when the login card remounts after logout", async () => {
	const provider: WalletProvider = { request: vi.fn() };
	const createMobile = vi.fn(async () => ({
		connect: async () => ({ accounts: ["0xold-address"] }),
		getProvider: () => provider,
		disconnect: vi.fn(async () => {}),
	}));
	const connection = createWalletConnection(createMobile);
	await connection.getProvider();
	await connection.disconnect();
	await connection.startAutoPairing();
	expect(createMobile).toHaveBeenCalledTimes(1);
	expect(connection.getSnapshot().address).toBeNull();
	await connection.getProvider();
	expect(createMobile).toHaveBeenCalledTimes(2);
});

it("keeps automatic wallet restoration disabled after reloading a logged-out tab", async () => {
	const saved = new Map<string, string>();
	vi.stubGlobal("window", {
		sessionStorage: {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => {
				saved.set(key, value);
			},
			removeItem: (key: string) => {
				saved.delete(key);
			},
		},
	});
	const createMobile = vi.fn(async () => ({
		connect: async () => ({ accounts: ["0xaddress"] }),
		getProvider: () => ({ request: vi.fn() }),
		disconnect: vi.fn(async () => {}),
	}));
	const beforeReload = createWalletConnection(createMobile);
	await beforeReload.getProvider();
	await beforeReload.disconnect();
	const afterReload = createWalletConnection(createMobile);
	await afterReload.startAutoPairing();
	expect(createMobile).toHaveBeenCalledTimes(1);
	expect(afterReload.getSnapshot().address).toBeNull();
	await afterReload.getProvider();
	expect(createMobile).toHaveBeenCalledTimes(2);
});

it("reports a failed wallet revocation and allows retrying the same SDK connection", async () => {
	const disconnect = vi
		.fn()
		.mockRejectedValueOnce(new Error("Wallet offline"))
		.mockResolvedValueOnce(undefined);
	const provider: WalletProvider = { request: vi.fn() };
	const connection = createWalletConnection(async () => ({
		connect: async () => ({ accounts: ["0xaddress"] }),
		getProvider: () => provider,
		disconnect,
	}));
	await connection.getProvider();
	await expect(connection.disconnect()).rejects.toThrow("Wallet offline");
	expect(connection.getSnapshot().address).toBeNull();
	await connection.disconnect();
	expect(disconnect).toHaveBeenCalledTimes(2);
});

it("refreshes QR listeners when retrying with the SDK's singleton client", async () => {
	vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
	const events = new Map<string, (value: string) => void>();
	const provider = {
		request: vi.fn(),
		on: (event: string, callback: (value: string) => void) => {
			events.set(event, callback);
		},
		removeListener: (event: string, callback: (value: string) => void) => {
			if (events.get(event) === callback) events.delete(event);
		},
	};
	const next = deferred<{ accounts: string[] }>();
	let attempts = 0;
	const client = {
		getProvider: () => provider,
		disconnect: vi.fn(),
		connect: async () => {
			events.get("display_uri")?.(`real-sdk-pairing-${++attempts}`);
			if (attempts === 1) throw new Error("Rejected");
			return next.promise;
		},
	};
	vi.mocked(createEVMClient).mockResolvedValue(
		client as unknown as Awaited<ReturnType<typeof createEVMClient>>,
	);
	const connection = createWalletConnection();
	await expect(connection.getProvider()).rejects.toThrow("Rejected");
	expect(createEVMClient).toHaveBeenLastCalledWith(
		expect.objectContaining({
			ui: { headless: true, preferExtension: true, showInstallModal: false },
		}),
	);
	const retry = connection.getProvider();
	await vi.waitFor(() =>
		expect(connection.getSnapshot().uri).toBe("real-sdk-pairing-2"),
	);
	next.resolve({ accounts: ["0xaddress"] });
	await expect(retry).resolves.toBe(provider);
	expect(createEVMClient).toHaveBeenCalledTimes(1);
});
