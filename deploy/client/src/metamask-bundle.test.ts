import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { optimizeDeps, resolveConfig } from "vite";
import { expect, it } from "vitest";
import demoConfig from "../vite.config";

/** @see https://github.com/MetaMask/connect-monorepo */
it("exposes protocol and encryption APIs through the SDK's browser-optimized dynamic imports", async () => {
	const cacheDir = await mkdtemp(
		join(tmpdir(), "better-auth-metamask-bundle-"),
	);
	try {
		const config = await resolveConfig(
			{
				configFile: false,
				root: fileURLToPath(new URL("../", import.meta.url)),
				cacheDir,
				resolve: demoConfig.resolve,
				logLevel: "silent",
				optimizeDeps: {
					...demoConfig.optimizeDeps,
					include: ["@metamask/connect-evm"],
				},
			},
			"serve",
		);
		const metadata = await optimizeDeps(config, true);
		const sdkFile = metadata.optimized["@metamask/connect-evm"]?.file;
		expect(sdkFile).toBeDefined();
		if (!sdkFile) throw new Error("MetaMask SDK was not optimized");
		const sdkSource = await readFile(sdkFile, "utf8");
		// Stencil must load its QR/OTP component chunks from the original package.
		expect(sdkSource).toContain('import("@metamask/multichain-ui/loader")');
		const coreImport = sdkSource.match(
			/const \[mwpCore[\s\S]*?import\("([^"]+)"\)/,
		)?.[1];
		expect(coreImport).toBeDefined();
		if (!coreImport) throw new Error("MetaMask protocol import was not found");
		const coreURL = new URL(coreImport, pathToFileURL(sdkFile));
		const core: Record<string, unknown> = await import(
			/* @vite-ignore */ coreURL.href
		);
		const store = core.SessionStore as { create?: unknown } | undefined;
		const transport = core.WebSocketTransport as
			| { create?: unknown }
			| undefined;
		expect(typeof store?.create).toBe("function");
		expect(typeof transport?.create).toBe("function");
		const encryptionImport = sdkSource.match(
			/const \{ decrypt, encrypt, PrivateKey, PublicKey \} = yield import\("([^"]+)"\)/,
		)?.[1];
		if (!encryptionImport)
			throw new Error("MetaMask encryption import was not found");
		const encryption: Record<string, unknown> = await import(
			/* @vite-ignore */ new URL(encryptionImport, pathToFileURL(sdkFile)).href
		);
		for (const name of ["PrivateKey", "PublicKey", "encrypt", "decrypt"]) {
			expect(typeof encryption[name], name).toBe("function");
		}
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
}, 30_000);
