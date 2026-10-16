import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("./.runtime/", import.meta.url));
mkdirSync(`${runtime}/synapse`, { recursive: true, mode: 0o700 });
const oidcPath = `${runtime}/oidc.json`;
// Preserve credentials and signing keys across restarts. Never print secrets.
const oidc = existsSync(oidcPath)
	? JSON.parse(readFileSync(oidcPath, "utf8"))
	: {
			clientId: "matrix-synapse-local",
			clientSecret: randomBytes(32).toString("base64url"),
		};
writeFileSync(oidcPath, `${JSON.stringify(oidc, null, 2)}\n`, { mode: 0o600 });
const configPath = `${runtime}/synapse/homeserver.yaml`;
const previous = existsSync(configPath)
	? JSON.parse(readFileSync(configPath, "utf8"))
	: {};
const config = {
	server_name: "localhost",
	public_baseurl: "http://localhost:8008/",
	pid_file: "/data/homeserver.pid",
	report_stats: false,
	listeners: [
		{
			port: 8008,
			bind_addresses: ["127.0.0.1"],
			type: "http",
			tls: false,
			x_forwarded: false,
			resources: [{ names: ["client"], compress: false }],
		},
	],
	database: { name: "sqlite3", args: { database: "/data/homeserver.db" } },
	media_store_path: "/data/media_store",
	signing_key_path: "/data/localhost.signing.key",
	macaroon_secret_key:
		previous.macaroon_secret_key ?? randomBytes(32).toString("hex"),
	form_secret: previous.form_secret ?? randomBytes(32).toString("hex"),
	enable_registration: false,
	password_config: { enabled: false },
	trusted_key_servers: [],
	suppress_key_server_warning: true,
	// This local, loopback-only stack is not federated.
	federation_domain_whitelist: [],
	sso: {
		client_whitelist: ["http://localhost:8088/"],
		template_dir: "/templates",
	},
	oidc_providers: [
		{
			idp_id: "betterauth",
			idp_name: "MetaMask · Better Auth",
			issuer: "http://localhost:3100/api/auth",
			client_id: oidc.clientId,
			client_secret: oidc.clientSecret,
			client_auth_method: "client_secret_basic",
			scopes: ["openid", "profile"],
			// Better Auth returns profile claims from UserInfo, not the minimal ID token.
			user_profile_method: "userinfo_endpoint",
			pkce_method: "always",
			// Synapse requires this for HTTP development metadata, not for token validation.
			skip_verification: true,
			user_mapping_provider: {
				config: {
					subject_template: "{{ user.sub }}",
					// Stable immutable subject, not a changeable name or placeholder email.
					localpart_template: "ba_{{ user.sub | lower }}",
					display_name_template: "{{ user.name }}",
				},
			},
		},
	],
};
// JSON is valid YAML and avoids another configuration generator dependency.
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
	mode: 0o600,
});
writeFileSync(
	fileURLToPath(new URL("./.env", import.meta.url)),
	`MATRIX_UID=${process.getuid?.() ?? 1000}\nMATRIX_GID=${process.getgid?.() ?? 1000}\n`,
	{ mode: 0o600 },
);
console.log(
	"Matrix configuration ready. Start Better Auth, then docker compose -f deploy/matrix/compose.yaml up -d --wait.",
);
