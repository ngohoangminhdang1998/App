/**
 * TedVerse Prompt Format V3 — on-screen text policy (templates + runtime guard).
 */

export const PROMPT_V3_VISUAL_TEXT_RESTRICTION = `VISUAL TEXT RESTRICTION:
ABSOLUTELY NO TEXT ON SCREEN.

Do not generate any subtitles, captions,
titles, labels, logos, watermarks, signs,
letters, numbers, or written words.

No text on clothing, walls, objects,
phones, computer screens, or backgrounds.

Phone and computer screens must display
blank interfaces without readable text.

Only show characters, environments,
physical objects, and natural actions.

All dialogue must be spoken aloud,
never displayed as text.`;

export const PROMPT_V3_NO_TEXT_FOOTER = "No subtitles, no captions, no text on screen.";

const FOOTER_RE = /\n?\s*No subtitles,\s*no captions,\s*no text on screen\.?\s*$/i;

export function promptHasNoSubtitlesClause(prompt: string): boolean {
  return /no subtitles/i.test(prompt) && /no captions/i.test(prompt);
}

export function promptHasVisualTextRestrictionBlock(prompt: string): boolean {
  return /VISUAL TEXT RESTRICTION/i.test(prompt) && /ABSOLUTELY NO TEXT ON SCREEN/i.test(prompt);
}

/** Full V3 on-screen text policy: restriction block plus closing footer line. */
export function promptHasFullNoTextPolicy(prompt: string): boolean {
  return promptHasVisualTextRestrictionBlock(prompt) && promptHasNoSubtitlesClause(prompt);
}

/**
 * Ensures V3 visual-text policy is present once. Does not rewrite dialogue or other sections.
 * Skips work when both block and footer already exist.
 */
export function ensurePromptVisualTextRestriction(prompt: string): string {
  let t = String(prompt ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return t;

  const hasBlock = promptHasVisualTextRestrictionBlock(t);
  const hasFooter = FOOTER_RE.test(t) || /\bno subtitles,\s*no captions,\s*no text on screen\b/i.test(t);

  if (hasBlock && hasFooter) return t;

  if (!hasBlock) {
    if (FOOTER_RE.test(t)) {
      t = t.replace(FOOTER_RE, `\n\n${PROMPT_V3_VISUAL_TEXT_RESTRICTION}\n\n${PROMPT_V3_NO_TEXT_FOOTER}`);
    } else {
      t = `${t}\n\n${PROMPT_V3_VISUAL_TEXT_RESTRICTION}`;
    }
  }

  if (!/\bno subtitles,\s*no captions,\s*no text on screen\b/i.test(t)) {
    t = `${t}\n\n${PROMPT_V3_NO_TEXT_FOOTER}`;
  }

  return t.replace(/\n{3,}/g, "\n\n").trim();
}