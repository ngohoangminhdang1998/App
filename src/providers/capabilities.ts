import type { ProviderCapabilities, ProviderId } from "./types.js";

const FLOW_NOTES = [
  "Google Flow project grid, scene merge in Flow, and Flow characters use the dedicated Chrome profile on port 9333.",
];

const MUSE_NOTES = [
  "Muse runs in a separate Chrome profile (~/.flow-mcp/muse-chrome-profile). Log in once with npm run login:muse.",
  "One Muse account = one realtime session; do not open muse.ai in another profile with the same account.",
  "Native multi-clip merge is not available in Muse; TedVerse keeps Google Flow merge when Flow is selected.",
  "Cast / Flow characters are disabled in Muse mode; use reference images in scene prompts instead.",
];

export const GOOGLE_FLOW_CAPABILITIES: ProviderCapabilities = {
  textToVideo: true,
  imageToVideo: true,
  textToImage: true,
  referenceImages: true,
  characterReferences: true,
  flowCharacters: true,
  flowVoices: true,
  aspectRatio: true,
  sceneGeneration: true,
  batchGeneration: true,
  flowSceneMerge: true,
  museNativeMerge: false,
  localFfmpegAssemble: true,
  cloudProjectStorage: true,
  assetGrid: true,
  publishModule: true,
  notes: FLOW_NOTES,
};

export const MUSE_CAPABILITIES: ProviderCapabilities = {
  textToVideo: true,
  imageToVideo: true,
  textToImage: true,
  referenceImages: true,
  characterReferences: true,
  flowCharacters: false,
  flowVoices: false,
  aspectRatio: true,
  sceneGeneration: true,
  batchGeneration: true,
  flowSceneMerge: false,
  museNativeMerge: false,
  localFfmpegAssemble: true,
  cloudProjectStorage: false,
  assetGrid: false,
  publishModule: true,
  notes: MUSE_NOTES,
};

export function capabilitiesFor(id: ProviderId): ProviderCapabilities {
  return id === "muse" ? MUSE_CAPABILITIES : GOOGLE_FLOW_CAPABILITIES;
}