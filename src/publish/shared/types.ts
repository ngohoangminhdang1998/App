export type PublishPlatform = "tiktok" | "youtube" | "facebook";
export type PublishMode = "now" | "schedule";

export interface PlatformSchedule {
  /** When to publish — local date/time as picked in Studio (same clock as the Chrome profile). */
  at: Date;
}

export interface PlatformJobInput {
  videoPath: string;
  /** caption + hashtags — identical on every platform */
  finalText: string;
  mode: PublishMode;
  schedule?: PlatformSchedule;
}

export type PlatformTouch = (patch: Record<string, unknown>) => void;