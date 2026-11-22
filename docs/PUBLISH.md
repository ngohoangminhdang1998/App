# TedVerse / flow-mcp social publishing (Playwright)

Publishing drives **the same Chrome profile** as Google Flow (`getBrowserPage` in `src/chrome.ts`). Each laptop keeps its own sessions.

## Shared pipeline

1. Flow **Final** video → `fetchFlowVideoStaging` (one download under `~/.flow-mcp/publish-staging/`).
2. `assertPublishVideoFile` (exists, size, ffprobe).
3. `finalText = caption + " " + hashtags` (`src/publish-text.ts`).
4. Platforms run **sequentially**; temp folder removed after all complete.
5. Per-platform status in `~/.flow-mcp/publish-state.json`.

## Status values

`not_published` | `preparing` | `uploading` | `processing` | `publishing` | `published` | `scheduling` | `scheduled` | `failed` | `needs_attention` | `unknown`

Only `published` / `scheduled` when the UI check passes; otherwise `unknown` (uncertain) or `needs_attention`.

## Native scheduling

Studio **datetime-local** = **this PC’s local time** (same as typing in Chrome). No TedVerse cron or `publish-schedule.json`.

If a platform has no native schedule UI for the account, status is `failed` with an explicit message.

## Environment

| Variable | Purpose |
|----------|---------|
| `FLOW_MCP_PUBLISH_DEBUG=1` | Step logs + screenshots in `~/.flow-mcp/publish-debug/<platform>/` |
| `FLOW_MCP_PUBLISH_AUTH_MS` | Manual login wait (default 4 min) |
| `FLOW_MCP_YOUTUBE_MADE_FOR_KIDS` | `yes` or `no` — required for automated audience step |
| `FLOW_MCP_PUBLISH_MOCK=1` | Unit tests only (`scripts/publish.test.mjs`) |

## Codegen (selector discovery)

```bash
node scripts/publish-codegen.mjs youtube
```

Record flows by hand; port verified `getByRole` / `getByLabel` locators into `src/publish/platforms/`. **Do not** ship raw codegen without review.

## Verification status (honest)

| Phase | Item | Code | Live E2E verified |
|-------|------|------|-------------------|
| 1 | Shared infra | Yes | Partial (mock + debug) |
| 2 | YouTube Publish Now | Yes | **No** — needs signed-in run |
| 3 | YouTube Schedule | Yes | **No** |
| 4 | TikTok Publish Now | Yes | **No** |
| 5 | TikTok Schedule | Yes | **No** |
| 6 | Facebook Reels Now | Yes | **No** |
| 7 | Facebook Schedule | Yes | **No** |
| 8 | Multi-platform | Yes | **No** |
| 9 | Retry / duplicate guard | Partial | Uncertain → confirm before retry |

After `npm run build`, restart the process on port **8787** (not Claude Desktop’s MCP unless you restart Claude).