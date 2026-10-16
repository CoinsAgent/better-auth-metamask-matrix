import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { demoSiweClient } from "./siwe-client";

// Same-origin requests: Vite proxies /api -> the better-auth server (port 3100).
export const authClient = createAuthClient({
	baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
	// Web3 login via Sign in with Ethereum (docs/plugins/siwe).
	plugins: [demoSiweClient(), oauthProviderClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
