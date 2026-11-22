export type ProviderId = "google-flow" | "muse";

export type ProviderCapabilities = {
  textToVideo: boolean;
  imageToVideo: boolean;
  textToImage: boolean;
  referenceImages: boolean;
  characterReferences: boolean;
  flowCharacters: boolean;
  flowVoices: boolean;
  aspectRatio: boolean;
  sceneGeneration: boolean;
  batchGeneration: boolean;
  flowSceneMerge: boolean;
  museNativeMerge: boolean;
  localFfmpegAssemble: boolean;
  cloudProjectStorage: boolean;
  assetGrid: boolean;
  publishModule: boolean;
  notes: string[];
};

export interface AIProviderMeta {
  id: ProviderId;
  name: string;
  capabilities: ProviderCapabilities;
}