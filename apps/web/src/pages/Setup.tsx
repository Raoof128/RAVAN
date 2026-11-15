import type { SessionState } from "../../../../packages/contracts/src/index.js";
import roomArtwork from "../../../../packages/ui/src/art/cinema-login.webp";
import { Mfa } from "./Mfa.js";

export function Setup({ session }: { session: SessionState }) {
  return (
    <main id="main" className="login-page">
      <section className="login-copy" aria-label="Sign in to RAVAN">
        {session.mfa ? (
          <Mfa session={session} />
        ) : (
          <>
            <h1>
              Your cinema.
              <br />
              <em>Only yours.</em>
            </h1>
            <p className="login-intro">
              Sign in with your approved Google account, then verify with your
              authenticator.
            </p>
            <ol className="login-steps" aria-label="Sign-in steps">
              <li aria-current="step">
                <span>01</span> Google account
              </li>
              <li>
                <span>02</span> Authenticator
              </li>
            </ol>
            {session.configured ? (
              <a className="button login-google" href="/auth/google/start">
                <GoogleIcon />
                Continue with Google
              </a>
            ) : (
              <button
                className="login-google"
                disabled
                aria-describedby="login-availability"
              >
                <GoogleIcon />
                Continue with Google
              </button>
            )}
            <p className="login-reassurance">Two steps. One private library.</p>
            {import.meta.env.MODE === "cloudflare" && (
              <div className="login-demo">
                <a href="/demo/">Explore the sample library</a>
              </div>
            )}
            {!session.configured && (
              <p
                id="login-availability"
                className="login-availability"
                role="status"
              >
                Sign-in is not available yet. Your private server connection is
                being prepared.
              </p>
            )}
          </>
        )}
        <p className="login-footer">RAVAN / EVERY STORY FLOWS.</p>
      </section>
      <aside className="login-art" aria-hidden="true">
        <img
          src={roomArtwork}
          width={480}
          height={720}
          alt=""
          fetchPriority="high"
        />
        <p>
          One more
          <br />
          <em>scene.</em>
        </p>
      </aside>
    </main>
  );
}
function GoogleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
      />
      <path
        fill="currentColor"
        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.81-1.76-5.6-4.12H3.06v2.6A10 10 0 0 0 12 22Zm-5.6-8.07a6 6 0 0 1 0-3.86v-2.6H3.06a10 10 0 0 0 0 9.06l3.34-2.6ZM12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.94 5.47l3.34 2.6A5.99 5.99 0 0 1 12 5.95Z"
      />
    </svg>
  );
}
