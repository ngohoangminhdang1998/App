/**
 * Single switch for generation provider. Google Flow is the default; Muse is opt-in via provider.json.
 * Flow automation (flow.ts, scene-builder.ts, chrome.ts) must never import from providers/muse/.
 */
import { getActiveProviderId } from "./platform-config.js";

export function isMuseProvider(): boolean {
  return getActiveProviderId() === "muse";
}

export function isFlowProvider(): boolean {
  return !isMuseProvider();
}