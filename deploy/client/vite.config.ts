import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client talks to the better-auth server through a dev proxy so the
// browser sees a same-origin API (cookies + session "just work").
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: [
			{
				// The SDK dynamically imports named protocol exports. Its CJS main
				// becomes default-only under Vite's optimizer; use the shipped ESM build.
				find: /^@metamask\/mobile-wallet-protocol-core$/,
				replacement: fileURLToPath(
					new URL(
						"./node_modules/@metamask/mobile-wallet-protocol-core/dist/index.mjs",
						import.meta.url,
					),
				),
			},
			{
				// This dependency ships CommonJS only. A static re-export gives the
				// SDK's dynamic import an ESM namespace rather than a default-only object.
				find: /^eciesjs$/,
				replacement: fileURLToPath(
					new URL("./src/metamask-ecies.ts", import.meta.url),
				),
			},
		],
	},
	// The better-auth dependency chain ships modern syntax; make sure esbuild
	// (dev dep pre-bundling + build) doesn't try to down-level to old targets.
	esbuild: { target: "esnext" },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		// Stencil loads the QR/OTP components relative to its own entry point.
		// Prebundling the loader breaks those lazy component paths.
		exclude: ["@metamask/multichain-ui"],
	},
	build: { target: "esnext" },
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:3100",
				changeOrigin: true,
			},
		},
	},
});
