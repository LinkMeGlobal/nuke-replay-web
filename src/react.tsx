import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { NukeReplayClient } from "./client";
import type { ReplayProgress, ReplayProject, ReplayReportInput } from "./types";

const ReplayContext = createContext<NukeReplayClient | null>(null);

export interface NukeReplayProviderProps {
  client: NukeReplayClient;
  children: ReactNode;
  enabled?: boolean;
  launcher?: boolean;
  shortcut?: boolean;
}

export function NukeReplayProvider({
  client,
  children,
  enabled = true,
  launcher = true,
  shortcut = true,
}: NukeReplayProviderProps) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ReplayProgress | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void client.start();
    return () => client.stop();
  }, [client, enabled]);

  useEffect(() => client.subscribe(setOpen), [client]);
  useEffect(() => client.subscribeProgress(setProgress), [client]);

  useEffect(() => {
    if (!shortcut) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        client.openReporter();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [client, shortcut]);

  const handleOpen = useCallback(() => client.openReporter(), [client]);
  const reportingBusy = progress !== null && progress.phase !== "complete";

  return (
    <ReplayContext.Provider value={client}>
      {children}
      {launcher ? (
        <button
          type="button"
          className="nuke-replay-launcher"
          onClick={handleOpen}
          disabled={reportingBusy}
          aria-label={reportingBusy ? "Replay upload in progress" : "Report a bug"}
        >
          {reportingBusy ? "Uploading report" : "Report bug"}
        </button>
      ) : null}
      {open ? <ReplayReporter client={client} /> : null}
      {progress ? <ReplayProgressNotice progress={progress} /> : null}
      <ReplayStyles />
    </ReplayContext.Provider>
  );
}

export function useNukeReplay(): NukeReplayClient {
  const client = useContext(ReplayContext);
  if (!client) throw new Error("useNukeReplay must be used inside NukeReplayProvider");
  return client;
}

function ReplayReporter({ client }: { client: NukeReplayClient }) {
  const [projects, setProjects] = useState<Array<ReplayProject>>(client.fallbackProjects);
  const [projectId, setProjectId] = useState(client.defaultProjectId);
  const [title, setTitle] = useState("");
  const [whatDidYouDo, setWhatDidYouDo] = useState("");
  const [whatHappened, setWhatHappened] = useState("");
  const [whatShouldHaveHappened, setWhatShouldHaveHappened] = useState("");
  const [historyMinutes, setHistoryMinutes] = useState<5 | 15 | 30>(15);
  const [includeReplay, setIncludeReplay] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.prepareReporter()
      .then((result) => {
        if (!active) return;
        setProjects(result.projects);
        setProjectId(result.defaultProjectId);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not prepare the reporter");
      })
      .finally(() => {
        if (active) setPreparing(false);
      });
    return () => { active = false; };
  }, [client]);

  const close = useCallback(() => {
    void client.cancelPrepared();
    client.closeReporter();
  }, [client]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !projectId || submitting) return;
    setSubmitting(true);
    setError(null);
    const report: ReplayReportInput = {
      title: title.trim(),
      whatDidYouDo: whatDidYouDo.trim(),
      whatHappened: whatHappened.trim(),
      whatShouldHaveHappened: whatShouldHaveHappened.trim(),
      projectId,
      priority: "medium",
      platforms: [window.matchMedia("(max-width: 767px)").matches ? "web_mobile" : "web_desktop"],
      pageUrl: window.location.href,
      historyMinutes,
    };
    try {
      const result = await client.submit(report, includeReplay);
      setReference(result.reference);
      client.closeReporter();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the report");
    } finally {
      setSubmitting(false);
    }
  }, [client, historyMinutes, includeReplay, projectId, submitting, title, whatDidYouDo, whatHappened, whatShouldHaveHappened]);

  const projectOptions = useMemo(() => projects.map((project) => (
    <option key={project.id} value={project.id}>{project.name}</option>
  )), [projects]);

  if (reference) {
    return (
      <div className="nuke-replay-backdrop" role="presentation">
        <section className="nuke-replay-dialog" role="dialog" aria-modal="true" aria-labelledby="nuke-success-title">
          <h2 id="nuke-success-title">Report submitted</h2>
          <p>Thanks—your report is <strong>{reference}</strong>.</p>
          <button type="button" className="nuke-replay-primary" onClick={close}>Done</button>
        </section>
      </div>
    );
  }

  return (
    <div className="nuke-replay-backdrop" role="presentation">
      <section className="nuke-replay-dialog" role="dialog" aria-modal="true" aria-labelledby="nuke-reporter-title">
        <header className="nuke-replay-header">
          <div>
            <h2 id="nuke-reporter-title">Report a bug</h2>
            <p>Send the NUKE team enough context to reproduce it.</p>
          </div>
          <button type="button" className="nuke-replay-close" onClick={close} aria-label="Close reporter">×</button>
        </header>
        <form onSubmit={submit}>
          <label>Title<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>What did you do?<textarea maxLength={6500} value={whatDidYouDo} onChange={(event) => setWhatDidYouDo(event.target.value)} /></label>
          <label>What happened?<textarea maxLength={6500} value={whatHappened} onChange={(event) => setWhatHappened(event.target.value)} /></label>
          <label>What should have happened?<textarea maxLength={6500} value={whatShouldHaveHappened} onChange={(event) => setWhatShouldHaveHappened(event.target.value)} /></label>
          <label>Project<select required disabled={preparing} value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projectOptions}</select></label>
          <label>Recent history<select value={historyMinutes} onChange={(event) => setHistoryMinutes(Number(event.target.value) as 5 | 15 | 30)}>
            <option value={5}>Last 5 minutes</option><option value={15}>Last 15 minutes</option><option value={30}>Last 30 minutes</option>
          </select></label>
          <label className="nuke-replay-check"><input type="checkbox" checked={includeReplay} onChange={(event) => setIncludeReplay(event.target.checked)} />Attach recent session replay</label>
          {includeReplay ? <p className="nuke-replay-warning">This attaches recent screen contents, visible form state, clicks, console errors, and capped text/JSON network request and response bodies. Authentication credentials are excluded.</p> : null}
          {error ? <p className="nuke-replay-error" role="alert">{error}</p> : null}
          <div className="nuke-replay-actions">
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit" className="nuke-replay-primary" disabled={preparing || submitting || !title.trim()}>{submitting ? "Submitting…" : "Submit report"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ReplayProgressNotice({ progress }: { progress: ReplayProgress }) {
  const byteProgress = `${formatBytes(progress.bytesUploaded)} / ${formatBytes(progress.bytesTotal)}`;
  const label = progress.phase === "uploading"
    ? `Uploading ${byteProgress}`
    : progress.phase === "processing"
      ? "Processing replay"
      : progress.phase === "complete"
        ? "Replay attached"
        : progress.phase === "failed"
          ? "Replay upload paused"
          : "Preparing replay";
  return (
    <aside className={`nuke-replay-progress nuke-replay-progress-${progress.phase}`} role="status" aria-live="polite">
      <strong>{progress.reference ? `${progress.reference} · ` : ""}{label}</strong>
      {progress.message ? <span>{progress.message}</span> : null}
      {progress.phase === "uploading" && progress.bytesTotal > 0 ? (
        <progress max={progress.bytesTotal} value={progress.bytesUploaded} />
      ) : null}
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function ReplayStyles() {
  return <style>{`
    .nuke-replay-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;background:#161616;color:#fff;padding:10px 15px;font:600 14px/1.2 system-ui;box-shadow:0 8px 30px #0003;cursor:pointer}.nuke-replay-launcher:disabled{cursor:wait;opacity:.72}
    .nuke-replay-progress{position:fixed;right:16px;bottom:64px;z-index:2147483000;display:grid;width:min(340px,calc(100vw - 32px));gap:6px;border:1px solid #ddd;border-radius:12px;background:#fff;padding:12px 14px;color:#171717;font:500 13px/1.35 system-ui;box-shadow:0 12px 36px #0003}.nuke-replay-progress span{color:#666}.nuke-replay-progress progress{width:100%;height:6px;accent-color:#161616}.nuke-replay-progress-complete{border-color:#8cc7a0}.nuke-replay-progress-failed{border-color:#e3a09a}
    .nuke-replay-backdrop{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;padding:16px;background:#0009;font-family:system-ui;color:#171717}
    .nuke-replay-dialog{width:min(620px,100%);max-height:calc(100dvh - 32px);overflow:auto;border-radius:16px;background:#fff;padding:22px;box-shadow:0 24px 80px #0006}
    .nuke-replay-header{display:flex;justify-content:space-between;gap:16px}.nuke-replay-header h2,.nuke-replay-dialog h2{margin:0;font-size:22px}.nuke-replay-header p{margin:4px 0 0;color:#666}
    .nuke-replay-close{border:0;background:transparent;font-size:28px;line-height:1;cursor:pointer}.nuke-replay-dialog form{display:grid;gap:14px;margin-top:18px}.nuke-replay-dialog label{display:grid;gap:6px;font-size:13px;font-weight:650}
    .nuke-replay-dialog input:not([type=checkbox]),.nuke-replay-dialog textarea,.nuke-replay-dialog select{box-sizing:border-box;width:100%;border:1px solid #d7d7d7;border-radius:8px;background:#fff;padding:10px 11px;color:#171717;font:400 16px/1.4 system-ui}.nuke-replay-dialog textarea{min-height:72px;resize:vertical}
    .nuke-replay-check{display:flex!important;grid-template-columns:auto 1fr;align-items:center}.nuke-replay-check input{width:18px;height:18px}.nuke-replay-warning{margin:0;border-radius:8px;background:#fff5d9;padding:10px 12px;color:#654a00;font-size:13px}.nuke-replay-error{margin:0;color:#b42318}
    .nuke-replay-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.nuke-replay-actions button,.nuke-replay-primary{border:1px solid #d7d7d7;border-radius:8px;background:#fff;padding:10px 14px;font:600 14px system-ui;cursor:pointer}.nuke-replay-primary{border-color:#161616!important;background:#161616!important;color:#fff}.nuke-replay-actions button:disabled{opacity:.5;cursor:not-allowed}
    @media(prefers-color-scheme:dark){.nuke-replay-dialog,.nuke-replay-progress{border-color:#444;background:#1d1d1d;color:#f5f5f5}.nuke-replay-header p,.nuke-replay-progress span{color:#aaa}.nuke-replay-dialog input:not([type=checkbox]),.nuke-replay-dialog textarea,.nuke-replay-dialog select{border-color:#444;background:#272727;color:#fff}}
  `}</style>;
}
