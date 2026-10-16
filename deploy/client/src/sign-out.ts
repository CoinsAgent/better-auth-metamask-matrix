import { signOut } from "./auth-client";
import { walletConnection } from "./wallet-connection";

/** Disconnect the wallet before sign-out can render a fresh login screen. */
export async function signOutAndDisconnect() {
	let walletError: unknown;
	try {
		await walletConnection.disconnect();
	} catch (error) {
		walletError = error;
	}
	const result = await signOut();
	if (result.error)
		throw new Error(result.error.message ?? "Could not sign out.");
	if (walletError)
		throw new Error(
			`Signed out, but MetaMask did not confirm disconnection: ${walletError instanceof Error ? walletError.message : "Wallet unavailable"}. Open MetaMask and retry disconnection.`,
		);
}
