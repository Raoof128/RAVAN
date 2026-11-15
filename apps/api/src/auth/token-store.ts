import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Database } from "../../../../packages/db/src/open.js";
export type AccessGrant = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
};
export class TokenStore {
  private grant?: AccessGrant;
  private refreshing?: Promise<string>;
  constructor(
    private db: Database,
    private key: Buffer,
    private refresh: (token: string) => Promise<AccessGrant>,
  ) {
    if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  }
  saveRefreshToken(token: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("mov:google-refresh:v1"));
    const encrypted = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);
    const value = Buffer.concat([
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]).toString("base64");
    this.db
      .prepare(
        "INSERT INTO credentials(id,ciphertext,updated_at) VALUES ('google',?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",
      )
      .run(value, Date.now());
  }
  private readRefreshToken(): string {
    const row = this.db
      .prepare("SELECT ciphertext FROM credentials WHERE id='google'")
      .get() as { ciphertext: string } | undefined;
    if (!row) throw new Error("Drive connection required");
    const bytes = Buffer.from(row.ciphertext, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("mov:google-refresh:v1"));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  acceptGrant(grant: AccessGrant) {
    if (grant.refreshToken) this.saveRefreshToken(grant.refreshToken);
    this.grant = grant;
  }
  async getAccessToken(): Promise<string> {
    if (this.grant && this.grant.expiresAt > Date.now() + 60000)
      return this.grant.accessToken;
    // One refresh owns the update; concurrent callers share its result.
    if (!this.refreshing)
      this.refreshing = this.refresh(this.readRefreshToken())
        .then((grant) => {
          this.acceptGrant(grant);
          return grant.accessToken;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    return this.refreshing;
  }
}
