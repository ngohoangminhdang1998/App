export type PublishPlatform = "tiktok" | "youtube" | "facebook";
export type PublishMode = "now" | "schedule";

export interface PlatformSchedule {
  /** Absolute UTC instant for platform APIs (or browser pickers when engine=browser). */
  at: Date;
  /** IANA timezone used to interpret `schedule_at` from Studio (e.g. Asia/Ho_Chi_Minh). */
  timeZone?: string;
}

export interface PlatformJobInput {
  videoPath: string;
  /** caption + hashtags — identical on every platform */
  finalText: string;
  mode: PublishMode;
  schedule?: PlatformSchedule;
}

export type PlatformTouch = (patch: Record<string, unknown>) => void;