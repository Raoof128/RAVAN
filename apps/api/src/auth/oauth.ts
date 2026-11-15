import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { AppConfig } from "../config.js";
import type { AccessGrant } from "./token-store.js";
export type OwnerGrant = AccessGrant & { subject: string; nonce: string };
export interface OAuthProvider {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    challenge: string;
  }): string;
  exchange(code: string, verifier: string, nonce: string): Promise<OwnerGrant>;
  refresh(token: string): Promise<AccessGrant>;
}
export function googleProvider(config: AppConfig): OAuthProvider {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: `${config.origin}/auth/google/callback`,
  });
  client.transporter.defaults = {
    ...client.transporter.defaults,
    timeout: 15000,
    retry: false,
  };
  return {
    authorizationUrl: ({ state, nonce, challenge }) =>
      client.generateAuthUrl({
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: CodeChallengeMethod.S256,
        scope: ["openid", "https://www.googleapis.com/auth/drive.readonly"],
        access_type: "offline",
        prompt: "consent",
      }),
    async exchange(code, verifier) {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
      });
      if (!tokens.id_token || !tokens.access_token)
        throw new Error("Incomplete grant");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      });
      const payload = ticket.getPayload() as ReturnType<
        typeof ticket.getPayload
      > & { nonce?: string };
      if (!payload?.sub || !payload.nonce) throw new Error("Invalid identity");
      return {
        subject: payload.sub,
        nonce: payload.nonce,
        accessToken: tokens.access_token,
        expiresAt: tokens.expiry_date ?? Date.now(),
        refreshToken: tokens.refresh_token ?? undefined,
      };
    },
    async refresh(token) {
      const refreshClient = new OAuth2Client(
        config.clientId,
        config.clientSecret,
      );
      refreshClient.transporter.defaults = {
        ...refreshClient.transporter.defaults,
        timeout: 15000,
        retry: false,
      };
      refreshClient.setCredentials({ refresh_token: token });
      const { credentials } = await refreshClient.refreshAccessToken();
      if (!credentials.access_token)
        throw new Error("Access token unavailable");
      return {
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date ?? Date.now(),
        refreshToken: credentials.refresh_token ?? undefined,
      };
    },
  };
}
