import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, } from "react";
const ReplayContext = createContext(null);
export function NukeReplayProvider({ client, children, launcher = true, shortcut = true, }) {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        void client.start();
        return () => client.stop();
    }, [client]);
    useEffect(() => client.subscribe(setOpen), [client]);
    useEffect(() => {
        if (!shortcut)
            return;
        const handleKeyDown = (event) => {
            const target = event.target;
            if (target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                (target instanceof HTMLElement && target.isContentEditable))
                return;
            if (event.altKey && event.shiftKey && event.key.toLowerCase() === "b") {
                event.preventDefault();
                client.openReporter();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [client, shortcut]);
    const handleOpen = useCallback(() => client.openReporter(), [client]);
    return (_jsxs(ReplayContext.Provider, { value: client, children: [children, launcher ? (_jsx("button", { type: "button", className: "nuke-replay-launcher", onClick: handleOpen, "aria-label": "Report a bug", children: "Report bug" })) : null, open ? _jsx(ReplayReporter, { client: client }) : null, _jsx(ReplayStyles, {})] }));
}
export function useNukeReplay() {
    const client = useContext(ReplayContext);
    if (!client)
        throw new Error("useNukeReplay must be used inside NukeReplayProvider");
    return client;
}
function ReplayReporter({ client }) {
    const [projects, setProjects] = useState(client.fallbackProjects);
    const [projectId, setProjectId] = useState(client.defaultProjectId);
    const [title, setTitle] = useState("");
    const [whatDidYouDo, setWhatDidYouDo] = useState("");
    const [whatHappened, setWhatHappened] = useState("");
    const [whatShouldHaveHappened, setWhatShouldHaveHappened] = useState("");
    const [historyMinutes, setHistoryMinutes] = useState(15);
    const [includeReplay, setIncludeReplay] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [preparing, setPreparing] = useState(true);
    const [error, setError] = useState(null);
    const [reference, setReference] = useState(null);
    useEffect(() => {
        let active = true;
        void client.prepareReporter()
            .then((result) => {
            if (!active)
                return;
            setProjects(result.projects);
            setProjectId(result.defaultProjectId);
        })
            .catch((cause) => {
            if (active)
                setError(cause instanceof Error ? cause.message : "Could not prepare the reporter");
        })
            .finally(() => {
            if (active)
                setPreparing(false);
        });
        return () => { active = false; };
    }, [client]);
    const close = useCallback(() => {
        void client.cancelPrepared();
        client.closeReporter();
    }, [client]);
    const submit = useCallback(async (event) => {
        event.preventDefault();
        if (!title.trim() || !projectId || submitting)
            return;
        setSubmitting(true);
        setError(null);
        const report = {
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
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not submit the report");
        }
        finally {
            setSubmitting(false);
        }
    }, [client, historyMinutes, includeReplay, projectId, submitting, title, whatDidYouDo, whatHappened, whatShouldHaveHappened]);
    const projectOptions = useMemo(() => projects.map((project) => (_jsx("option", { value: project.id, children: project.name }, project.id))), [projects]);
    if (reference) {
        return (_jsx("div", { className: "nuke-replay-backdrop", role: "presentation", children: _jsxs("section", { className: "nuke-replay-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "nuke-success-title", children: [_jsx("h2", { id: "nuke-success-title", children: "Report submitted" }), _jsxs("p", { children: ["Thanks\u2014your report is ", _jsx("strong", { children: reference }), "."] }), _jsx("button", { type: "button", className: "nuke-replay-primary", onClick: close, children: "Done" })] }) }));
    }
    return (_jsx("div", { className: "nuke-replay-backdrop", role: "presentation", children: _jsxs("section", { className: "nuke-replay-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "nuke-reporter-title", children: [_jsxs("header", { className: "nuke-replay-header", children: [_jsxs("div", { children: [_jsx("h2", { id: "nuke-reporter-title", children: "Report a bug" }), _jsx("p", { children: "Send the NUKE team enough context to reproduce it." })] }), _jsx("button", { type: "button", className: "nuke-replay-close", onClick: close, "aria-label": "Close reporter", children: "\u00D7" })] }), _jsxs("form", { onSubmit: submit, children: [_jsxs("label", { children: ["Title", _jsx("input", { required: true, maxLength: 200, value: title, onChange: (event) => setTitle(event.target.value) })] }), _jsxs("label", { children: ["What did you do?", _jsx("textarea", { maxLength: 6500, value: whatDidYouDo, onChange: (event) => setWhatDidYouDo(event.target.value) })] }), _jsxs("label", { children: ["What happened?", _jsx("textarea", { maxLength: 6500, value: whatHappened, onChange: (event) => setWhatHappened(event.target.value) })] }), _jsxs("label", { children: ["What should have happened?", _jsx("textarea", { maxLength: 6500, value: whatShouldHaveHappened, onChange: (event) => setWhatShouldHaveHappened(event.target.value) })] }), _jsxs("label", { children: ["Project", _jsx("select", { required: true, disabled: preparing, value: projectId, onChange: (event) => setProjectId(event.target.value), children: projectOptions })] }), _jsxs("label", { children: ["Recent history", _jsxs("select", { value: historyMinutes, onChange: (event) => setHistoryMinutes(Number(event.target.value)), children: [_jsx("option", { value: 5, children: "Last 5 minutes" }), _jsx("option", { value: 15, children: "Last 15 minutes" }), _jsx("option", { value: 30, children: "Last 30 minutes" })] })] }), _jsxs("label", { className: "nuke-replay-check", children: [_jsx("input", { type: "checkbox", checked: includeReplay, onChange: (event) => setIncludeReplay(event.target.checked) }), "Attach recent session replay"] }), includeReplay ? _jsx("p", { className: "nuke-replay-warning", children: "This attaches recent screen contents, visible form state, clicks, console errors, and capped text/JSON network request and response bodies. Authentication credentials are excluded." }) : null, error ? _jsx("p", { className: "nuke-replay-error", role: "alert", children: error }) : null, _jsxs("div", { className: "nuke-replay-actions", children: [_jsx("button", { type: "button", onClick: close, children: "Cancel" }), _jsx("button", { type: "submit", className: "nuke-replay-primary", disabled: preparing || submitting || !title.trim(), children: submitting ? "Submitting…" : "Submit report" })] })] })] }) }));
}
function ReplayStyles() {
    return _jsx("style", { children: `
    .nuke-replay-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;background:#161616;color:#fff;padding:10px 15px;font:600 14px/1.2 system-ui;box-shadow:0 8px 30px #0003;cursor:pointer}
    .nuke-replay-backdrop{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;padding:16px;background:#0009;font-family:system-ui;color:#171717}
    .nuke-replay-dialog{width:min(620px,100%);max-height:calc(100dvh - 32px);overflow:auto;border-radius:16px;background:#fff;padding:22px;box-shadow:0 24px 80px #0006}
    .nuke-replay-header{display:flex;justify-content:space-between;gap:16px}.nuke-replay-header h2,.nuke-replay-dialog h2{margin:0;font-size:22px}.nuke-replay-header p{margin:4px 0 0;color:#666}
    .nuke-replay-close{border:0;background:transparent;font-size:28px;line-height:1;cursor:pointer}.nuke-replay-dialog form{display:grid;gap:14px;margin-top:18px}.nuke-replay-dialog label{display:grid;gap:6px;font-size:13px;font-weight:650}
    .nuke-replay-dialog input:not([type=checkbox]),.nuke-replay-dialog textarea,.nuke-replay-dialog select{box-sizing:border-box;width:100%;border:1px solid #d7d7d7;border-radius:8px;background:#fff;padding:10px 11px;color:#171717;font:400 16px/1.4 system-ui}.nuke-replay-dialog textarea{min-height:72px;resize:vertical}
    .nuke-replay-check{display:flex!important;grid-template-columns:auto 1fr;align-items:center}.nuke-replay-check input{width:18px;height:18px}.nuke-replay-warning{margin:0;border-radius:8px;background:#fff5d9;padding:10px 12px;color:#654a00;font-size:13px}.nuke-replay-error{margin:0;color:#b42318}
    .nuke-replay-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.nuke-replay-actions button,.nuke-replay-primary{border:1px solid #d7d7d7;border-radius:8px;background:#fff;padding:10px 14px;font:600 14px system-ui;cursor:pointer}.nuke-replay-primary{border-color:#161616!important;background:#161616!important;color:#fff}.nuke-replay-actions button:disabled{opacity:.5;cursor:not-allowed}
    @media(prefers-color-scheme:dark){.nuke-replay-dialog{background:#1d1d1d;color:#f5f5f5}.nuke-replay-header p{color:#aaa}.nuke-replay-dialog input:not([type=checkbox]),.nuke-replay-dialog textarea,.nuke-replay-dialog select{border-color:#444;background:#272727;color:#fff}}
  ` });
}
//# sourceMappingURL=react.js.map