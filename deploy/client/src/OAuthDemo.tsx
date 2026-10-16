import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth-client";
import { navigate, PageLink } from "./navigation";
import type { Tokens } from "./oauth-flow";
import {
	finishAuthorization,
	refreshTokens,
	revokeTokens,
	startAuthorization,
	userInfo,
} from "./oauth-flow";
import { registerDemoClient } from "./register-client";
import { walletPairingTimeoutMessage } from "./wallet-connection";

const permissions: Record<
	string,
	{ title: string; description: string; icon: string }
> = {
	openid: {
		title: "Sign you in",
		description: "Identify you to this application.",
		icon: "◇",
	},
	profile: {
		title: "View your profile",
		description: "Share your name and profile information.",
		icon: "○",
	},
	email: {
		title: "View your email address",
		description: "Share your email address and verification status.",
		icon: "@",
	},
	offline_access: {
		title: "Keep you connected",
		description: "Allow the app to renew access without another sign-in.",
		icon: "↻",
	},
};

/** Application registration, authorization controls, and the provider consent card. */
export function OAuthDemo({
	signedIn,
	path,
}: {
	signedIn: boolean;
	path: string;
}) {
	const callbackStarted = useRef(false);
	const [clientId, setClientId] = useState(
		localStorage.getItem("demo.oauth.client") ?? "",
	);
	const [tokens, setTokens] = useState<Tokens>();
	const [result, setResult] = useState<unknown>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [consentDetails, setConsentDetails] = useState<{
		scope: string;
		clientId: string;
		clientName?: string;
	}>();
	const consentPage = path === "/consent";
	useEffect(() => {
		if (!consentPage) return;
		setConsentDetails(undefined);
		setError("");
		void fetch(`/api/consent-details${location.search}`)
			.then(async (response) => {
				if (!response.ok)
					throw new Error(
						"Invalid or expired consent request. Start a new authorization from the client.",
					);
				setConsentDetails(await response.json());
			})
			.catch((error: unknown) =>
				setError(error instanceof Error ? error.message : String(error)),
			);
	}, [consentPage]);
	async function run(action: () => Promise<void>) {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setError(message === walletPairingTimeoutMessage ? "" : message);
			setMessage("");
		} finally {
			setBusy(false);
		}
	}
	useEffect(() => {
		if (path !== "/oauth/callback" || callbackStarted.current) return;
		callbackStarted.current = true;
		const search = location.search;
		history.replaceState({}, "", "/oauth/callback");
		void run(async () => {
			const completed = await finishAuthorization(search);
			setClientId(completed.clientId);
			setTokens(completed.tokens);
			setResult(await userInfo(completed.tokens.access_token));
			setMessage("Authorization complete. Your application is connected.");
			navigate("/tokens", true);
		});
	}, [path]);
	async function consent(accept: boolean) {
		const response = await authClient.oauth2.consent({ accept });
		if (response.error)
			throw new Error(
				response.error.message ?? "Could not complete authorization.",
			);
		if (response.data?.url) location.assign(response.data.url);
	}
	if (consentPage)
		return (
			<section className="card consent-card">
				<div className="app-bridge">
					<span className="bridge-logo">
						<img src="/reference/ethereum.svg" alt="Ethereum" />
					</span>
					<span className="bridge-line" aria-hidden="true">
						··· → ···
					</span>
					<span className="bridge-logo">
						<img src="/reference/client-logo.svg" alt="Application" />
					</span>
				</div>
				<h2>
					{consentDetails?.clientName ?? "Your application"} requests access
				</h2>
				<p className="muted">
					Choose whether to share your identity and allow the permissions below.
				</p>
				<div className="permissions">
					{consentDetails
						? consentDetails.scope
								.split(" ")
								.filter(Boolean)
								.map((scope) => {
									const permission = permissions[scope] ?? {
										title: scope,
										description:
											"Additional access requested by this application.",
										icon: "+",
									};
									return (
										<div className="permission" key={scope}>
											<span className="permission-icon" aria-hidden="true">
												{permission.icon}
											</span>
											<div>
												<strong>{permission.title}</strong>
												<p>{permission.description}</p>
											</div>
										</div>
									);
								})
						: !error && (
								<p className="notice" role="status">
									Checking the access request…
								</p>
							)}
				</div>
				{consentDetails && (
					<details>
						<summary>Application details</summary>
						<p className="small break-word">
							Client ID: <code>{consentDetails.clientId}</code>
						</p>
					</details>
				)}
				<div className="actions consent-actions">
					<button
						className="button secondary"
						disabled={busy || !signedIn || !consentDetails}
						onClick={() => void run(() => consent(false))}
					>
						Deny
					</button>
					<button
						className="button primary"
						disabled={busy || !signedIn || !consentDetails}
						onClick={() => void run(() => consent(true))}
					>
						{busy ? "Continuing…" : "Allow access →"}
					</button>
				</div>
				<p className="fine-print">
					The application receives only the access you approve.
				</p>
				{error && (
					<p className="alert" role="alert">
						{error}
					</p>
				)}
			</section>
		);
	return (
		<section className="card authorization-card">
			{path === "/register" && (
				<>
					<p className="muted">
						Register the Local PKCE demo with a fresh signature from a wallet
						linked to your account.
					</p>
					{!signedIn && (
						<p>
							<PageLink className="button secondary" href="/sign-in/wallet">
								Sign in with MetaMask first →
							</PageLink>
						</p>
					)}
					<button
						className="button primary full"
						disabled={busy || !signedIn}
						onClick={() =>
							void run(async () => {
								setMessage("Approve the registration message in your wallet…");
								const id = await registerDemoClient();
								localStorage.setItem("demo.oauth.client", id);
								setClientId(id);
								setMessage("Application registered.");
							})
						}
					>
						{busy ? "Waiting for approval…" : "Register demo client"}
					</button>
					{clientId && (
						<>
							<p className="notice">Client ID</p>
							<code className="client-id">{clientId}</code>
							<PageLink
								className="button secondary full next-link"
								href="/authorize"
							>
								Continue to authorization →
							</PageLink>
						</>
					)}
				</>
			)}
			{path === "/authorize" && (
				<>
					<p className="muted">
						Request access to your identity. You will sign in again and review
						the permissions on separate pages.
					</p>
					{clientId ? (
						<>
							<code className="client-id">{clientId}</code>
							<button
								className="button primary full next-link"
								disabled={busy}
								onClick={() => void run(() => startAuthorization(clientId))}
							>
								Start authorization →
							</button>
						</>
					) : (
						<PageLink className="button primary full" href="/register">
							Register an application first →
						</PageLink>
					)}
				</>
			)}
			{path === "/oauth/callback" && (
				<p role="status">
					{error
						? "Authorization could not be completed."
						: "Checking the callback and exchanging your authorization code…"}
				</p>
			)}
			{["/tokens", "/userinfo", "/tokens/refresh", "/tokens/revoke"].includes(
				path,
			) && (
				<>
					{tokens ? (
						<>
							{path === "/tokens" && (
								<>
									<p className="session-badge">
										<span className="status-dot" /> Application connected
									</p>
									<p className="muted">
										Access expires in {tokens.expires_in} seconds. Tokens stay
										in memory and are cleared when you leave this flow or
										reload.
									</p>
									<div className="page-options">
										<PageLink href="/userinfo">View shared profile →</PageLink>
										<PageLink href="/tokens/refresh">Refresh access →</PageLink>
										<PageLink href="/tokens/revoke">Revoke access →</PageLink>
									</div>
								</>
							)}
							{path === "/userinfo" && (
								<>
									<p>Read the identity shared with this application.</p>
									<button
										className="button primary full"
										disabled={busy}
										onClick={() =>
											void run(async () =>
												setResult(await userInfo(tokens.access_token)),
											)
										}
									>
										Call UserInfo
									</button>
									{result !== undefined && (
										<pre>{JSON.stringify(result, null, 2)}</pre>
									)}
								</>
							)}
							{path === "/tokens/refresh" && (
								<>
									<p>
										Exchange the current refresh token for new access. The
										refresh token rotates after use.
									</p>
									<button
										className="button primary full"
										disabled={busy || !tokens.refresh_token}
										onClick={() =>
											void run(async () => {
												if (tokens.refresh_token) {
													setTokens(
														await refreshTokens(clientId, tokens.refresh_token),
													);
													setMessage(
														"Access refreshed. Your refresh token was rotated.",
													);
												}
											})
										}
									>
										Refresh tokens
									</button>
								</>
							)}
							{path === "/tokens/revoke" && (
								<>
									<p>
										End this application's current access and prevent further
										refreshes.
									</p>
									<button
										className="button danger full"
										disabled={busy}
										onClick={() =>
											void run(async () => {
												await revokeTokens(clientId, tokens);
												setTokens(undefined);
												setResult(undefined);
												setMessage("Application tokens revoked.");
											})
										}
									>
										Revoke tokens
									</button>
								</>
							)}
							{path !== "/tokens" && (
								<PageLink className="back-link" href="/tokens">
									Back to application access
								</PageLink>
							)}
						</>
					) : (
						<>
							<p>No application tokens in this page.</p>
							<PageLink className="button primary" href="/authorize">
								Start authorization →
							</PageLink>
						</>
					)}
				</>
			)}

			{message && !error && (
				<p className="notice" role="status">
					{message}
				</p>
			)}
			{error && (
				<>
					<p className="alert" role="alert">
						{error}
					</p>
					<PageLink className="back-link" href="/authorize">
						Start a new authorization
					</PageLink>
				</>
			)}
		</section>
	);
}
