# NUKE Replay for Web

Open-source browser SDK for explicit NUKE bug reports with bounded rrweb history,
semantic actions, capped text/JSON network diagnostics, offline retry, and
replay-scoped uploads to `replay.nuke.bio`.

## Installation

Install the package directly from its tagged GitHub source:

```bash
bun add 'git+https://github.com/LinkMeGlobal/nuke-replay-web.git#v0.3.1'
```

The SDK is public, but the NUKE ingestion service is not anonymous. A host must
provide an authenticated session exchange before capture can be submitted.

Capture is processed continuously rather than when the reporter is submitted:

- rrweb checkpoints close a segment every 45 seconds.
- A dedicated Web Worker serializes, gzips, and hashes closed segments.
- Encoded segments and per-chunk upload state are persisted in IndexedDB.
- The report is created first; its modal closes while replay preparation and
  four concurrent, resumable uploads continue in the background.
- Chunks target a 1.5 MiB compressed ceiling, below the service's 2 MiB hard
  limit. Retries send only chunks that are not already marked uploaded.
- DOM, inline-image, semantic-event, and network-body history have separate
  aggregate budgets. Old checkpoint segments are discarded before newer ones.

`onProgress` reports real byte totals for preparing, uploading, processing,
completion, and retry-paused states. `onTelemetry` exposes IndexedDB,
serialization, gzip, hashing, API, upload-network, and completion timings. The
same bounded client timing set is attached to replay finalization so a slow
submission can be diagnosed later.

The package never reads or stores a LinkMe access token. The host application
implements `createSession`, performs the one-time bearer exchange, and returns
only the resulting replay session capability.

```tsx
const replay = createNukeReplay({
  appId: "web-linkme",
  endpoint: config.config.apiEndpoints.nukeReplay,
  environment: config.config.env ?? "production",
  release: BUILD_SHA,
  createSession: createNukeReplaySession,
});

<NukeReplayProvider client={replay}>{children}</NukeReplayProvider>
```

The current internal pilot intentionally records visible DOM/input state. Add
`nuke-replay-block`, `nuke-replay-mask`, or `nuke-replay-ignore` to opt out a
surface without waiting for the later automatic-masking phase.

Stylesheet text remains in the compressed rrweb stream. Readable images and
runtime-loaded fonts are extracted into content-addressed assets; before upload,
the service returns only the hashes it does not already store for that app.
Replays therefore reuse identical bytes across checkpoints, reports, and users.
The viewer resolves those hashes through authenticated, replay-scoped NUKE
routes and never contacts localhost or a private-network host. Cross-origin
HTTPS assets that do not permit capture retain their public URL as a fallback.
