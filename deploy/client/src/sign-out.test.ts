import { afterEach, expect, it, vi } from "vitest";
import { signOut } from "./auth-client";
import { signOutAndDisconnect } from "./sign-out";
import { walletConnection } from "./wallet-connection";

vi.mock("./auth-client", () => ({ signOut: vi.fn() }));
vi.mock("./wallet-connection", () => ({
	walletConnection: { disconnect: vi.fn() },
}));
afterEach(() => vi.resetAllMocks());

it("finishes wallet disconnection before authentication sign-out changes the login screen", async () => {
	let complete!: () => void;
	vi.mocked(walletConnection.disconnect).mockReturnValue(
		new Promise<void>((resolve) => {
			complete = resolve;
		}),
	);
	vi.mocked(signOut).mockResolvedValue({
		data: { success: true },
		error: null,
	});
	const logout = signOutAndDisconnect();
	expect(walletConnection.disconnect).toHaveBeenCalledTimes(1);
	expect(signOut).not.toHaveBeenCalled();
	complete();
	await logout;
	expect(signOut).toHaveBeenCalledTimes(1);
});

it("reports authentication sign-out errors after clearing the wallet", async () => {
	vi.mocked(walletConnection.disconnect).mockResolvedValue();
	vi.mocked(signOut).mockResolvedValue({
		data: null,
		error: {
			message: "Sign out failed",
			status: 500,
			statusText: "Server error",
		},
	});
	await expect(signOutAndDisconnect()).rejects.toThrow("Sign out failed");
	expect(walletConnection.disconnect).toHaveBeenCalledTimes(1);
});

it("still signs out of Better Auth and reports a failed wallet revocation", async () => {
	vi.mocked(walletConnection.disconnect).mockRejectedValue(
		new Error("Wallet offline"),
	);
	vi.mocked(signOut).mockResolvedValue({
		data: { success: true },
		error: null,
	});
	await expect(signOutAndDisconnect()).rejects.toThrow(
		"MetaMask did not confirm disconnection",
	);
	expect(signOut).toHaveBeenCalledTimes(1);
});
