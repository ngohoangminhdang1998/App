import { randomBytes } from "node:crypto";
import type { PublishPlatform } from "../publish.js";

const pending = new Map<string, { platform: PublishPlatform; created: number; codeVerifier?: string }>();
const TTL_MS = 15 * 60_000;

export function oauthStateNew(platform: PublishPlatform, codeVerifier?: string): string {
  const state = randomBytes(16).toString("hex");
  pending.set(state, { platform, created: Date.now(), codeVerifier });
  for (const [k, v] of pending) {
    if (Date.now() - v.created > TTL_MS) pending.delete(k);
  }
  return state;
}

export function oauthStateTake(state: string): { platform: PublishPlatform; codeVerifier?: string } | undefined {
  const row = pending.get(state);
  pending.delete(state);
  if (!row || Date.now() - row.created > TTL_MS) return undefined;
  return row;
}