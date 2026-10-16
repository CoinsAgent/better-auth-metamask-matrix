import { useEffect, useState, useSyncExternalStore } from "react";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { authClient } from "./auth-client";
import { WalletPairing } from "./WalletPairing";
import {
	getWalletProvider,
	hasMetaMaskExtension,
	signWalletMessage,
	walletConnection,
	walletPairingTimeoutMessage,
} from "./wallet-connection";

/** Authenticate through the same SIWE flow for injected and QR-connected wallets. */
export function WalletSignIn({ onDone }: { onDone: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [extension, setExtension] = useState<boolean>();
	const connection = useSyncExternalStore(
		walletConnection.subscribe,
		walletConnection.getSnapshot,
	);
	useEffect(() => {
		if (!connection.address) {
			setStatus("");
			setError("");
		}
	}, [connection.address]);
	useEffect(() => {
		let mounted = true;
		void hasMetaMaskExtension().then((installed) => {
			if (!mounted) return;
			setExtension(installed);
			// Generate the inline QR on load, but require a click to request signatures.
			if (!installed) void walletConnection.startAutoPairing().catch(() => {});
		});
		return () => {
			mounted = false;
		};
	}, []);
	async function connect() {
		setError("");
		try {
			await getWalletProvider();
		} catch (error) {
			setError(
				error instanceof Error
					? error.message
					: "Could not connect to MetaMask.",
			);
		}
	}
	async function login() {
		if (busy) return;
		setBusy(true);
		setError("");
		setStatus("Connect your wallet to continue…");
		try {
			const wallet = await getWalletProvider();
			const accounts = await wallet.request({ method: "eth_requestAccounts" });
			const selected =
				Array.isArray(accounts) && typeof accounts[0] === "string"
					? accounts[0]
					: undefined;
			if (!selected) throw new Error("No wallet account selected.");
			const addr = getAddress(selected);
			const rawChain = await wallet.request({ method: "eth_chainId" });
			const chainId =
				typeof rawChain === "string"
					? Number.parseInt(rawChain, 16)
					: Number.NaN;
			if (!Number.isSafeInteger(chainId) || chainId <= 0)
				throw new Error("Invalid wallet chain ID.");
			const nonce = await authClient.siwe.nonce();
			if (nonce.error || !nonce.data?.nonce)
				throw new Error(
					nonce.error?.message ?? "Could not obtain a sign-in nonce.",
				);
			const message = createSiweMessage({
				address: addr,
				chainId,
				domain: window.location.hostname,
				uri: window.location.origin,
				version: "1",
				nonce: nonce.data.nonce,
				statement: "Sign in with Ethereum to Better Auth.",
				expirationTime: new Date(Date.now() + 5 * 60_000),
			});
			setStatus("Approve the sign-in message in your wallet…");
			const signature = await signWalletMessage(wallet, message, addr);
			setStatus("Verifying your signature…");
			const verification = await authClient.siwe.verify({ message, signature });
			if (verification.error)
				throw new Error(
					verification.error.message ?? "Signature verification failed.",
				);
			await onDone();
			setStatus("Signed in. You're ready to continue.");
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not sign in.");
			setStatus("");
		} finally {
			setBusy(false);
		}
	}
	const selected = connection.address;
	return (
		<section className="card wallet-card" id="wallet-sign-in">
			<div className="section-heading">
				<span className="icon-tile">
					<img src="/reference/ethereum.svg" alt="" />
				</span>
				<div>
					<h2>Sign in with Ethereum</h2>
					<p>Your wallet is your identity.</p>
				</div>
			</div>
			{!selected &&
				(extension === false ||
					connection.error === walletPairingTimeoutMessage) && (
					<WalletPairing visible />
				)}
			{extension === undefined && (
				<p className="notice" role="status">
					Checking for MetaMask…
				</p>
			)}
			{selected && (
				<div className="wallet-account">
					<span className="status-dot" />
					<span>Wallet ready</span>
					<code title={selected}>
						{selected.slice(0, 6)}…{selected.slice(-4)}
					</code>
				</div>
			)}
			{(extension || selected) && (
				<p className="muted small">
					{selected
						? "Approve the sign-in message in MetaMask to continue."
						: "Connect MetaMask, then approve a sign-in message."}
				</p>
			)}
			{!selected ? (
				extension && (
					<button
						className="button primary full"
						disabled={busy || connection.connecting}
						onClick={() => void connect()}
					>
						{connection.connecting ? "Connecting…" : "Connect MetaMask"}
					</button>
				)
			) : (
				<button
					className="button primary full"
					disabled={busy}
					onClick={() => void login()}
				>
					<img src="/reference/eth-diamond-white.svg" alt="" />
					{busy ? "Signing in…" : "Sign in with Ethereum"}
				</button>
			)}
			{status && (
				<p className="notice" role="status">
					{status}
				</p>
			)}
			{error && error !== walletPairingTimeoutMessage && (
				<p className="alert" role="alert">
					{error}
				</p>
			)}
			<p className="fine-print">
				A signature proves wallet ownership. Signing in does not send a
				transaction.
			</p>
		</section>
	);
}
