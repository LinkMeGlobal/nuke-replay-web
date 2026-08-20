# NUKE Replay for Web

Private LinkMe SDK for explicit, internal-team bug reports with bounded rrweb
history, semantic actions, capped text/JSON network diagnostics, offline retry,
and replay-scoped uploads to `replay.nuke.bio`.

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

The internal pilot intentionally records visible DOM/input state. Add
`nuke-replay-block`, `nuke-replay-mask`, or `nuke-replay-ignore` to opt out a
surface without waiting for the later automatic-masking phase.

