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

/** V3 speaking pace — keeps clips dialogue-heavy for Flow / Omni talking takes. */
export const PROMPT_V3_DIALOGUE_DENSITY = `DIALOGUE DENSITY:
Spoken Vietnamese must fill more than 80% of the total clip duration (under 20% silence or dead air).
Characters talk almost continuously at a natural Southern Vietnamese pace; no long silent stares, slow walks without speech, or reaction-only beats.
Include enough quoted Vietnamese lines in the DIALOGUE section to fill the full clip; back-to-back lines with only brief pauses between speakers.
Under DIALOGUE, add a SPOKEN TIMELINE with second ranges (e.g. "0.0-1.4s:", "1.4-5.6s:") mapping each quoted line to the clip clock so speech runs 80%+ of the clip.`;

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

export function promptHasDialogueDensityBlock(prompt: string): boolean {
  return /DIALOGUE DENSITY\s*:/i.test(prompt) && /80\s*%/i.test(prompt);
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

/**
 * Ensures V3 dialogue-density instructions are present for V2/V3 script prompts.
 * Skips legacy prompts with no DIALOGUE / LANGUAGE AND AUDIO section.
 */
export function ensurePromptDialogueDensity(prompt: string): string {
  let t = String(prompt ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return t;
  if (promptHasDialogueDensityBlock(t)) return t;
  const hasDialogueSection = /\bDIALOGUE\s*:/i.test(t) || /\bLANGUAGE AND AUDIO\s*:/i.test(t);
  if (!hasDialogueSection) return t;

  const block = PROMPT_V3_DIALOGUE_DENSITY;
  const dialogueIdx = t.search(/\bDIALOGUE\s*:/i);
  if (dialogueIdx >= 0) {
    const after = t.slice(dialogueIdx);
    const nextSec = after.search(/\n(?=PERFORMANCE\s*:|CAMERA\s*:|AUDIO\s*:|VISUAL TEXT RESTRICTION\s*:|No subtitles)/i);
    if (nextSec > 0) {
      const insertAt = dialogueIdx + nextSec;
      return `${t.slice(0, insertAt)}\n\n${block}${t.slice(insertAt)}`.replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  if (/\bVISUAL TEXT RESTRICTION\s*:/i.test(t)) {
    return t
      .replace(/\bVISUAL TEXT RESTRICTION\s*:/i, `${block}\n\nVISUAL TEXT RESTRICTION:`)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return `${t}\n\n${block}`.replace(/\n{3,}/g, "\n\n").trim();
}