// OAuth leaves the site and MFA returns at its root. Preserve only the two
// app handoff screens in this tab, never a book, pairing code or arbitrary URL.
const key = "ravan:sign-in-destination";

export function rememberSignInDestination() {
  try {
    const screen = location.hash;
    if (screen === "#/settings" || screen === "#/reading")
      sessionStorage.setItem(key, screen);
    else sessionStorage.removeItem(key);
  } catch {
    // The owner can still sign in when browser storage is disabled.
  }
}

export function finishSignIn() {
  let destination = "/";
  try {
    const screen = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (screen === "#/settings" || screen === "#/reading")
      destination += screen;
  } catch {
    // The website's normal landing page works without browser storage.
  }
  location.replace(destination);
}
