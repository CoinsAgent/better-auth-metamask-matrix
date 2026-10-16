import { stringToHex } from "viem";

/** Minimal EIP-1193 interface shared by browser and mobile wallet connections. */
export interface WalletProvider {
	request(args: {
		method: string;
		params?: unknown[] | Record<string, unknown>;
	}): Promise<unknown>;
	isMetaMask?: boolean;
	providers?: WalletProvider[];
}
declare global {
	interface Window {
		ethereum?: WalletProvider;
	}
}
interface MobileClient {
	connect(): Promise<{ accounts: string[] }>;
	getProvider(): WalletProvider;
	disconnect(): Promise<void> | void;
}
interface ConnectionState {
	uri: string | null;
	connecting: boolean;
	address: string | null;
	error: string | null;
}

let removeSDKListeners = () => {};
type MetaMaskClient = Awaited<
	ReturnType<typeof import("@metamask/connect-evm").createEVMClient>
>;
let sdkClientPromise: Promise<MetaMaskClient> | undefined;
/** Internal expiry signal; mobile QR expiry is renewed automatically. */
export const walletPairingTimeoutMessage =
	"Connection timed out. Generate a new QR code and try again.";
/** Lifetime of each mobile pairing QR, matching the patched protocol request TTL. */
export const walletPairingDurationMs = 5 * 60_000;
const walletLogoutKey = "better-auth-demo:wallet-logged-out";

function hasLogoutMarker() {
	try {
		return (
			typeof window !== "undefined" &&
			window.sessionStorage?.getItem(walletLogoutKey) === "true"
		);
	} catch {
		return false;
	}
}
function saveLogoutMarker(loggedOut: boolean) {
	try {
		if (typeof window === "undefined") return;
		if (loggedOut) window.sessionStorage?.setItem(walletLogoutKey, "true");
		else window.sessionStorage?.removeItem(walletLogoutKey);
	} catch {
		/* Wallet access still works when browser storage is disabled. */
	}
}

async function mobileClient(
	onURI: (uri: string) => void,
	onDisconnect: () => void,
): Promise<MobileClient> {
	const { createEVMClient } = await import("@metamask/connect-evm");
	sdkClientPromise ??= createEVMClient({
		dapp: {
			name: "Better Auth · Sign in with Ethereum",
			url: window.location.origin,
		},
		api: {
			supportedNetworks: {
				"0x1": import.meta.env.VITE_ETH_RPC_URL ?? "https://cloudflare-eth.com",
			},
		},
		// React embeds the live pairing URI. The SDK must never open QR dialogs.
		ui: { headless: true, preferExtension: true, showInstallModal: false },
		analytics: { enabled: false },
		skipAutoAnnounce: true,
	}).catch((error: unknown) => {
		sdkClientPromise = undefined;
		throw error;
	});
	const client = await sdkClientPromise;
	// The SDK is a singleton: refresh listeners for each pairing attempt.
	const provider = client.getProvider();
	removeSDKListeners();
	provider.on("display_uri", onURI);
	provider.on("disconnect", onDisconnect);
	removeSDKListeners = () => {
		provider.removeListener("display_uri", onURI);
		provider.removeListener("disconnect", onDisconnect);
	};
	let pending: ReturnType<typeof client.connect> | undefined;
	return {
		connect: () => {
			pending = client.connect();
			return pending;
		},
		getProvider: () => provider as WalletProvider,
		disconnect: async () => {
			await client.disconnect();
			// Finish the old singleton attempt before a replacement can use it.
			await pending?.catch(() => {});
		},
	};
}

/** Coordinate one mobile pairing session and expose its live QR URI to React. */
export function createWalletConnection(createMobile = mobileClient) {
	let state: ConnectionState = {
		uri: null,
		connecting: false,
		address: null,
		error: null,
	};
	const listeners = new Set<() => void>();
	let mobile: MobileClient | undefined;
	let initializing: Promise<MobileClient> | undefined;
	let active: WalletProvider | undefined;
	let flight: Promise<WalletProvider> | undefined;
	let cancelFlight: ((reason: string) => void) | undefined;
	let generation = 0;
	let disconnecting = Promise.resolve();
	let pendingDisconnection: Promise<MobileClient> | undefined;
	let allowAutoPairing = true;
	function update(next: Partial<ConnectionState>) {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	}
	function cancel(
		reason = "Wallet connection cancelled. You can try again.",
		silent = false,
	) {
		generation++;
		cancelFlight?.(reason || "Wallet connection cancelled.");
		cancelFlight = undefined;
		flight = undefined;
		active = undefined;
		update({
			uri: null,
			connecting: false,
			address: null,
			error: silent ? null : reason,
		});
		return closeCurrentClient();
	}
	function closeCurrentClient() {
		const previous = mobile
			? Promise.resolve(mobile)
			: (initializing ?? pendingDisconnection);
		mobile = undefined;
		initializing = undefined;
		pendingDisconnection = previous;
		const ending = disconnecting
			.then(async () => (await previous)?.disconnect())
			.then(() => {
				if (pendingDisconnection === previous) pendingDisconnection = undefined;
			});
		// Keep the queue usable, but return the real result so logout can report failure.
		disconnecting = ending.catch(() => {});
		return ending;
	}
	async function getProvider(
		options: { renewOnTimeout?: boolean } = {},
	): Promise<WalletProvider> {
		allowAutoPairing = true;
		saveLogoutMarker(false);
		if (active) return active;
		if (flight !== undefined) return flight;
		const current = ++generation;
		update({ connecting: true, uri: null, error: null });
		let clearAttemptTimer = () => {};
		const cancelled = new Promise<never>((_, reject) => {
			cancelFlight = (reason) => {
				clearAttemptTimer();
				reject(new Error(reason));
			};
		});
		let attempt = 0;
		let renewOnTimeout = options.renewOnTimeout ?? false;
		const connect = async (): Promise<WalletProvider> => {
			await disconnecting;
			if (
				mobile ||
				initializing !== undefined ||
				pendingDisconnection !== undefined
			)
				await closeCurrentClient();
			while (generation === current) {
				const currentAttempt = ++attempt;
				let timer: ReturnType<typeof setTimeout> | undefined;
				clearAttemptTimer = () => clearTimeout(timer);
				let expire!: (error: Error) => void;
				const expired = new Promise<never>((_, reject) => {
					expire = reject;
				});
				void expired.catch(() => {});
				const setExpiry = (duration: number) => {
					clearTimeout(timer);
					timer = setTimeout(
						() => expire(new Error(walletPairingTimeoutMessage)),
						duration,
					);
				};
				setExpiry(walletPairingDurationMs + 60_000);
				try {
					const initialization = createMobile(
						(uri) => {
							if (generation !== current || attempt !== currentAttempt) return;
							renewOnTimeout = true;
							update({ uri, error: null });
							// Renew just before the protocol request expires.
							setExpiry(walletPairingDurationMs - 1_000);
						},
						() => {
							if (
								generation === current &&
								attempt === currentAttempt &&
								active
							) {
								active = undefined;
								update({
									address: null,
									uri: null,
									error: "Wallet disconnected. Connect again to continue.",
								});
							}
						},
					);
					initializing = initialization;
					const candidate = await initialization.finally(() => {
						if (initializing === initialization) initializing = undefined;
					});
					if (generation !== current)
						throw new Error("Wallet connection cancelled.");
					mobile = candidate;
					const result = await Promise.race([candidate.connect(), expired]);
					if (generation !== current)
						throw new Error("Wallet connection cancelled.");
					if (!result.accounts[0])
						throw new Error("MetaMask returned no wallet account.");
					active = candidate.getProvider();
					update({ address: result.accounts[0] });
					return active;
				} catch (error) {
					if (generation !== current) throw error;
					const timeout =
						error instanceof Error &&
						/timed out|timeout|request expired|handshake.*in time/i.test(
							error.message,
						);
					if (!renewOnTimeout || !timeout) throw error;
					// Ignore old SDK events while its relay and pending handshake close.
					attempt++;
					update({ uri: null, connecting: true, error: null });
					await closeCurrentClient();
					if (generation !== current)
						throw new Error("Wallet connection cancelled.");
					await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
				} finally {
					clearTimeout(timer);
				}
			}
			throw new Error("Wallet connection cancelled.");
		};
		const request = Promise.race([connect(), cancelled])
			.catch((error: unknown) => {
				if (generation === current)
					update({
						error:
							error instanceof Error
								? error.message
								: "Could not connect to MetaMask.",
					});
				throw error;
			})
			.finally(() => {
				if (generation === current) {
					cancelFlight = undefined;
					flight = undefined;
					update({ uri: null, connecting: false });
				}
			});
		flight = request;
		return request;
	}
	return {
		getProvider,
		cancel,
		/** Start initial page-load pairing, but never resume it automatically after logout. */
		startAutoPairing: () =>
			allowAutoPairing && !hasLogoutMarker()
				? getProvider({ renewOnTimeout: true })
				: Promise.resolve(undefined),
		/** Clear all local wallet identity and finish disconnecting the SDK session. */
		disconnect: () => {
			allowAutoPairing = false;
			saveLogoutMarker(true);
			return cancel("", true);
		},
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
export const walletConnection = createWalletConnection();

/** Discover MetaMask without requesting account access or opening a wallet prompt. */
export async function hasMetaMaskExtension(): Promise<boolean> {
	if (
		window.ethereum?.isMetaMask ||
		window.ethereum?.providers?.some((provider) => provider.isMetaMask)
	)
		return true;
	// EIP-6963 also detects MetaMask alongside other installed wallet extensions.
	return new Promise((resolve) => {
		function finish(found: boolean) {
			clearTimeout(timer);
			window.removeEventListener("eip6963:announceProvider", announced);
			resolve(found);
		}
		function announced(event: Event) {
			const detail = (
				event as CustomEvent<{
					info?: { rdns?: string };
					provider?: WalletProvider;
				}>
			).detail;
			if (
				detail?.info?.rdns === "io.metamask" &&
				typeof detail.provider?.request === "function"
			)
				finish(true);
		}
		const timer = setTimeout(() => finish(false), 300);
		window.addEventListener("eip6963:announceProvider", announced);
		window.dispatchEvent(new Event("eip6963:requestProvider"));
	});
}

/** Let MetaMask Connect select its extension or a headless mobile pairing session. */
export function getWalletProvider() {
	return walletConnection.getProvider();
}

/** Sign UTF-8 text using the EIP-191 format accepted by mobile and extension wallets. */
export async function signWalletMessage(
	wallet: WalletProvider,
	message: string,
	address: string,
) {
	const signature = await wallet.request({
		method: "personal_sign",
		params: [stringToHex(message), address],
	});
	if (typeof signature !== "string")
		throw new Error("Wallet returned no signature.");
	return signature;
}
