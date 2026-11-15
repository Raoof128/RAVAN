import type { Quality } from "../../../../packages/contracts/src/index.js";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../../../packages/client/src/api.js";
import { StatusPanel } from "../../../../packages/ui/src/StatusPanel.js";
import { BrowserAdapter } from "../player/BrowserAdapter.js";
import {
  PlayerController,
  type ControllerState,
} from "../player/PlayerController.js";
export function Player({
  id,
  startOver = false,
}: {
  id: string;
  startOver?: boolean;
}) {
  const api = useApi();
  const [quality, setQuality] = useState<Quality>("auto");
  const [audioTrack, setAudioTrack] = useState<number | undefined>();
  const [audioTracks, setAudioTracks] = useState<
    Array<{ index: number; label: string }>
  >([]);
  const replacement = useRef<string | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null),
    controller = useRef<PlayerController | null>(null);
  const checkpoint = useRef<{ id: string; position: number } | undefined>(
    undefined,
  );
  const [state, setState] = useState<ControllerState>({ kind: "loading" }),
    [title, setTitle] = useState("Your film"),
    [retry, setRetry] = useState(0),
    [resume, setResume] = useState(0);
  useEffect(() => {
    let active = true;
    const player = new PlayerController(
      api,
      new BrowserAdapter(video.current!),
      (s) => {
        if (active) {
          setState(s);
          if (s.kind === "ready")
            void api
              .detail(id)
              .then((movie) => {
                if (active) setAudioTracks(movie.audioTracks ?? []);
              })
              .catch(() => {});
        }
      },
      { quality, audioTrack },
    );
    controller.current = player;
    api
      .detail(id)
      .then((movie) => {
        if (active) {
          setTitle(movie.title);
          setAudioTracks(movie.audioTracks ?? []);
          const start =
            checkpoint.current?.id === id
              ? checkpoint.current.position
              : startOver
                ? 0
                : movie.resumeMs;
          setResume(start);
          void player.start(id, "web", start, replacement.current);
          replacement.current = undefined;
        }
      })
      .catch(() => {
        if (active)
          setState({ kind: "error", reason: "The film could not be loaded." });
      });
    return () => {
      active = false;
      if (video.current && video.current.readyState > 0)
        checkpoint.current = {
          id,
          position: video.current.ended ? 0 : video.current.currentTime * 1000,
        };
      replacement.current = player.sessionId;
      controller.current = null;
      void player.destroy();
    };
  }, [api, id, startOver, retry, quality, audioTrack]);
  const visible = state.kind === "ready" || state.kind === "paused";
  return (
    <main id="main" className="player-page">
      <div className="player-heading">
        <h1>{title}</h1>
        <a className="button" href={`#/movie/${encodeURIComponent(id)}`}>
          Close player
        </a>
      </div>
      <div className="playback-options">
        <label>
          Quality{" "}
          <select
            aria-label="Playback quality"
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
          >
            {[
              ["auto", "Auto · recommended"],
              ["original", "Original resolution"],
              ["480p", "480p · save data"],
              ["720p", "720p HD"],
              ["1080p", "1080p Full HD"],
              ["1440p", "1440p"],
              ["2160p", "2160p 4K"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {audioTracks.length > 1 && (
          <label>
            Audio{" "}
            <select
              aria-label="Audio track"
              value={audioTrack ?? ""}
              onChange={(e) =>
                setAudioTrack(
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            >
              <option value="">Preferred / original</option>
              {audioTracks.map((a) => (
                <option key={a.index} value={a.index}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {state.kind === "ready" && state.session.label && (
          <span className="muted">{state.session.label}</span>
        )}
      </div>
      <video
        ref={video}
        controls
        playsInline
        preload="metadata"
        aria-label={`${title} player`}
        hidden={!visible}
      />
      {state.kind === "loading" ? (
        <StatusPanel title="Setting the scene…">
          Connecting to your film.
        </StatusPanel>
      ) : state.kind === "preparing" ? (
        <StatusPanel title="Getting your film ready…">
          <p>
            {state.reason ??
              "Checking compatibility. Playback will start automatically when ready."}
          </p>
          {state.progress !== undefined && (
            <>
              <progress
                aria-label="Preparation progress"
                max={100}
                value={state.progress}
              />
              <p>{Math.floor(state.progress)}% prepared</p>
            </>
          )}
          <p className="fine-print">
            The first conversion may take a while on this server. You can close
            this page; preparation continues and the finished edition is reused.
            Quality choices never upscale the source.
          </p>
        </StatusPanel>
      ) : state.kind === "unsupported" ? (
        <StatusPanel title="This edition needs another way to play.">
          {state.reason}
        </StatusPanel>
      ) : state.kind === "conflict" ? (
        <StatusPanel
          title="A film is already playing."
          action={
            <button
              className="primary"
              onClick={() =>
                void controller.current?.start(
                  id,
                  "web",
                  resume,
                  state.sessionId,
                )
              }
            >
              Stop that session and play here
            </button>
          }
        >
          Continuing here will stop playback on the other screen.
        </StatusPanel>
      ) : state.kind === "error" ? (
        <StatusPanel
          title="Let’s try that again."
          action={
            <button onClick={() => setRetry((n) => n + 1)}>
              Retry playback
            </button>
          }
        >
          {state.reason}
        </StatusPanel>
      ) : state.kind === "paused" ? (
        <p className="muted">
          Your film is ready. Use the player’s play button to begin.
        </p>
      ) : null}
      <p className="fine-print">
        Your position is saved while watching and when you pause. Audio and
        caption choices depend on the source file.
      </p>
    </main>
  );
}
