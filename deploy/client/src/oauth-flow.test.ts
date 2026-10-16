import { afterEach, expect, it, vi } from "vitest";
import { challenge, finishAuthorization } from "./oauth-flow";

function pending(state = "expected") {
	vi.stubGlobal("sessionStorage", {
		getItem: () =>
			JSON.stringify({ state, verifier: "verifier", clientId: "client" }),
		removeItem: vi.fn(),
	});
}
afterEach(() => vi.unstubAllGlobals());

/** @see https://www.rfc-editor.org/rfc/rfc7636#appendix-B */
it("matches the published S256 PKCE test vector", async () => {
	expect(await challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
		"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
	);
});

it("rejects mismatched state before sending the code", async () => {
	pending();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		finishAuthorization("?code=code&state=attacker"),
	).rejects.toThrow("state mismatch");
	expect(fetch).not.toHaveBeenCalled();
});
it("rejects a mismatched issuer before sending the code", async () => {
	pending();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		finishAuthorization(
			"?code=code&state=expected&iss=https://attacker.example",
		),
	).rejects.toThrow("issuer mismatch");
	expect(fetch).not.toHaveBeenCalled();
});
it("handles consent denial without exchanging a code", async () => {
	pending();
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(
		finishAuthorization(
			"?state=expected&iss=http://localhost:3100/api/auth&error=access_denied",
		),
	).rejects.toThrow("access_denied");
	expect(fetch).not.toHaveBeenCalled();
});
it("exchanges a valid callback with the saved verifier and exact redirect URI", async () => {
	pending();
	const fetch = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({ access_token: "token" }),
	});
	vi.stubGlobal("fetch", fetch);
	expect(
		(
			await finishAuthorization(
				"?state=expected&iss=http://localhost:3100/api/auth&code=code",
			)
		).tokens.access_token,
	).toBe("token");
	const body = fetch.mock.calls[0]?.[1].body as URLSearchParams;
	expect(Object.fromEntries(body)).toEqual({
		grant_type: "authorization_code",
		client_id: "client",
		code: "code",
		code_verifier: "verifier",
		redirect_uri: "http://localhost:5173/oauth/callback",
	});
});

/** @see https://datatracker.ietf.org/doc/html/rfc7009#section-2.1 */
it("revokes refresh-backed access once because the provider cascades refresh revocation", async () => {
	const { revokeTokens } = await import("./oauth-flow");
	const fetch = vi
		.fn()
		.mockResolvedValueOnce({ ok: true })
		.mockResolvedValue({ ok: false });
	vi.stubGlobal("fetch", fetch);
	await expect(
		revokeTokens("client", {
			access_token: "access",
			refresh_token: "refresh",
			expires_in: 3600,
			scope: "openid offline_access",
		}),
	).resolves.toBeUndefined();
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(
		Object.fromEntries(fetch.mock.calls[0]?.[1].body as URLSearchParams),
	).toMatchObject({ token: "refresh", token_type_hint: "refresh_token" });
});
it("revokes access directly when no refresh token was issued", async () => {
	const { revokeTokens } = await import("./oauth-flow");
	const fetch = vi.fn().mockResolvedValue({ ok: true });
	vi.stubGlobal("fetch", fetch);
	await revokeTokens("client", {
		access_token: "access",
		expires_in: 3600,
		scope: "openid",
	});
	expect(
		Object.fromEntries(fetch.mock.calls[0]?.[1].body as URLSearchParams),
	).toMatchObject({ token: "access", token_type_hint: "access_token" });
});
