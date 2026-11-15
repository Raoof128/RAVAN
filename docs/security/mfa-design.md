# RAVAN owner login and MFA

Design before implementation, 2026-11-15.

Authentication runs on the private Node backend. A frontend-only deployment does not provide account access; Google OAuth configuration and an explicitly pinned owner are prerequisites.

## Flow and security boundaries

1. Google OAuth with existing state, PKCE, nonce, signature/audience/issuer checks and pinned owner. No signup or local password database.
2. OAuth yields a random, hashed, ten-minute pre-authentication cookie and CSRF token, never a library session. Existing sessions from the previous single-factor version are revoked by migration, including paired-device and playback credentials.
3. First login must enroll an authenticator using a locally rendered QR code or manual key, then prove possession with a six-digit TOTP. Subsequent logins verify TOTP before issuing a fresh library session.
4. OTPAuth handles RFC 6238, SHA-1/6 digits/30 seconds for authenticator compatibility, with one time-step drift. Store the last accepted counter atomically to prevent replay. Encrypt seeds with AES-256-GCM and separate MFA associated data.
5. Persist account-wide failed attempts; five failures lock verification for fifteen minutes. New OAuth challenges and server restarts cannot reset the lock. Add route-level IP limits and validate CSRF plus exact Origin on every mutation.
6. Issue eight random 128-bit recovery codes at enrollment, display once, store only SHA-256 digests. A recovery code plus fresh Google login authorizes replacement enrollment only; no library access until a new authenticator is verified. Replacement invalidates all old sessions, devices, playback and recovery codes.
7. Transactions consume challenges/codes, verify counters, create sessions and replace factors atomically. Pending challenges expire and are pruned. Secrets never enter URLs, telemetry, localStorage, public demo data or logs.
8. Cancel clears the challenge; failures and expired state offer restart. No MFA-disable endpoint, email/SMS bypass or administrator HTTP reset.

## UI specification

Extend the accepted RAVAN visual system: charcoal #151513, warm ivory #f1eee5, coral #ec694f, Cormorant Garamond display headings, DM Sans controls. Desktop uses a spacious split composition with original cinema-room artwork and the existing wordmark; mobile prioritizes the form. Sign-in, enrollment, verification, one-time recovery-code display, unavailable and error states share one shell. Visible step indicator: Google account / Authenticator. Use native buttons, labels, one accessible code field supporting paste/autofill, visible focus, status announcements and reduced motion. No security certification claims or simulated MFA.

## Verification

Test OAuth withholding sessions, enrollment proof, encrypted storage, reused/expired challenges, OTP replay and drift, account-wide lockout across challenges/restarts, one-use recovery plus mandatory replacement, CSRF, concurrent submissions, previous credential revocation and absence of private data in Cloudflare. Browser tests exercise all screens, errors and mobile layouts with isolated fixtures, then verify the real hosted unavailable state.

## Current references

- https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://hectorm.github.io/otpauth/classes/TOTP.html
- https://github.com/hectorm/otpauth

TOTP is not phishing-resistant. This implementation does not claim NIST AAL certification. Keep recovery codes offline, independently from the authenticator.
