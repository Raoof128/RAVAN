import { spawn } from "node:child_process";
export type MediaFailureCode =
  | "media_failed"
  | "media_resources"
  | "media_storage"
  | "media_source"
  | "media_timeout"
  | "media_cancelled"
  | "media_unavailable"
  | "source_changed";
export class MediaProcessError extends Error {
  constructor(
    readonly code: MediaFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MediaProcessError";
  }
}
export function mediaFailureCode(error: unknown): MediaFailureCode {
  if (error instanceof MediaProcessError) return error.code;
  if (error instanceof Error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOSPC" ||
      [
        "Prepared storage full",
        "Output budget exceeded",
        "Output budget too small for complete video",
      ].includes(error.message)
    )
      return "media_storage";
    if (error.message === "Source changed") return "source_changed";
  }
  return "media_failed";
}
export function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 30000,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Nothing of this service's own. Its environment holds the encryption
      // key, the worker key and the Google client secret, and these tools
      // parse files this server did not write.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        LANG: "C.UTF-8",
      },
    });
    // Only fixed classifications leave this function. Raw stderr may contain
    // private source URLs/headers, so never attach it to errors or logs.
    let diagnosticWindow = "",
      diagnosticCode: MediaFailureCode = "media_failed";
    let output = "",
      failure: Error | undefined;
    let killer: ReturnType<typeof setTimeout> | undefined;
    function stop(error: Error) {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
        killer ??= setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }, 1000);
        killer.unref();
      }
    }
    const abort = () =>
      stop(
        new MediaProcessError("media_cancelled", "Media operation cancelled"),
      );
    const timer = setTimeout(
      () =>
        stop(
          new MediaProcessError("media_timeout", "Media operation timed out"),
        ),
      timeoutMs,
    );
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (onOutput) {
        try {
          onOutput(chunk.toString());
        } catch {
          stop(new Error("Media progress failed"));
        }
        return;
      }
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1024 * 1024)
        stop(new Error("Media output limit"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticWindow = (diagnosticWindow + chunk.toString()).slice(-8192);
      if (
        /pthread_create.*failed|Cannot allocate memory|Resource temporarily unavailable|Too many open files/i.test(
          diagnosticWindow,
        )
      )
        diagnosticCode = "media_resources";
      else if (
        /No space left on device|Disk quota exceeded/i.test(diagnosticWindow) &&
        diagnosticCode === "media_failed"
      )
        diagnosticCode = "media_storage";
      else if (
        /Connection reset|Connection timed out|Server returned [45]\d\d|HTTP error [45]\d\d|Input\/output error/i.test(
          diagnosticWindow,
        ) &&
        diagnosticCode === "media_failed"
      )
        diagnosticCode = "media_source";
    });
    function cleanup() {
      diagnosticWindow = "";
      clearTimeout(timer);
      clearTimeout(killer);
      signal.removeEventListener("abort", abort);
    }
    child.once("error", () => {
      cleanup();
      reject(
        new MediaProcessError(
          "media_unavailable",
          "Media executable unavailable",
        ),
      );
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new MediaProcessError(
            signal === "SIGKILL" ? "media_resources" : diagnosticCode,
            "Media operation failed",
          ),
        );
      else resolve(output);
    });
    if (signal.aborted) abort();
  });
}
