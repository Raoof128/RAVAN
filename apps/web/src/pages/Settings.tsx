import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import type {
  LibraryStatus,
  Preferences,
  Device,
} from "../../../../packages/contracts/src/index.js";
import {
  ActionButton,
  Flow,
  Line,
  Placeholder,
  useDelayed,
  usePending,
} from "../../../../packages/ui/src/Loading.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
import { Icon } from "../../../../packages/ui/src/Icon.js";
import { rememberMotion } from "../motion.js";
import { useTitle } from "../router.js";
type Note = { text: string; failed?: boolean };
/**
 * One setting's own outcome, where the owner is looking. Both regions exist
 * before any words arrive, so a screen reader announces them when they do.
 */
function Outcome({ note }: { note?: Note }) {
  return (
    <div className="panel-outcome">
      <p className="panel-note" role="status">
        {note && !note.failed ? note.text : ""}
      </p>
      <p className="panel-note panel-note-failed" role="alert">
        {note?.failed ? note.text : ""}
      </p>
    </div>
  );
}
function Panel({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section className="setting-panel">
      <h2>{title}</h2>
      <p>{lead}</p>
      {children}
    </section>
  );
}
function folderFrom(value: string) {
  // A pasted Drive link is as good as the ID inside it.
  return (value.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? value).trim();
}
function libraryLine(library: LibraryStatus | undefined) {
  if (!library?.folderId) return "No folder selected";
  if (library.state === "running") return "Updating your library";
  if (library.state === "failed")
    return "The last update failed. Reconnect Google, then refresh.";
  const found = library.counts.upserts,
    missing = library.counts.unavailable;
  if (library.state === "succeeded" && found !== undefined)
    return `Folder connected. ${found} ${found === 1 ? "file" : "files"} read in the last update${missing ? `, ${missing} no longer available` : ""}.`;
  return "Folder connected";
}
export function Settings() {
  const api = useApi();
  const [library, setLibrary] = useState<LibraryStatus>(),
    [preferences, setPreferences] = useState<Preferences>(),
    [devices, setDevices] = useState<Device[]>([]),
    [folder, setFolder] = useState(""),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [notes, setNotes] = useState<Record<string, Note | undefined>>({}),
    [removing, setRemoving] = useState<string>(),
    [credit, setCredit] = useState<string>();
  const [folderBusy, runFolder] = usePending();
  const [syncBusy, runSync] = usePending();
  const [prefsBusy, runPrefs] = usePending();
  const [pairBusy, runPair] = usePending();
  const [removeBusy, runRemove] = usePending();
  const [leaving, runLeave] = usePending();
  // Counts local changes to the paired screens. A poll that was already on its
  // way when one happened describes the past and is dropped.
  const deviceEdits = useRef(0);
  const confirm = useRef<HTMLButtonElement>(null);
  const screens = useRef<HTMLHeadingElement>(null);
  const restore = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (removing) confirm.current?.focus();
    else if (restore.current) {
      const id = restore.current;
      restore.current = undefined;
      (
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-device]"),
        ).find((el) => el.dataset.device === id) ?? screens.current
      )?.focus();
    }
  }, [removing]);
  useTitle("Your cinema");
  useEffect(() => {
    let active = true;
    api
      .artworkCredits()
      .then((c) => {
        if (active && typeof c.tmdb === "string") setCredit(c.tmdb);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([api.library(), api.preferences(), api.devices()])
      .then(([l, p, d]) => {
        if (active) {
          setLibrary(l);
          setFolder(l.folderId ?? "");
          setPreferences(p);
          setDevices(d);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    // The library status and paired screens change on the server's side.
    const timer = setInterval(() => {
      if (document.hidden) return;
      api
        .library()
        .then((l) => {
          if (active) setLibrary(l);
        })
        .catch(() => {});
      const edits = deviceEdits.current;
      api
        .devices()
        .then((d) => {
          if (active && deviceEdits.current === edits) setDevices(d);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, retry]);
  const waiting = useDelayed(!loaded && !failed);
  function note(panel: string, value?: Note) {
    setNotes((old) => ({ ...old, [panel]: value }));
  }
  async function attempt(
    panel: string,
    work: () => Promise<unknown>,
    success: string,
    failure = "That change couldn’t be saved. Check the connection and try again.",
  ) {
    note(panel);
    try {
      await work();
      note(panel, { text: success });
    } catch {
      note(panel, { text: failure, failed: true });
    }
  }
  return (
    <main id="main" className="settings-page">
      <h1>Your cinema, your way.</h1>
      <p className="settings-lead">A few things behind a great movie night.</p>
      {failed ? (
        <StatusPanel
          tone="error"
          title="Your settings couldn’t be loaded."
          action={
            <button onClick={() => setRetry((n) => n + 1)}>Try again</button>
          }
        >
          Nothing has changed. Check the connection and try again.
        </StatusPanel>
      ) : !loaded ? (
        waiting ? (
          <Placeholder label="Loading your settings" className="settings-grid">
            {[0, 1, 2].map((n) => (
              <div className="setting-panel" key={n}>
                <Line width="55%" strong className="sk-heading" />
                <Line width="90%" />
                <Line width="70%" />
                <span className="sk sk-field" />
                <span className="sk sk-button" />
              </div>
            ))}
          </Placeholder>
        ) : (
          <div className="settings-grid settings-wait" aria-busy="true" />
        )
      ) : (
        <div className="settings-grid">
          <Panel
            title="Your movie folder"
            lead="Choose the Google Drive folder that holds your films. Subfolders are included."
          >
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void runFolder(() =>
                  attempt(
                    "folder",
                    async () => {
                      await api.setFolder(folder);
                      // The change is made; a failed refresh of the status
                      // line must not be reported as a failed change.
                      void api
                        .library()
                        .then(setLibrary)
                        .catch(() => {});
                    },
                    "Folder selected. Your library is being updated.",
                    "That folder couldn’t be used. Check the link or ID, and that this Google account can open it.",
                  ),
                );
              }}
            >
              <label>
                Drive folder ID
                <input
                  name="folderId"
                  placeholder="Paste the folder’s link or ID"
                  value={folder}
                  onChange={(e) => setFolder(folderFrom(e.target.value))}
                  required
                  // The hyphen is escaped: browsers compile this with the "v" flag,
                  // where a bare one is an error and the whole pattern is ignored.
                  pattern="[A-Za-z0-9_\-]{1,160}"
                  onInvalid={(e) =>
                    e.currentTarget.setCustomValidity(
                      e.currentTarget.value
                        ? "Use the folder’s link, or its ID: letters, numbers, hyphens and underscores."
                        : "Paste the folder’s link or ID first.",
                    )
                  }
                  onInput={(e) => e.currentTarget.setCustomValidity("")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="folder-hint"
                />
              </label>
              <p className="field-hint" id="folder-hint">
                In Google Drive, open the folder and copy its address. The ID is
                the part after “folders/”.
              </p>
              <ActionButton
                className="primary"
                pending={folderBusy}
                pendingLabel="Saving the folder"
              >
                Use this folder
              </ActionButton>
            </form>
            <div className="connection-state">
              <span
                className={`live-dot ${library?.state === "failed" ? "warning" : ""}`}
                aria-hidden="true"
              />
              <span role="status">{libraryLine(library)}</span>
            </div>
            {library?.state === "running" && <Flow className="panel-flow" />}
            {library?.folderId && (
              <ActionButton
                className="text-button"
                pending={syncBusy}
                pendingLabel="Starting a library refresh"
                onClick={() =>
                  void runSync(() =>
                    attempt(
                      "folder",
                      async () => {
                        await api.sync();
                        void api
                          .library()
                          .then(setLibrary)
                          .catch(() => {});
                      },
                      "Library refresh started.",
                    ),
                  )
                }
              >
                <Icon name="refresh" />
                Refresh library
              </ActionButton>
            )}
            <Outcome note={notes.folder} />
            <p className="fine-print">
              Google grants read access to Drive. RAVAN only imports the folder
              you choose. <a href="/auth/google/start">Reconnect Google</a>
            </p>
          </Panel>
          <Panel
            title="Make it comfortable"
            lead="Your preferred languages follow you between screens."
          >
            {preferences && (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runPrefs(() =>
                    attempt(
                      "preferences",
                      async () => {
                        await api.savePreferences(preferences);
                        rememberMotion(preferences.reducedMotion);
                      },
                      "Preferences saved.",
                    ),
                  );
                }}
              >
                <label>
                  Audio language
                  <input
                    value={preferences.audioLanguage}
                    maxLength={32}
                    placeholder="en"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="language-hint"
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
                    maxLength={32}
                    placeholder="en"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="language-hint"
                    onChange={(e) =>
                      setPreferences({
                        ...preferences,
                        subtitleLanguage: e.target.value,
                      })
                    }
                  />
                </label>
                <p className="field-hint" id="language-hint">
                  Use a language code such as en, fa or fr. A film without that
                  language plays its original track.
                </p>
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
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={preferences.autoplayNext !== false}
                    aria-describedby="autoplay-hint"
                    onChange={(e) =>
                      setPreferences({
                        ...preferences,
                        autoplayNext: e.target.checked,
                      })
                    }
                  />
                  Play the next episode on its own
                </label>
                <p className="field-hint" id="autoplay-hint">
                  When an episode ends, the next one in its folder plays after
                  ten seconds. You can stop it each time, or turn it off here.
                </p>
                <ActionButton
                  pending={prefsBusy}
                  pendingLabel="Saving your preferences"
                >
                  Save preferences
                </ActionButton>
                <Outcome note={notes.preferences} />
              </form>
            )}
          </Panel>
          <Panel
            title="Pair a screen"
            lead="Open RAVAN on your device and enter its pairing code here."
          >
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void runPair(() =>
                  attempt(
                    "pairing",
                    async () => {
                      await api.approvePairing(
                        String(data.get("code"))
                          .replace(/\s/g, "")
                          .toUpperCase(),
                        data.has("watchlistWrite"),
                        data.has("reading"),
                      );
                      form.reset();
                      deviceEdits.current++;
                      void api
                        .devices()
                        .then(setDevices)
                        .catch(() => {});
                    },
                    "Device approved. Continue on your screen.",
                    "That code wasn’t accepted. Codes expire quickly: check the one on your device and enter it again.",
                  ),
                );
              }}
            >
              <label>
                Device pairing code
                <input
                  name="code"
                  className="code-input"
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ABCD EFGH"
                  pattern={
                    "\\s*[A-HJ-NP-Za-hj-np-z2-9]{4}\\s*[A-HJ-NP-Za-hj-np-z2-9]{4}\\s*"
                  }
                  required
                  onInvalid={(e) =>
                    e.currentTarget.setCustomValidity(
                      "Enter the eight characters shown on the device.",
                    )
                  }
                  onInput={(e) => e.currentTarget.setCustomValidity("")}
                />
              </label>
              <label className="checkbox">
                <input type="checkbox" name="watchlistWrite" /> Allow this
                device to change the watchlist
              </label>
              <label className="checkbox">
                <input type="checkbox" name="reading" /> Allow this device to
                open the Reading Room and save reading progress
              </label>
              <ActionButton
                pending={pairBusy}
                pendingLabel="Approving this device"
              >
                Approve this device
              </ActionButton>
              <Outcome note={notes.pairing} />
            </form>
            <h3 className="panel-subtitle" ref={screens} tabIndex={-1}>
              Paired screens
            </h3>
            {devices.length === 0 ? (
              <p className="fine-print">No paired screens yet.</p>
            ) : (
              <ul className="device-list">
                {devices.map((d) => (
                  <li className="edition" key={d.id}>
                    <span>{d.name}</span>
                    {removing === d.id ? (
                      <span className="device-confirm">
                        <ActionButton
                          ref={confirm}
                          className="danger"
                          pending={removeBusy}
                          pendingLabel={`Removing ${d.name}`}
                          onClick={() =>
                            void runRemove(async () => {
                              await attempt(
                                "devices",
                                async () => {
                                  await api.revokeDevice(d.id);
                                  deviceEdits.current++;
                                  setDevices((old) =>
                                    old.filter((x) => x.id !== d.id),
                                  );
                                },
                                `${d.name} removed. It will need a new code to connect again.`,
                              );
                              // Gone on success, still listed on failure: either
                              // way focus has somewhere to go.
                              restore.current = d.id;
                              setRemoving(undefined);
                            })
                          }
                        >
                          Remove {d.name}
                        </ActionButton>
                        <button
                          className="text-button"
                          onClick={() => {
                            restore.current = d.id;
                            setRemoving(undefined);
                          }}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        data-device={d.id}
                        aria-label={`Remove ${d.name}`}
                        onClick={() => setRemoving(d.id)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Outcome note={notes.devices} />
          </Panel>
        </div>
      )}
      <section className="settings-account" aria-label="Account">
        <ActionButton
          pending={leaving}
          pendingLabel="Signing out"
          onClick={() =>
            void runLeave(() =>
              attempt(
                "account",
                async () => {
                  await api.logout();
                  location.replace("/");
                },
                "Signed out.",
                "You are still signed in: the server could not be reached. Try again.",
              ),
            )
          }
        >
          Sign out
        </ActionButton>
        <p className="fine-print">
          Signs this browser out. Paired devices stay connected until you remove
          them above.
        </p>

        <Outcome note={notes.account} />
      </section>
      <p className="fine-print artwork-credit">
        Posters and pictures come from each film’s own cover or from a frame of
        the film.
        {credit
          ? ` Where neither is good enough, they come from The Movie Database (TMDB), which receives the film’s title and year to find them. ${credit}`
          : ""}
      </p>
    </main>
  );
}
