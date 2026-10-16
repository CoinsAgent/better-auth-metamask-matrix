/** The local application's registration metadata, shared by the UI and policy. */
export function demoClientMetadata() {
	return {
		client_name: "Local PKCE demo",
		application_type: "native" as const,
		redirect_uris: ["http://localhost:5173/oauth/callback"],
		token_endpoint_auth_method: "none" as const,
		grant_types: ["authorization_code", "refresh_token"],
		scope: "openid profile email offline_access",
	};
}
