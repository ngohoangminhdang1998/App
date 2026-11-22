import { capabilitiesFor, GOOGLE_FLOW_CAPABILITIES, MUSE_CAPABILITIES } from "./capabilities.js";
import type { AIProviderMeta, ProviderId } from "./types.js";

export const PROVIDER_OPTIONS: AIProviderMeta[] = [
  { id: "google-flow", name: "Google Flow", capabilities: GOOGLE_FLOW_CAPABILITIES },
  { id: "muse", name: "Muse AI", capabilities: MUSE_CAPABILITIES },
];

export function providerMeta(id: ProviderId): AIProviderMeta {
  const hit = PROVIDER_OPTIONS.find((p) => p.id === id);
  if (!hit) throw new Error(`Unknown provider "${id}".`);
  return hit;
}

export function providerPayload(active: ProviderId) {
  return {
    active,
    options: PROVIDER_OPTIONS,
    capabilities: capabilitiesFor(active),
  };
}