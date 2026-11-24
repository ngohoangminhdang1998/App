#!/usr/bin/env node
// Standalone Studio: runs the panel without Claude. If Claude's MCP process already serves it, just opens that.
import { LocalCore } from "./core.js";
import { PORT, startServer } from "./server.js";
import { openUrl } from "./platform.js";

const role = await startServer(new LocalCore());
const url = `http://127.0.0.1:${PORT}`;
if (role === "none") {
  console.error(`Port ${PORT} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
if (role === "owner") {
  console.log(`TedVerse running at ${url} (Ctrl+C to stop)`);
  if (process.env.FLOW_MCP_OAUTH_PUBLIC_URL?.trim()) {
    const { oauthPublicOrigin, publishOAuthRedirect } = await import("./publish-api/oauth-base.js");
    const origin = oauthPublicOrigin();
    if (origin) {
      console.log(`OAuth public base: ${origin}`);
      console.log(`  Facebook redirect: ${publishOAuthRedirect("facebook")}`);
    }
  }
} else {
  console.log(`TedVerse is already served by another flow-mcp process at ${url}`);
}
openUrl(url);
if (role === "client") process.exit(0);
