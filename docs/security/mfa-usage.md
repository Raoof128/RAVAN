# RAVAN sign-in and recovery

Google sign-in and MFA require a configured private Node backend with an explicitly pinned owner. Deploying the frontend alone does not activate account access. Never enter Google passwords or authenticator secrets into chat.

## First sign-in, once the private backend is connected

1. Choose **Continue with Google** and use the server's pinned owner account.
2. Scan the QR code in your authenticator, or expand **Can’t scan? Use the setup key** and add a time-based entry named RAVAN.
3. Enter the six-digit code and choose **Confirm authenticator**.
4. Save the eight recovery codes offline, separately from your authenticator. They are displayed only once. Confirm that you saved them, then enter your cinema.

Subsequent sign-ins require Google and a fresh authenticator code. A code cannot be reused; wait for the next one if you just enrolled or signed in elsewhere. Pair an LG C1 only from an authenticated owner session; the television receives a separate revocable device credential.

## Lost authenticator

Complete Google sign-in, choose **Use a recovery code**, and enter one saved code. That code is consumed immediately. Set up a new authenticator and verify it before entering. Save the replacement recovery codes; all previous recovery codes, browser sessions, paired TVs and playback credentials are revoked when replacement completes. Re-pair the TV afterwards.

If replacement is interrupted before confirmation, start again using another unused recovery code, or use the original authenticator if you still have it. Used recovery codes are never restored. There is no email, SMS, public reset or MFA-disable bypass. If all authenticators and recovery codes are lost, controlled server-level identity recovery is required; that workflow is not automated in this release.

## Operational notes

- A Google-verified challenge expires after ten minutes. Choose **Start again** to restart.
- Five incorrect verification attempts lock the owner account for fifteen minutes, across browsers and service restarts. Restart sign-in after the wait.
- Keep system time synchronized on both server and authenticator.
- Migration 003 revokes pre-MFA browser, TV, pairing and playback credentials once. It preserves movies, metadata and Google credentials. Back up the database and encryption key before a backend upgrade.
- `MOV_ENCRYPTION_KEY` protects both Google refresh tokens and MFA seeds, with separate key derivation/context for MFA. Back up the key separately; changing it without a migration makes existing credentials unreadable.
- Use HTTPS in production. Keep the backend on loopback behind the intended proxy, and keep `/_worker/*` private.
- QR rendering is local to the browser. No external QR service receives setup keys. Recovery codes are held only in browser memory until the user downloads them; the server stores hashes.

## Verification commands

```sh
npm run check
npm test
npm run test:e2e
npm run build
npm run build:web
npm run build:tv
```

Implementation rationale and current primary references: [MFA design](mfa-design.md).
