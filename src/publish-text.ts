type PublishPlatform = "tiktok" | "youtube" | "facebook";

const HASHTAG_BODY = /^[\p{L}\p{N}_]+$/u;

/** Optional hashtags → unique tokens, each starting with #, Unicode letters/numbers allowed. */
export function normalizeHashtags(raw: string): string[] {
  const parts = String(raw ?? "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let token of parts) {
    const body = token.replace(/^#+/, "");
    if (!body || !HASHTAG_BODY.test(body)) continue;
    const tag = `#${body}`;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** caption + space + hashtags (trimmed). Same string on every platform. */
export function buildFinalPublishText(caption: string, hashtags: string[]): string {
  const cap = String(caption ?? "").trim();
  const tags = hashtags.filter(Boolean);
  if (!tags.length) return cap;
  if (!cap) return tags.join(" ");
  return `${cap} ${tags.join(" ")}`.replace(/\s+/g, " ").trim();
}

/** @deprecated Use buildFinalPublishText */
export function buildPublishText(projectName: string, hashtags: string[]): string {
  return buildFinalPublishText(projectName, hashtags);
}

const PLATFORM_TEXT_LIMIT: Record<
  PublishPlatform,
  { max: number; field: string; note?: string }
> = {
  youtube: {
    max: 100,
    field: "YouTube Shorts title",
    note: "The same text is used for title and description.",
  },
  tiktok: { max: 2200, field: "TikTok caption" },
  facebook: { max: 2200, field: "Facebook Reels caption" },
};

export function validatePublishTextForPlatforms(platforms: PublishPlatform[], finalText: string): void {
  if (!finalText.trim()) throw new Error("Caption is empty. Write a caption before publishing.");
  const lines: string[] = [];
  for (const p of platforms) {
    const rule = PLATFORM_TEXT_LIMIT[p];
    if (finalText.length <= rule.max) continue;
    lines.push(
      `${rule.field}: ${finalText.length} characters (limit ${rule.max})${rule.note ? ` — ${rule.note}` : ""}`,
    );
  }
  if (lines.length) {
    throw new Error(`Post text is too long:\n${lines.join("\n")}\n\nShorten the caption or hashtags.`);
  }
}