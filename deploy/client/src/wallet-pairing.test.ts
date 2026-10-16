import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { WalletPairing } from "./WalletPairing";
import { walletConnection } from "./wallet-connection";

afterEach(() => vi.restoreAllMocks());

it("embeds the live QR and Use extension control without a popup dialog", () => {
	vi.spyOn(walletConnection, "getSnapshot").mockReturnValue({
		uri: "metamask://live-pairing-test",
		connecting: true,
		address: null,
		error: null,
	});
	const page = renderToStaticMarkup(createElement(WalletPairing));
	expect(page).toContain("<svg");
	expect(page).toContain('href="/metamask-fox.svg"');
	expect(page).toContain("Use extension");
	expect(page).not.toContain('role="dialog"');
	expect(page).not.toContain("modal-backdrop");
});

it("keeps the extension alternative visible while the QR is loading", () => {
	vi.spyOn(walletConnection, "getSnapshot").mockReturnValue({
		uri: null,
		connecting: true,
		address: null,
		error: null,
	});
	const page = renderToStaticMarkup(createElement(WalletPairing));
	expect(page).toContain("Use extension");
	expect(page).toContain("Preparing your connection");
});

it("shows renewal progress without a circular refresh control or timeout alert", () => {
	vi.spyOn(walletConnection, "getSnapshot").mockReturnValue({
		uri: null,
		connecting: true,
		address: null,
		error: null,
	});
	const page = renderToStaticMarkup(createElement(WalletPairing));
	expect(page).toContain("Preparing your connection");
	expect(page).not.toContain('aria-label="Refresh QR code"');
	expect(page).not.toContain('class="qr-refresh"');
	expect(page).not.toContain("Connection timed out");
	expect(page).not.toContain("Generate a new QR code");
	expect(page).not.toContain('role="alert"');
	expect(page).toContain("Use extension");
});

it("continues to display other wallet errors", () => {
	vi.spyOn(walletConnection, "getSnapshot").mockReturnValue({
		uri: null,
		connecting: false,
		address: null,
		error: "Connection rejected",
	});
	const page = renderToStaticMarkup(createElement(WalletPairing));
	expect(page).toContain("Connection rejected");
	expect(page).toContain('role="alert"');
});
