import { afterEach, expect, it, vi } from "vitest";
import { hasMetaMaskExtension } from "./wallet-connection";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("recognizes injected MetaMask without requesting account access", async () => {
	const request = vi.fn();
	vi.stubGlobal("window", { ethereum: { isMetaMask: true, request } });
	await expect(hasMetaMaskExtension()).resolves.toBe(true);
	expect(request).not.toHaveBeenCalled();
});

it("discovers MetaMask alongside another wallet through EIP-6963", async () => {
	const browser = new EventTarget();
	const request = vi.fn();
	browser.addEventListener("eip6963:requestProvider", () => {
		browser.dispatchEvent(
			new CustomEvent("eip6963:announceProvider", {
				detail: { info: { rdns: "io.metamask" }, provider: { request } },
			}),
		);
	});
	vi.stubGlobal("window", browser);
	await expect(hasMetaMaskExtension()).resolves.toBe(true);
	expect(request).not.toHaveBeenCalled();
});

it("reports no MetaMask after discovery when only another wallet is installed", async () => {
	vi.useFakeTimers();
	const browser = Object.assign(new EventTarget(), {
		ethereum: { request: vi.fn() },
	});
	browser.addEventListener("eip6963:requestProvider", () => {
		browser.dispatchEvent(
			new CustomEvent("eip6963:announceProvider", {
				detail: {
					info: { rdns: "com.other.wallet" },
					provider: browser.ethereum,
				},
			}),
		);
	});
	vi.stubGlobal("window", browser);
	const detection = hasMetaMaskExtension();
	await vi.advanceTimersByTimeAsync(300);
	await expect(detection).resolves.toBe(false);
	expect(browser.ethereum.request).not.toHaveBeenCalled();
});
