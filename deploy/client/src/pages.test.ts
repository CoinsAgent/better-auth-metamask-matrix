import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./auth-client", () => ({
	authClient: { oauth2: {} },
	signIn: {},
	signUp: {},
	useSession: () => ({ data: null, isPending: false, refetch: vi.fn() }),
}));
vi.mock("./navigation", async (original) => {
	const actual = await original<typeof import("./navigation")>();
	return { ...actual, usePage: () => location.pathname + location.search };
});

import { App } from "./App";
import { loginLink } from "./navigation";

afterEach(() => vi.unstubAllGlobals());
function page(path: string) {
	vi.stubGlobal("location", new URL(`http://localhost:5173${path}`));
	vi.stubGlobal("localStorage", { getItem: () => "public-demo-client" });
	return renderToStaticMarkup(createElement(App));
}
it("keeps the signed interaction when changing login methods", () => {
	const query = "?client_id=matrix-synapse-local&sig=test&exp=123";
	expect(page(`/sign-in${query}`)).toContain(
		`/sign-in/wallet?client_id=matrix-synapse-local&amp;sig=test&amp;exp=123`,
	);
	expect(loginLink("/sign-in/email", query)).toBe(`/sign-in/email${query}`);
});
it("gives each auth method its own page", () => {
	const choose = page("/sign-in");
	expect(choose).not.toContain("<form");
	expect(choose).not.toContain("<svg");
	const email = page("/sign-in/email");
	expect(email).toContain("<form");
	expect(email).not.toContain("Connect MetaMask");
	expect(page("/sign-up")).toContain('autoComplete="new-password"');
});
it("separates registration, authorization and token stages", () => {
	const registration = page("/register");
	expect(registration).toContain("Register demo client");
	expect(registration).toContain("public-demo-client");
	expect(registration).not.toContain("Start authorization →</button>");
	const authorization = page("/authorize");
	expect(authorization).toContain("Start authorization");
	expect(authorization).not.toContain("Register demo client");
	expect(page("/tokens")).toContain("No application tokens");
});
it("keeps Matrix and logout on their own pages", () => {
	expect(page("/matrix")).toContain(
		"Use your Ethereum identity to sign in to Matrix",
	);
	expect(page("/sign-out")).toContain("Sign out of Element separately");
	expect(page("/session")).not.toContain("<form");
});
it("provides dedicated profile, refresh and revocation pages", () => {
	expect(page("/userinfo")).toContain("Your shared profile");
	expect(page("/tokens/refresh")).toContain("Refresh application access");
	expect(page("/tokens/revoke")).toContain("Revoke application access");
});
