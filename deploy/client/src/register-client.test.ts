import { stringToHex } from "viem";
import { afterEach, expect, it, vi } from "vitest";
import { authClient } from "./auth-client";
import { registerDemoClient } from "./register-client";
import { getWalletProvider } from "./wallet-connection";

vi.mock("./auth-client", () => ({
	authClient: { oauth2: { createClient: vi.fn() } },
}));
vi.mock("./wallet-connection", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wallet-connection")>()),
	getWalletProvider: vi.fn(),
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

function wallet(signature: () => Promise<string> = async () => "0xsignature") {
	const request = vi.fn(async ({ method }: { method: string }) => {
		if (method === "eth_requestAccounts")
			return ["0x000000000000000000000000000000000000dEaD"];
		if (method === "eth_chainId") return "0x1";
		return signature();
	});
	vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
	vi.mocked(getWalletProvider).mockResolvedValue({ request });
	return request;
}

it("gets a new challenge and wallet signature for every registration", async () => {
	const request = wallet();
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					challengeId: "first",
					message: "Approve first registration",
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					challengeId: "second",
					message: "Approve second registration",
				}),
			}),
	);
	vi.mocked(authClient.oauth2.createClient).mockResolvedValue({
		data: { client_id: "client-id" },
		error: null,
	} as Awaited<ReturnType<typeof authClient.oauth2.createClient>>);
	await expect(registerDemoClient()).resolves.toBe("client-id");
	await expect(registerDemoClient()).resolves.toBe("client-id");
	expect(request).toHaveBeenCalledWith({
		method: "personal_sign",
		params: [
			stringToHex("Approve first registration"),
			"0x000000000000000000000000000000000000dEaD",
		],
	});
	expect(request).toHaveBeenCalledWith({
		method: "personal_sign",
		params: [
			stringToHex("Approve second registration"),
			"0x000000000000000000000000000000000000dEaD",
		],
	});
	expect(
		vi
			.mocked(authClient.oauth2.createClient)
			.mock.calls.map((call) => call[1]?.headers),
	).toEqual([
		{
			"x-registration-challenge": "first",
			"x-registration-signature": "0xsignature",
		},
		{
			"x-registration-challenge": "second",
			"x-registration-signature": "0xsignature",
		},
	]);
});
it("does not register when the user rejects the wallet prompt", async () => {
	wallet(async () => {
		throw new Error("User rejected signature");
	});
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				challengeId: "challenge",
				message: "Approve registration",
			}),
		}),
	);
	await expect(registerDemoClient()).rejects.toThrow("User rejected");
	expect(authClient.oauth2.createClient).not.toHaveBeenCalled();
});
it("does not ask for a signature when the server rejects the selected wallet", async () => {
	const request = wallet();
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: false,
			json: async () => ({ message: "Wallet is not linked" }),
		}),
	);
	await expect(registerDemoClient()).rejects.toThrow("Wallet is not linked");
	expect(
		request.mock.calls.some(
			([argument]) => argument.method === "personal_sign",
		),
	).toBe(false);
	expect(authClient.oauth2.createClient).not.toHaveBeenCalled();
});
