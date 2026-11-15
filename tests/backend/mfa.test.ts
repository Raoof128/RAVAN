import { afterEach, expect, it } from "vitest";
import { TOTP, Secret } from "otpauth";
import { MfaService, type Verification } from "../../apps/api/src/auth/mfa.js";
import { openDatabase } from "../../packages/db/src/open.js";
import { issueSession } from "../../apps/api/src/auth/sessions.js";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function fixture() {
  const db = openDatabase(":memory:");
  cleanup.push(() => db.close());
  let now = 1800000000000;
  const key = Buffer.from("ab".repeat(32), "hex");
  const service = new MfaService(db, key, () => now);
  const code = (seed: string, offset = 0) =>
    new TOTP({ secret: Secret.fromBase32(seed) }).generate({
      timestamp: now + offset,
    });
  const enroll = () => {
    const challenge = service.createChallenge("owner");
    const data = service.enrollment(challenge.token);
    if ("error" in data) throw Error(data.error);
    const result = service.verify(challenge.token, code(data.secret), false);
    if (!("session" in result)) throw Error("enrollment failed");
    return { ...data, ...result, challenge };
  };
  return {
    db,
    service,
    key,
    code,
    enroll,
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
  };
}
function accepted(result: Verification) {
  expect("session" in result).toBe(true);
}
it("requires proof of possession, encrypts seeds and hashes one-use recovery codes", () => {
  const f = fixture();
  const challenge = f.service.createChallenge("owner");
  expect(f.db.prepare("SELECT * FROM web_sessions").all()).toHaveLength(0);
  expect(f.service.verify(challenge.token, "nope", false)).toMatchObject({
    error: "mfa_invalid",
  });
  const enrollment = f.enroll();
  expect(enrollment.recoveryCodes).toHaveLength(8);
  const persisted =
    JSON.stringify(f.db.prepare("SELECT * FROM owner_mfa").all()) +
    JSON.stringify(f.db.prepare("SELECT * FROM mfa_recovery").all());
  expect(persisted).not.toContain(enrollment.secret);
  expect(persisted).not.toContain(
    enrollment.recoveryCodes![0]!.replaceAll("-", ""),
  );
  expect(f.service.enrollment(enrollment.challenge.token)).toMatchObject({
    status: 401,
  });
});
it("rejects reused OTPs across different challenges and consumes successful challenges", () => {
  const f = fixture(),
    enrollment = f.enroll();
  const a = f.service.createChallenge("owner"),
    b = f.service.createChallenge("owner");
  expect(
    f.service.verify(a.token, f.code(enrollment.secret), false),
  ).toMatchObject({ error: "mfa_invalid" });
  f.advance(30000);
  accepted(f.service.verify(a.token, f.code(enrollment.secret), false));
  expect(
    f.service.verify(a.token, f.code(enrollment.secret), false),
  ).toMatchObject({ status: 401 });
  expect(
    f.service.verify(b.token, f.code(enrollment.secret), false),
  ).toMatchObject({ error: "mfa_invalid" });
});
it("allows one clock step but rejects stale and future codes outside the window", () => {
  const f = fixture(),
    enrollment = f.enroll();
  f.advance(90000);
  const a = f.service.createChallenge("owner");
  expect(
    f.service.verify(a.token, f.code(enrollment.secret, -60000), false),
  ).toMatchObject({ error: "mfa_invalid" });
  expect(
    f.service.verify(a.token, f.code(enrollment.secret, 60000), false),
  ).toMatchObject({ error: "mfa_invalid" });
  accepted(f.service.verify(a.token, f.code(enrollment.secret, -30000), false));
});
it("locks the account across new Google challenges and service restarts", () => {
  const f = fixture(),
    enrollment = f.enroll();
  f.advance(30000);
  for (let i = 0; i < 5; i++) {
    const c = f.service.createChallenge("owner");
    expect(f.service.verify(c.token, "invalid", false)).toMatchObject({
      status: i === 4 ? 429 : 400,
    });
  }
  const restarted = new MfaService(f.db, f.key, f.clock);
  const c = restarted.createChallenge("owner");
  expect(
    restarted.verify(c.token, f.code(enrollment.secret), false),
  ).toMatchObject({ status: 429 });
  f.advance(900001);
  const fresh = restarted.createChallenge("owner");
  accepted(restarted.verify(fresh.token, f.code(enrollment.secret), false));
});
it("expires and cancels challenges and bounds pending records", () => {
  const f = fixture();
  const c = f.service.createChallenge("owner");
  f.advance(600001);
  expect(f.service.verify(c.token, "123456", false)).toMatchObject({
    status: 401,
  });
  for (let i = 0; i < 40; i++) f.service.createChallenge("owner");
  expect(f.db.prepare("SELECT * FROM mfa_challenges").all()).toHaveLength(20);
  const next = f.service.createChallenge("owner");
  f.service.cancel(next.token);
  expect(f.service.challenge(next.token)).toBeUndefined();
});
it("recovery requires replacement proof and revokes old browser, TV, playback and recovery credentials", () => {
  const f = fixture(),
    original = f.enroll();
  f.advance(30000);
  const prior = issueSession(f.db, "owner");
  f.db
    .prepare(
      "INSERT INTO devices(id,name,token_hash) VALUES ('tv','LG','token')",
    )
    .run();
  const c = f.service.createChallenge("owner");
  const recovery = original.recoveryCodes![0]!;
  expect(f.service.verify(c.token, recovery, true)).toEqual({
    recoveryRequired: true,
  });
  expect(f.service.challenge(c.token)?.mode).toBe("replace");
  const another = f.service.createChallenge("owner");
  expect(f.service.verify(another.token, recovery, true)).toMatchObject({
    error: "mfa_invalid",
  });
  const replacement = f.service.enrollment(c.token);
  if ("error" in replacement) throw Error(replacement.error);
  expect(replacement.secret).not.toBe(original.secret);
  expect(
    f.service.verify(c.token, f.code(original.secret), false),
  ).toMatchObject({ error: "mfa_invalid" });
  accepted(f.service.verify(c.token, f.code(replacement.secret), false));
  expect(
    f.db.prepare("SELECT * FROM web_sessions WHERE csrf=?").get(prior.csrf),
  ).toBeUndefined();
  expect(
    f.db.prepare("SELECT revoked_at FROM devices WHERE id='tv'").get(),
  ).toMatchObject({ revoked_at: f.clock() });
  expect(f.service.challenge(another.token)).toBeUndefined();
  const fresh = f.service.createChallenge("owner");
  expect(
    f.service.verify(fresh.token, original.recoveryCodes![1]!, true),
  ).toMatchObject({ error: "mfa_invalid" });
});
it("does not expose an enrolled secret and rejects parallel stale enrollment", () => {
  const f = fixture();
  const stale = f.service.createChallenge("owner");
  f.service.enrollment(stale.token);
  f.enroll();
  expect(f.service.enrollment(stale.token)).toMatchObject({ status: 401 });
  expect(
    f.service.enrollment(f.service.createChallenge("owner").token),
  ).toMatchObject({ status: 409 });
});
it("detects encrypted-seed tampering and key changes", () => {
  const f = fixture(),
    enrollment = f.enroll();
  f.advance(30000);
  const c = f.service.createChallenge("owner");
  const wrong = new MfaService(f.db, Buffer.alloc(32), f.clock);
  expect(() =>
    wrong.verify(c.token, f.code(enrollment.secret), false),
  ).toThrow();
  expect(f.service.challenge(c.token)).toBeTruthy();
});
