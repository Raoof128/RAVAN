import { useEffect, useState, type FormEvent } from "react";
import { ApiError, useApi } from "../../../../packages/client/src/api.js";
import type { SessionState } from "../../../../packages/contracts/src/index.js";

function message(error: unknown) {
  if (!(error instanceof ApiError))
    return "We couldn’t reach your server. Please try again.";
  switch (error.code) {
    case "mfa_invalid":
      return "That code didn’t work or was already used. Try a fresh code.";
    case "mfa_locked":
      return "Too many attempts. Wait 15 minutes, then sign in again.";
    case "mfa_expired":
    case "mfa_restart":
      return "This sign-in has expired. Please start again.";
    case "csrf_failed":
      return "We couldn’t verify this request. Please start again.";
    default:
      return "Verification is unavailable. Please try again.";
  }
}
export function Mfa({ session }: { session: SessionState }) {
  const api = useApi();
  const [mode, setMode] = useState(session.mfa!);
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    qr?: string;
  }>();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [codes, setCodes] = useState<string[]>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (codes) return;
    const timer = window.setTimeout(
      () => {
        setExpired(true);
        setEnrollment(undefined);
        setCode("");
        setError("This sign-in has expired. Please start again.");
      },
      Math.max(0, (session.challengeExpiresAt ?? Date.now()) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session.challengeExpiresAt, codes]);
  useEffect(() => {
    if (mode !== "enroll" || expired || codes) return;
    let active = true;
    setError("");
    api
      .enrollMfa()
      .then(async (data) => {
        // QR encoding stays in this browser; the secret never reaches a QR service.
        let qr: string | undefined;
        try {
          // Fetched only for enrolment, so signing in never downloads it.
          const { toDataURL } = await import("qrcode");
          qr = await toDataURL(data.uri, {
            width: 200,
            margin: 2,
            errorCorrectionLevel: "M",
          });
        } catch {
          /* The manual key remains usable if QR rendering fails. */
        }
        if (active) setEnrollment({ secret: data.secret, qr });
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, mode, expired, codes, retry]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || expired) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.verifyMfa(
        code.trim().replace(/\s/g, ""),
        recovery,
      );
      setCode("");
      if (result.recoveryRequired) {
        setRecovery(false);
        setMode("enroll");
      } else if (result.recoveryCodes) {
        setEnrollment(undefined);
        setCodes(result.recoveryCodes);
      } else if (result.authenticated) location.replace("/");
      else setError("Verification is unavailable. Please try again.");
    } catch (e) {
      setError(message(e));
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      await api.cancelMfa();
      location.replace("/");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) location.replace("/");
      else {
        setError(message(e));
        setBusy(false);
      }
    }
  }
  function download() {
    try {
      const url = URL.createObjectURL(
        new Blob(
          [
            `RAVAN recovery codes\nKeep these offline. Each code works once, after Google sign-in.\n\n${codes!.join("\n")}\n`,
          ],
          { type: "text/plain" },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "ravan-recovery-codes.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError(
        "The download didn’t start. Copy the codes somewhere safe before continuing.",
      );
    }
  }
  if (codes)
    return (
      <div className="mfa-panel">
        <h1>
          Keep a way
          <br />
          <em>back in.</em>
        </h1>
        <p className="login-intro">
          Save these recovery codes somewhere safe, separate from your
          authenticator. Each works once, after Google sign-in. They won’t be
          shown again.
        </p>
        <ul className="recovery-codes" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <button className="mfa-secondary" onClick={download}>
          Download recovery codes
        </button>
        <label className="recovery-saved">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
          />
          I’ve saved my recovery codes.
        </label>
        {error && (
          <p role="alert" className="login-error">
            {error}
          </p>
        )}
        <button
          className="login-google"
          disabled={!saved}
          onClick={() => {
            setCodes(undefined);
            location.replace("/");
          }}
        >
          Enter your cinema
        </button>
      </div>
    );
  return (
    <div className="mfa-panel">
      <h1>
        {mode === "enroll" ? (
          <>
            Make it
            <br />
            <em>just yours.</em>
          </>
        ) : recovery ? (
          <>
            A way
            <br />
            <em>back in.</em>
          </>
        ) : (
          <>
            One more
            <br />
            <em>little step.</em>
          </>
        )}
      </h1>
      <p className="login-intro">
        {mode === "enroll"
          ? "Add RAVAN to your authenticator app, then enter the six-digit code to finish."
          : recovery
            ? "Enter a saved recovery code. Next, you’ll set up a new authenticator before entering your library."
            : "Open your authenticator and enter the six-digit code for RAVAN."}
      </p>
      <ol className="login-steps" aria-label="Sign-in steps">
        <li>
          <span>✓</span> Google account
        </li>
        <li aria-current="step">
          <span>02</span> Authenticator
        </li>
      </ol>
      {mode === "enroll" &&
        !expired &&
        (enrollment ? (
          <div className="mfa-enrollment">
            {enrollment.qr && (
              <img
                src={enrollment.qr}
                width={180}
                height={180}
                alt="Scan this QR code with your authenticator app"
              />
            )}
            <details>
              <summary>Can’t scan? Use the setup key</summary>
              <p>
                Account: RAVAN
                <br />
                Type: Time based
              </p>
              <code className="mfa-secret">{enrollment.secret}</code>
            </details>
          </div>
        ) : (
          <div className="mfa-enrollment" role="status">
            {error ? (
              <button onClick={() => setRetry((n) => n + 1)}>
                Try setup again
              </button>
            ) : (
              <>
                <span className="sk sk-qr sk-group" aria-hidden="true" />
                <span className="login-availability">
                  Preparing your authenticator…
                </span>
              </>
            )}
          </div>
        ))}
      <form onSubmit={submit} aria-busy={busy}>
        <label htmlFor="mfa-code">
          {recovery ? "Recovery code" : "Authenticator code"}
        </label>
        <input
          id="mfa-code"
          className={recovery ? "recovery-input" : "otp-input"}
          type="text"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete={recovery ? "off" : "one-time-code"}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={recovery ? 64 : 6}
          pattern={recovery ? undefined : "[0-9]{6}"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          readOnly={busy}
          disabled={expired}
          aria-describedby={error ? "mfa-error" : "mfa-code-hint"}
          aria-invalid={error ? true : undefined}
        />
        <p id="mfa-code-hint" className="login-availability">
          {recovery
            ? "Each recovery code can be used once."
            : "Codes refresh every 30 seconds. You can paste yours here."}
        </p>
        {error && (
          <p id="mfa-error" role="alert" className="login-error">
            {error}
          </p>
        )}
        <button
          className="login-google"
          type="submit"
          disabled={busy || expired || (mode === "enroll" && !enrollment)}
        >
          {busy
            ? "Verifying…"
            : recovery
              ? "Continue recovery"
              : mode === "enroll"
                ? "Confirm authenticator"
                : "Verify & enter"}
        </button>
      </form>
      <div className="mfa-actions">
        {mode === "verify" && !expired && (
          <button
            disabled={busy}
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
              setError("");
            }}
          >
            {recovery ? "Use authenticator instead" : "Use a recovery code"}
          </button>
        )}
        <button disabled={busy} onClick={() => void cancel()}>
          Start again
        </button>
      </div>
    </div>
  );
}
