import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/** @see https://github.com/element-hq/element-web/blob/v1.12.31/docs/config.md#sso-setup */
it("keeps Element on the wallet welcome page until the user starts SSO", () => {
	const config = JSON.parse(
		readFileSync(
			new URL("../../matrix/element-config.json", import.meta.url),
			"utf8",
		),
	);
	expect(config.sso_redirect_options.immediate).toBe(false);
	expect(config.sso_redirect_options.on_welcome_page).toBe(false);
	expect(config.embedded_pages.welcome_url).toBe("/wallet-welcome.html");
	const welcome = readFileSync(
		new URL("../../matrix/welcome.html", import.meta.url),
		"utf8",
	);
	expect(welcome).toContain("Welcome to Matrix");
	expect(welcome).toContain("Sign in with MetaMask");
	// Element replaces this supported placeholder with its internal #/start_sso route.
	expect(welcome).toContain('href="$riot:ssoUrl"');
	expect(welcome).not.toContain("<script");
});
