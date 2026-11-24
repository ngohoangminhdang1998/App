import type { PublishPlatform } from "../publish.js";

const STUDIO_PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);

/** Public HTTPS origin for OAuth callbacks (Meta requires https). Example: https://abc.trycloudflare.com */
export function oauthPublicOrigin(): string | null {
  const raw = process.env.FLOW_MCP_OAUTH_PUBLIC_URL?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let origin: string;
  try {
    origin = new URL(withScheme).origin;
  } catch {
    throw new Error(`FLOW_MCP_OAUTH_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  return origin;
}

export function publishOAuthRedirect(platform: PublishPlatform): string {
  const pub = oauthPublicOrigin();
  if (pub) return `${pub}/oauth/callback/${platform}`;
  return `http://127.0.0.1:${STUDIO_PORT}/oauth/callback/${platform}`;
}

/** Host headers allowed when tunnel forwards HTTPS to local Studio. */
export function oauthTunnelHosts(): string[] {
  const pub = oauthPublicOrigin();
  if (!pub) return [];
  const host = new URL(pub).host.toLowerCase();
  return [host];
}