import { QRCodeSVG } from "qrcode.react";
import { useSyncExternalStore } from "react";
import { walletConnection } from "./wallet-connection";

/** Embed a live MetaMask Mobile pairing QR and the extension alternative. */
export function WalletPairing({ visible = false }: { visible?: boolean }) {
	const state = useSyncExternalStore(
		walletConnection.subscribe,
		walletConnection.getSnapshot,
		walletConnection.getSnapshot,
	);
	function refresh() {
		void walletConnection.getProvider({ renewOnTimeout: true }).catch(() => {});
	}
	if (!visible && !state.connecting && !state.error) return null;
	return (
		<div className="pairing-card">
			<div className="pairing-heading">
				<span className="mobile-symbol" aria-hidden="true">
					▣
				</span>
				<div>
					<h3>Connect MetaMask Mobile</h3>
					<p>Scan with the scanner in your MetaMask app.</p>
				</div>
			</div>
			{state.uri ? (
				<div className="qr-frame">
					<QRCodeSVG
						value={state.uri}
						size={400}
						level="H"
						marginSize={4}
						imageSettings={{
							src: "/metamask-fox.svg",
							width: 58,
							height: 58,
							excavate: true,
						}}
						title="Scan with MetaMask Mobile to connect your wallet"
					/>
				</div>
			) : state.connecting ? (
				<div className="qr-loading" role="status">
					<span className="spinner" />
					Preparing your connection…
				</div>
			) : null}
			{state.uri && (
				<p className="pairing-note">
					Approve the connection on your phone, then sign in here.
				</p>
			)}
			{state.error && (
				<p className="alert" role="alert">
					{state.error}
				</p>
			)}
			<div className="actions centered">
				<a
					className="button secondary"
					href="https://metamask.io/download/"
					target="_blank"
					rel="noreferrer"
				>
					Use extension ↗
				</a>
				{state.connecting ? (
					<button
						className="button ghost"
						onClick={() => walletConnection.cancel()}
					>
						Cancel connection
					</button>
				) : (
					<button className="button ghost" onClick={refresh}>
						Generate a new QR code
					</button>
				)}
			</div>
		</div>
	);
}
