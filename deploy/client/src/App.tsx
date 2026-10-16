import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { authClient, signIn, signUp, useSession } from "./auth-client";
import { loginLink, navigate, PageLink, usePage } from "./navigation";
import { OAuthDemo } from "./OAuthDemo";
import { signOutAndDisconnect } from "./sign-out";
import { WalletPairing } from "./WalletPairing";
import { WalletSignIn } from "./WalletSignIn";
import { walletConnection } from "./wallet-connection";

/** One focused page for each authentication method and authorization stage. */
export function App() {
	const page = usePage();
	const path = page.split("?")[0];
	const {
		data: session,
		isPending,
		error: sessionError,
		refetch,
	} = useSession();
	const [config, setConfig] = useState({ github: false, matrix: false });
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [logoutError, setLogoutError] = useState("");
	const signup = path === "/sign-up";
	const walletPage = path === "/sign-in/wallet";
	const emailPage = path === "/sign-in/email" || signup;
	const oauthPage = [
		"/register",
		"/authorize",
		"/consent",
		"/oauth/callback",
		"/tokens",
		"/userinfo",
		"/tokens/refresh",
		"/tokens/revoke",
	].includes(path);
	useEffect(() => {
		void fetch("/api/demo-config")
			.then((res) => res.json())
			.then(setConfig)
			.catch(() => {});
	}, []);
	useEffect(() => {
		setError("");
		setPassword("");
	}, [path]);
	async function refreshWalletSession() {
		const result = await authClient.getSession({
			query: { disableCookieCache: true },
		});
		if (result.error || !result.data)
			throw new Error(
				result.error?.message ??
					"No session cookie was found. Use localhost consistently and sign in again.",
			);
		await refetch({ query: { disableCookieCache: true } });
		// OAuth Provider handles signed interaction redirects before this callback.
		if (!new URLSearchParams(location.search).has("client_id"))
			navigate("/session");
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const result = signup
				? await signUp.email({ email, password, name })
				: await signIn.email({ email, password });
			if (result.error)
				throw new Error(result.error.message ?? "Could not sign in.");
			walletConnection.cancel("", true);
			await refetch();
			if (!new URLSearchParams(location.search).has("client_id"))
				navigate("/session");
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not sign in.");
		} finally {
			setBusy(false);
		}
	}
	async function logout() {
		setBusy(true);
		setLogoutError("");
		try {
			await signOutAndDisconnect();
		} catch (error) {
			setLogoutError(
				error instanceof Error ? error.message : "Could not disconnect.",
			);
		} finally {
			setEmail("");
			setPassword("");
			setName("");
			await refetch();
			setBusy(false);
		}
	}
	const titles: Record<string, string> = {
		"/": "Your wallet. Your identity.",
		"/sign-in": "Choose how to sign in",
		"/sign-in/wallet": "Sign in with MetaMask",
		"/sign-in/email": "Sign in with email",
		"/sign-up": "Create your account",
		"/session": "Your account",
		"/sign-out": "Sign out",
		"/matrix": "Chat with Matrix",
		"/register": "Register an application",
		"/authorize": "Start authorization",
		"/consent": "Approve access",
		"/oauth/callback": "Completing authorization",
		"/tokens": "Your application access",
		"/userinfo": "Your shared profile",
		"/tokens/refresh": "Refresh application access",
		"/tokens/revoke": "Revoke application access",
		"/provider": "Identity provider",
	};
	return (
		<div className="app-shell">
			<header className="site-header">
				<PageLink className="brand" href="/">
					<img src="/reference/client-logo.svg" alt="" />
					<span>
						Better Auth<small>ETHEREUM · MATRIX</small>
					</span>
				</PageLink>
				<nav aria-label="Main navigation">
					<PageLink href="/matrix">Matrix</PageLink>
					<PageLink href="/authorize">OAuth demo</PageLink>
					<PageLink href={session ? "/session" : "/sign-in"}>
						{session ? "Account" : "Sign in"}
					</PageLink>
				</nav>
			</header>
			<main className="focus-main">
				<div className="page-heading">
					<h1>{titles[path] ?? "Page not found"}</h1>
				</div>
				{isPending && <p role="status">Loading your session…</p>}
				{sessionError && (
					<p className="alert" role="alert">
						{sessionError.message}
					</p>
				)}
				{path === "/" && (
					<section className="card">
						<p className="muted">
							Sign in, connect an application, or open your Matrix chat.
						</p>
						<div className="page-options">
							<PageLink href="/sign-in">
								Sign in <span>MetaMask or email →</span>
							</PageLink>
							<PageLink href="/matrix">
								Matrix chat <span>Open Element with wallet login →</span>
							</PageLink>
							<PageLink href="/register">
								OAuth demo <span>Register an application →</span>
							</PageLink>
							<PageLink href="/provider">
								Provider <span>Discovery and signing keys →</span>
							</PageLink>
						</div>
					</section>
				)}
				{path === "/sign-in" && (
					<section className="card">
						<p className="muted">Choose a method to verify your identity.</p>
						<div className="page-options">
							<PageLink href={loginLink("/sign-in/wallet")}>
								MetaMask <span>Extension or mobile QR →</span>
							</PageLink>
							<PageLink href={loginLink("/sign-in/email")}>
								Email and password <span>Continue →</span>
							</PageLink>
							{config.github && (
								<button
									className="button secondary"
									onClick={() =>
										void signIn.social({
											provider: "github",
											callbackURL: location.href,
										})
									}
								>
									Continue with GitHub
								</button>
							)}
						</div>
					</section>
				)}
				{walletPage && (
					<>
						<WalletSignIn onDone={refreshWalletSession} />
						<PageLink className="back-link" href={loginLink("/sign-in")}>
							Choose another method
						</PageLink>
					</>
				)}
				{emailPage && (
					<>
						<section className="card">
							<form onSubmit={(event) => void submit(event)}>
								{signup && (
									<label>
										Name
										<input
											autoComplete="name"
											value={name}
											onChange={(event) => setName(event.target.value)}
											required
										/>
									</label>
								)}
								<label>
									Email address
									<input
										type="email"
										autoComplete="email"
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										required
									/>
								</label>
								<label>
									Password
									<input
										type="password"
										autoComplete={signup ? "new-password" : "current-password"}
										value={password}
										onChange={(event) => setPassword(event.target.value)}
										minLength={8}
										required
									/>
								</label>
								<button className="button primary full" disabled={busy}>
									{busy
										? "Please wait…"
										: signup
											? "Create account"
											: "Sign in"}
								</button>
							</form>
							{error && (
								<p className="alert" role="alert">
									{error}
								</p>
							)}
						</section>
						<PageLink
							className="back-link"
							href={loginLink(signup ? "/sign-in/email" : "/sign-up")}
						>
							{signup
								? "Already have an account? Sign in"
								: "Create an account"}
						</PageLink>
						<PageLink className="back-link" href={loginLink("/sign-in")}>
							Choose another method
						</PageLink>
					</>
				)}
				{path === "/session" && (
					<section className="card">
						{session ? (
							<>
								<p className="session-badge">
									<span className="status-dot" /> Signed in
								</p>
								<h2 className="break-word">{session.user.name}</h2>
								<p className="muted break-word">User ID: {session.user.id}</p>
								<div className="page-options">
									<PageLink href="/matrix">Open Matrix →</PageLink>
									<PageLink href="/register">
										Register an application →
									</PageLink>
									<PageLink href="/sign-out">Sign out →</PageLink>
								</div>
							</>
						) : (
							<>
								<p>You are signed out.</p>
								<PageLink className="button primary" href="/sign-in">
									Sign in
								</PageLink>
							</>
						)}
					</section>
				)}
				{path === "/sign-out" && (
					<section className="card">
						<p>
							{session
								? "End your Better Auth session and disconnect MetaMask."
								: "Your Better Auth session is signed out."}
						</p>
						<p className="muted">
							Keep MetaMask open to confirm disconnection. Sign out of Element
							separately to end your Matrix session.
						</p>
						<button
							className="button secondary full"
							disabled={busy}
							onClick={() => void logout()}
						>
							{busy
								? "Disconnecting and signing out…"
								: logoutError
									? "Retry wallet disconnection"
									: "Sign out and disconnect wallet"}
						</button>
						{logoutError && (
							<p className="alert" role="alert">
								{logoutError}
							</p>
						)}
						{!session && !busy && !logoutError && (
							<PageLink className="back-link" href="/sign-in">
								Return to sign in
							</PageLink>
						)}
					</section>
				)}
				{path === "/matrix" && (
					<section className="card">
						<p>Use your Ethereum identity to sign in to Matrix.</p>
						<ol className="steps">
							<li>Open Element.</li>
							<li>Choose MetaMask on the sign-in page.</li>
							<li>Connect your wallet and sign the message.</li>
							<li>Approve Matrix access and start chatting.</li>
						</ol>
						{config.matrix ? (
							<a className="button primary full" href="http://localhost:8088/">
								Open Element →
							</a>
						) : (
							<p className="notice" role="status">
								Matrix is not configured. Run the Matrix setup command and
								restart the auth server.
							</p>
						)}
						<p className="fine-print">
							Your first login creates a Matrix account. The same Better Auth
							identity returns to the same account.
						</p>
					</section>
				)}
				{oauthPage && <OAuthDemo signedIn={Boolean(session)} path={path} />}
				{path === "/provider" && (
					<section className="card">
						<p className="muted">
							Ethereum wallet login with standard OpenID Connect.
						</p>
						<div className="page-options">
							<a href="/api/auth/.well-known/openid-configuration">
								OpenID discovery →
							</a>
							<a href="/api/auth/jwks">Signing keys →</a>
							<PageLink href="/register">Register an application →</PageLink>
						</div>
					</section>
				)}
				{!titles[path] && (
					<PageLink className="back-link" href="/">
						Return home
					</PageLink>
				)}
			</main>
			<footer className="site-footer">
				<span>Better Auth · Ethereum · Matrix</span>
			</footer>
			{/* Registration also requests a wallet signature; keep its pairing inline. */}
			{path === "/register" && (
				<div className="focus-pairing">
					<WalletPairing />
				</div>
			)}
		</div>
	);
}
