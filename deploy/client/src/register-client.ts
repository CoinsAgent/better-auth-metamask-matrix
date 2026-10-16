import { demoClientMetadata } from "../../shared/client-registration";
import { authClient } from "./auth-client";
import { getWalletProvider, signWalletMessage } from "./wallet-connection";

/** Obtain and sign a new wallet challenge for this registration attempt. */
export async function registerDemoClient() {
	const wallet = await getWalletProvider();
	const accounts = await wallet.request({ method: "eth_requestAccounts" });
	const address =
		Array.isArray(accounts) && typeof accounts[0] === "string"
			? accounts[0]
			: undefined;
	if (!address) throw new Error("No wallet account selected.");
	const rawChain = await wallet.request({ method: "eth_chainId" });
	const chainId =
		typeof rawChain === "string" ? Number.parseInt(rawChain, 16) : Number.NaN;
	if (!Number.isSafeInteger(chainId) || chainId <= 0)
		throw new Error("Invalid wallet chain ID.");
	const challengeResponse = await fetch(
		"/api/auth/client-registration/challenge",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ address, chainId }),
		},
	);
	const challenge: { challengeId?: string; message?: string; code?: string } =
		await challengeResponse.json();
	if (!challengeResponse.ok)
		throw new Error(
			challenge.message ?? "Could not obtain a wallet registration challenge.",
		);
	if (!challenge.challengeId || !challenge.message)
		throw new Error("Invalid registration challenge response.");
	const signature = await signWalletMessage(wallet, challenge.message, address);
	const response = await authClient.oauth2.createClient(demoClientMetadata(), {
		headers: {
			"x-registration-challenge": challenge.challengeId,
			"x-registration-signature": signature,
		},
	});
	if (response.error)
		throw new Error(response.error.message ?? "Client registration failed.");
	if (!response.data?.client_id)
		throw new Error("Client registration returned no client ID.");
	return response.data.client_id;
}
