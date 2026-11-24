import { randomBytes } from "node:crypto";
import type { PublishPlatform } from "../publish.js";

const pending = new Map<string, { platform: PublishPlatform; created: number }>();
const TTL_MS = 15 * 60_000;

export function oauthStateNew(platform: PublishPlatform): string {
  const state = randomBytes(16).toString("hex");
  pending.set(state, { platform, created: Date.now() });
  for (const [k, v] of pending) {
    if (Date.now() - v.created > TTL_MS) pending.delete(k);
  }
  return state;
}

export function oauthStateTake(state: string): PublishPlatform | undefined {
  const row = pending.get(state);
  pending.delete(state);
  if (!row || Date.now() - row.created > TTL_MS) return undefined;
  return row.platform;
}