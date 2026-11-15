import { useEffect, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import type {
  LibraryStatus,
  Preferences,
  Device,
} from "../../../../packages/contracts/src/index.js";
export function Settings() {
  const api = useApi();
  const [library, setLibrary] = useState<LibraryStatus>(),
    [preferences, setPreferences] = useState<Preferences>(),
    [devices, setDevices] = useState<Device[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([api.library(), api.preferences(), api.devices()])
      .then(([l, p, d]) => {
        if (active) {
          setLibrary(l);
          setPreferences(p);
          setDevices(d);
        }
      })
      .catch(() => {
        if (active)
          setMessage("Settings could not be loaded. Refresh to try again.");
      });
    const timer = setInterval(() => {
      api
        .library()
        .then((l) => {
          if (active) setLibrary(l);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await work();
      setMessage(success);
    } catch {
      setMessage("That change couldn’t be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="settings-page">
      <p className="eyebrow">MAKE YOURSELF AT HOME</p>
      <h1>Your cinema, your way.</h1>
      <p className="settings-lead">A few things behind a great movie night.</p>
      <p role="status" className="notice">
        {message}
      </p>
      <div className="settings-grid">
        <section className="setting-panel">
          <span className="panel-number">01</span>
          <h2>Your movie folder</h2>
          <p>
            Choose the Google Drive folder that holds your films. Subfolders are
            included.
          </p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void act(
                () => api.setFolder(String(data.get("folderId"))),
                "Folder selected. Your library is being updated.",
              );
            }}
          >
            <label>
              Drive folder ID
              <input
                name="folderId"
                placeholder="Paste your folder ID"
                defaultValue={library?.folderId ?? ""}
                key={library?.folderId}
                required
                pattern="[A-Za-z0-9_-]{1,160}"
              />
            </label>
            <button className="primary" disabled={busy}>
              Use this folder
            </button>
          </form>
          <div className="connection-state">
            <span
              className={`live-dot ${library?.state === "failed" ? "warning" : ""}`}
            />
            {library?.state === "running"
              ? "Updating your library…"
              : library?.state === "failed"
                ? "Update failed. Try reconnecting."
                : library?.folderId
                  ? "Folder connected"
                  : "No folder selected"}
          </div>
          {library?.folderId && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void act(() => api.sync(), "Library refresh started.")
              }
            >
              Refresh library ↻
            </button>
          )}
          <p className="fine-print">
            Google grants read access to Drive. RAVAN only imports the folder
            you choose. <a href="/auth/google/start">Reconnect Google</a>
          </p>
        </section>
        <section className="setting-panel">
          <span className="panel-number">02</span>
          <h2>Make it comfortable</h2>
          <p>Your preferred languages follow you between screens.</p>
          {preferences && (
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () => api.savePreferences(preferences),
                  "Preferences saved.",
                );
              }}
            >
              <label>
                Audio language
                <input
                  value={preferences.audioLanguage}
                  maxLength={35}
                  placeholder="en"
                  onChange={(e) =>
                    setPreferences({
                      ...preferences,
                      audioLanguage: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Subtitle language
                <input
                  value={preferences.subtitleLanguage}
                  maxLength={35}
                  placeholder="en"
                  onChange={(e) =>
                    setPreferences({
                      ...preferences,
                      subtitleLanguage: e.target.value,
                    })
                  }
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={preferences.reducedMotion}
                  onChange={(e) =>
                    setPreferences({
                      ...preferences,
                      reducedMotion: e.target.checked,
                    })
                  }
                />
                Reduce interface motion
              </label>
              <button disabled={busy}>Save preferences</button>
            </form>
          )}
        </section>
        <section className="setting-panel">
          <span className="panel-number">03</span>
          <h2>Bring the big screen</h2>
          <p>Open RAVAN on your TV, then enter its pairing code here.</p>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void act(
                () =>
                  api.approvePairing(String(data.get("code")).toUpperCase()),
                "TV approved. Continue on your television.",
              );
            }}
          >
            <label>
              TV pairing code
              <input
                name="code"
                autoComplete="off"
                placeholder="ABCD1234"
                maxLength={8}
                minLength={8}
                required
              />
            </label>
            <button disabled={busy}>Approve this TV</button>
          </form>
          {devices.length === 0 ? (
            <p className="fine-print">No paired televisions yet.</p>
          ) : (
            devices.map((d) => (
              <div className="edition" key={d.id}>
                <span>{d.name}</span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.revokeDevice(d.id);
                      setDevices((old) => old.filter((x) => x.id !== d.id));
                    }, "Device removed.")
                  }
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
