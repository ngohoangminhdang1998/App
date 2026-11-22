# TedVerse × Muse AI — compatibility assessment

## Phase 1 — upstream repositories

### museforge-studio (MIT)

| Area | Status |
|------|--------|
| README / monorepo layout | Documented |
| Playwright `MuseWorker` | **Stub** — generic selectors, no cookie vault wiring in `launchContext` |
| Electron UI, SQLite, proxy, cookie vault | **Scaffold** — not suitable to drop into TedVerse |
| Job queue | In-process only, calls stub worker |

**TedVerse use:** architecture reference only; **do not** import the Electron app.

### ai-media-batch-kit (MIT)

| Area | Status |
|------|--------|
| `src/providers/muse.js` | **Production-tested** CDP driver (chat UI, attach, wait for media, download bytes) |
| `src/core/{chrome,cdp,profile-lock,window}.js` | **Required** dependencies for Muse |
| Flow / Grok / ChatGPT providers | Out of scope (TedVerse already has Flow) |
| Live E2E in this repo | Doc says verify `status → image → video` before batch |

**TedVerse use:** vendored subset under `third-party/ai-media-batch-kit/`.

## Phase 2 — TedVerse baseline (unchanged when Flow selected)

- Studio: `studio/index.html` (vanilla JS, TedVerse tokens)
- Server: `src/server.ts` → `LocalCore` API on `8787`
- Flow automation: `src/flow.ts`, `src/chrome.ts` (CDP `9333`), `src/queue.ts`
- Auto Film: `film-script.ts`, Studio `api("generate")`, merge via `flow_merge` + `scene-builder.ts`
- Publish: `src/publish/*` (TikTok / YouTube / Facebook)
- Voice: Kokoro + Gemini (no Flow Chrome)

## Phase 7 — capability matrix

| Feature | Google Flow | Muse |
|---------|-------------|------|
| Text-to-video | Yes | Yes (chat prompt) |
| Image-to-video | Yes | Yes (`refs` / prior image in chat) |
| Text-to-image | Yes | Yes |
| Reference images | Yes (Flow assets) | Yes (local file attach) |
| Flow characters (`asset:`) | Yes | **No** — use image refs |
| Flow scene merge | Yes | **No** |
| Local ffmpeg assemble | Yes | Yes (same Cut tab) |
| Publish | Yes | Yes (local file path) |
| Credits readout | Yes | **No** (free-tier % not exposed in API) |

## Isolation from Google Flow (regression safety)

| Layer | Google Flow (default) | Muse (opt-in) |
|-------|----------------------|---------------|
| `provider.json` | `google-flow` or missing file | `muse` only after user picks |
| Queue | `dispatch-job` → `flow-queue-runner.ts` only | Dynamic `import("./muse/queue-job.js")` |
| `status` API | **Same JSON as before** (`flow`, `pacing`, `output_root`, `jobs`) | Extra `muse` + `provider` fields |
| `flow.ts`, `scene-builder.ts`, `chrome.ts` | No imports from `providers/muse/` | Unchanged |
| Chrome profile | `~/.flow-mcp/chrome-profile` :9333 | `muse-chrome-profile` (separate) |
| Studio UI | Default path; Muse CSS only when `body[data-provider=muse]` | Platform picker + Muse connect |

Rule for future Muse work: add files under `src/providers/muse/` and `third-party/`; do not edit `flow.ts` / `scene-builder.ts` for Muse behavior.

## Implementation status

| Phase | Status |
|-------|--------|
| Platform picker UI | **Done** — overlay + header switch |
| Provider config `~/.flow-mcp/provider.json` | **Done** |
| Muse CDP driver vendored | **Done** |
| `npm run login:muse` | **Done** |
| Queue → Muse for Shots / Auto Film generate | **Done** (basic path) |
| Muse merge | **Not supported** — UI warns; Flow merge disabled in Muse mode |
| Cast / Flow-only tabs | **Dimmed** in Muse mode |
| MCP tool docs for provider | Partial (`provider_*` API on Studio server) |

## Tests

- `npm run build`
- `node scripts/film-script.test.mjs` (unchanged)
- Real Muse generation: **manual only** — spends quota; use after `login:muse` + `provider_select: muse`