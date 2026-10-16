import { siweClient } from "better-auth/client/plugins";

/** Keep the demo's session hook synchronized after wallet verification. */
export function demoSiweClient() {
	return {
		...siweClient(),
		atomListeners: [
			{
				matcher: (path: string) => path === "/siwe/verify",
				signal: "$sessionSignal" as const,
			},
		],
	};
}
