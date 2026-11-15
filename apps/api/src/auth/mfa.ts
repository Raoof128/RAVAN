import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Secret, TOTP } from "otpauth";
import type { Database } from "../../../../packages/db/src/open.js";
import { hash, issueSession, secret } from "./sessions.js";

export type Challenge = {
  token_hash: string;
  subject: string;
  csrf: string;
  expires_at: number;
  mode: "enroll" | "verify" | "replace";
  ciphertext: string | null;
};
type Factor = { ciphertext: string; last_counter: number };
type Failure = { error: string; status: number };
export type Verification =
  | Failure
  | { recoveryRequired: true }
  | {
      session: ReturnType<typeof issueSession>;
      recoveryCodes?: string[];
    };

export class MfaService {
  private key: Buffer;
  constructor(
    private db: Database,
    masterKey: Buffer,
    private now = Date.now,
  ) {
    if (masterKey.length !== 32)
      throw new Error("MFA encryption requires a 32-byte key");
    this.key = Buffer.from(
      hkdfSync("sha256", masterKey, Buffer.alloc(0), "ravan:mfa:v1", 32),
    );
  }
  private encrypt(value: string, subject: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`ravan:mfa:v1:${subject}`));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString(
      "base64",
    );
  }
  private decrypt(value: string, subject: string) {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(`ravan:mfa:v1:${subject}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
  private totp(seed: string) {
    return new TOTP({
      issuer: "RAVAN",
      label: "Private cinema",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(seed),
    });
  }
  private factor(subject: string) {
    return this.db
      .prepare("SELECT * FROM owner_mfa WHERE subject=?")
      .get(subject) as Factor | undefined;
  }
  createChallenge(subject: string) {
    return this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM mfa_challenges WHERE expires_at<=?")
        .run(this.now());
      const token = secret(),
        csrf = secret(),
        expires = this.now() + 600000;
      const mode = this.factor(subject) ? "verify" : "enroll";
      // Bound pending state even when the legitimate Google account repeatedly signs in.
      this.db
        .prepare(
          "DELETE FROM mfa_challenges WHERE subject=? AND token_hash NOT IN (SELECT token_hash FROM mfa_challenges WHERE subject=? ORDER BY expires_at DESC LIMIT 19)",
        )
        .run(subject, subject);
      this.db
        .prepare("INSERT INTO mfa_challenges VALUES (?,?,?,?,?,NULL)")
        .run(hash(token), subject, csrf, expires, mode);
      this.db
        .prepare("INSERT OR IGNORE INTO mfa_limits(subject) VALUES (?)")
        .run(subject);
      return { token, csrf, expires, mode };
    })();
  }
  challenge(token: string | undefined) {
    if (!token || token.length > 128) return;
    return this.db
      .prepare(
        "SELECT * FROM mfa_challenges WHERE token_hash=? AND expires_at>?",
      )
      .get(hash(token), this.now()) as Challenge | undefined;
  }
  cancel(token: string) {
    this.db
      .prepare("DELETE FROM mfa_challenges WHERE token_hash=?")
      .run(hash(token));
  }
  enrollment(token: string): { secret: string; uri: string } | Failure {
    return this.db.transaction(() => {
      const challenge = this.challenge(token);
      if (!challenge) return { error: "mfa_expired", status: 401 };
      if (
        challenge.mode === "verify" ||
        (challenge.mode === "enroll" && this.factor(challenge.subject))
      )
        return { error: "mfa_restart", status: 409 };
      const seed = challenge.ciphertext
        ? this.decrypt(challenge.ciphertext, challenge.subject)
        : new Secret({ size: 20 }).base32;
      if (!challenge.ciphertext)
        this.db
          .prepare("UPDATE mfa_challenges SET ciphertext=? WHERE token_hash=?")
          .run(this.encrypt(seed, challenge.subject), challenge.token_hash);
      return { secret: seed, uri: this.totp(seed).toString() };
    })();
  }
  verify(token: string, code: string, recovery: boolean): Verification {
    // Keep consumption, replay checks and session creation in one SQLite transaction.
    // Return failures (rather than throw) so rate-limit updates are committed.
    return this.db.transaction((): Verification => {
      const challenge = this.challenge(token);
      if (!challenge) return { error: "mfa_expired", status: 401 };
      const { subject } = challenge;
      const limits = this.db
        .prepare("SELECT * FROM mfa_limits WHERE subject=?")
        .get(subject) as { failures: number; locked_until: number };
      if (limits.locked_until > this.now())
        return { error: "mfa_locked", status: 429 };
      const fail = (): Failure => {
        const failures = (limits.locked_until ? 0 : limits.failures) + 1;
        this.db
          .prepare(
            "UPDATE mfa_limits SET failures=?,locked_until=? WHERE subject=?",
          )
          .run(failures, failures >= 5 ? this.now() + 900000 : 0, subject);
        return {
          error: failures >= 5 ? "mfa_locked" : "mfa_invalid",
          status: failures >= 5 ? 429 : 400,
        };
      };
      if (recovery) {
        if (
          challenge.mode !== "verify" ||
          !/^[a-f0-9]{32}$/.test(code.replaceAll("-", "").toLowerCase())
        )
          return fail();
        const removed = this.db
          .prepare("DELETE FROM mfa_recovery WHERE subject=? AND code_hash=?")
          .run(subject, hash(code.replaceAll("-", "").toLowerCase()));
        if (!removed.changes) return fail();
        this.db
          .prepare(
            "UPDATE mfa_challenges SET mode='replace',ciphertext=NULL WHERE token_hash=?",
          )
          .run(challenge.token_hash);
        this.db
          .prepare(
            "UPDATE mfa_limits SET failures=0,locked_until=0 WHERE subject=?",
          )
          .run(subject);
        // Recovery authorizes only replacement enrollment, never a library session.
        return { recoveryRequired: true };
      }
      const factor = this.factor(subject);
      if (challenge.mode === "enroll" && factor)
        return { error: "mfa_restart", status: 409 };
      const encrypted =
        challenge.mode === "verify" ? factor?.ciphertext : challenge.ciphertext;
      if (!encrypted || !/^\d{6}$/.test(code)) return fail();
      const timestamp = this.now();
      const delta = this.totp(this.decrypt(encrypted, subject)).validate({
        token: code,
        timestamp,
        window: 1,
      });
      const counter = Math.floor(timestamp / 30000) + (delta ?? 0);
      if (
        delta === null ||
        (challenge.mode === "verify" && counter <= factor!.last_counter)
      )
        return fail();
      let recoveryCodes: string[] | undefined;
      if (challenge.mode !== "verify") {
        recoveryCodes = Array.from({ length: 8 }, () =>
          randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
        );
        this.db
          .prepare(
            "INSERT INTO owner_mfa VALUES (?,?,?,?) ON CONFLICT(subject) DO UPDATE SET ciphertext=excluded.ciphertext,last_counter=excluded.last_counter,created_at=excluded.created_at",
          )
          .run(subject, encrypted, counter, timestamp);
        this.db
          .prepare("DELETE FROM mfa_recovery WHERE subject=?")
          .run(subject);
        const insert = this.db.prepare("INSERT INTO mfa_recovery VALUES (?,?)");
        for (const value of recoveryCodes)
          insert.run(subject, hash(value.replaceAll("-", "")));
        this.db
          .prepare("DELETE FROM web_sessions WHERE subject=?")
          .run(subject);
        // This is a single-owner service: replacing the factor revokes every TV and stream.
        this.db
          .prepare("UPDATE devices SET revoked_at=? WHERE revoked_at IS NULL")
          .run(timestamp);
        this.db
          .prepare(
            "UPDATE playback_sessions SET revoked_at=? WHERE revoked_at IS NULL",
          )
          .run(timestamp);
        this.db.prepare("DELETE FROM pairing_requests").run();
        this.db
          .prepare("DELETE FROM mfa_challenges WHERE subject=?")
          .run(subject);
      } else {
        this.db
          .prepare("UPDATE owner_mfa SET last_counter=? WHERE subject=?")
          .run(counter, subject);
        this.db
          .prepare("DELETE FROM mfa_challenges WHERE token_hash=?")
          .run(challenge.token_hash);
      }
      this.db
        .prepare(
          "UPDATE mfa_limits SET failures=0,locked_until=0 WHERE subject=?",
        )
        .run(subject);
      return {
        session: issueSession(this.db, subject),
        ...(recoveryCodes ? { recoveryCodes } : {}),
      };
    })();
  }
}
