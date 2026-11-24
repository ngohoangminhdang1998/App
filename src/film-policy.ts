/**
 * TedVerse Prompt Format V3 — policy-aware checks for Google Flow / Generative AI use policies.
 * Heuristic context review only; not a substitute for Google's classifier. V2 structure is preserved.
 */

import {
  promptHasDialogueDensityBlock,
  promptHasNoSubtitlesClause,
  promptHasVisualTextRestrictionBlock,
} from "./film-prompt-text.js";

function isPromptFormatV2(prompt: string): boolean {
  const t = String(prompt ?? "").replace(/\r\n/g, "\n");
  return /\bLANGUAGE AND AUDIO\s*:/i.test(t) && /\bAUDIO\s*:/i.test(t);
}

function flowNewsRiskInPrompt(prompt: string): boolean {
  return /\b(breaking news|news report|live news|news channel|news bulletin|báo chính|tin nóng|điểm tin|thời sự|current events|misinformation|reputational)\b/i.test(
    prompt,
  );
}

export type PolicySeverity = "info" | "warn" | "block";
export type PolicyValidationStatus = "pass" | "warn" | "block";

export interface PolicyFinding {
  code: string;
  severity: PolicySeverity;
  message: string;
  /** Short pointer to provider policy theme (documentation alignment). */
  policyRef?: string;
}

export interface ScenePolicyValidation {
  sceneNumber: number;
  status: PolicyValidationStatus;
  format: "legacy" | "v2" | "v3";
  findings: PolicyFinding[];
}

export interface FilmPolicySummary {
  pass: number;
  warn: number;
  block: number;
  scenes: ScenePolicyValidation[];
}

const FICTION_MARKERS =
  /\b(fictional|imaginary|alternate[- ]universe|comedy sketch|clearly fictional|không phải tin thật|giả tưởng)\b/i;
const NO_NEWS_MARKERS =
  /\b(no news broadcast|no documentary|not a documentary|not a news|không phải bản tin|không phải phim tài liệu)\b/i;

const POLICY_TOPIC =
  /\b(law|tax|salary|wage|government|policy|marriage|divorce|vietnam|việt nam|lương|luật|chính phủ|ly hôn|thuế|công khai lương)\b/i;

const OFFICIAL_DECEPTIVE =
  /\b(official (announcement|decree|proclamation)|government seal|presidential address|state broadcast|verified (fact|report)|breaking news|điểm tin chính thức|văn bản chính phủ|con dấu nhà nước)\b/i;

const IMPERSONATION =
  /\b(identical to|looks exactly like|impersonat(e|ing)|deepfake|passes as the real|ảnh hưởng đến người thật)\b/i;
const REAL_ROLE =
  /\b(celebrity|politician|president|prime minister|public official|người nổi tiếng|chính trị gia|tổng thống|thủ tướng)\b/i;

const HARASSMENT =
  /\b(kill yourself|deserve to die|subhuman|genocide|ethnic cleansing|tự tử đi|đồ .* súc vật)\b/i;

const SEXUAL_EXPLICIT = /\b(explicit sex|pornograph|nude intercourse|hiện cảnh quan hệ tình dục)\b/i;

const GRAPHIC_VIOLENCE = /\b(graphic gore|dismember|torture (for pleasure)|máu me chi tiết|phân xác)\b/i;

const ILLEGAL_HOWTO =
  /\b(how to (make|build|synthesize).{0,40}(bomb|explosive|meth|weapon)|cách chế (bom|ma túy|vũ khí))\b/i;

const LIKENESS_UPLOAD_RISK =
  /\b(real person'?s face|celebrity likeness without permission|ảnh người thật không phép)\b/i;

function hasVietnameseDialogue(prompt: string): boolean {
  const body = String(prompt ?? "");
  if (/[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/.test(body)) {
    return /["'“”‘’][^"'“”‘’\n]{2,}["'“”‘’]/.test(body) || /\bDIALOGUE\s*:/i.test(body);
  }
  return /\bDIALOGUE\s*:/i.test(body) && /["'“”]/.test(body);
}

function hasFictionalFraming(prompt: string): boolean {
  return FICTION_MARKERS.test(prompt) && (NO_NEWS_MARKERS.test(prompt) || /comedy sketch/i.test(prompt));
}

/** V3 = V2 audio blocks + recommended fictional framing (V2 still accepted; validation may warn). */
export function isPromptFormatV3(prompt: string): boolean {
  return isPromptFormatV2(prompt) && hasFictionalFraming(prompt) && promptHasNoSubtitlesClause(prompt);
}

export function policyStatusLabel(status: PolicyValidationStatus): string {
  if (status === "block") return "POLICY BLOCK";
  if (status === "warn") return "POLICY WARN";
  return "POLICY OK";
}

function finding(code: string, severity: PolicySeverity, message: string, policyRef?: string): PolicyFinding {
  return { code, severity, message, policyRef };
}

function aggregateStatus(findings: PolicyFinding[]): PolicyValidationStatus {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

/** Context-aware review before sending a scene to Flow. Does not rewrite the prompt. */
export function validateScenePolicy(prompt: string, sceneNumber = 0): ScenePolicyValidation {
  const text = String(prompt ?? "");
  const findings: PolicyFinding[] = [];
  const v2 = isPromptFormatV2(text);
  const v3 = isPromptFormatV3(text);
  const format: ScenePolicyValidation["format"] = v3 ? "v3" : v2 ? "v2" : "legacy";
  const num = sceneNumber || 0;

  if (hasVietnameseDialogue(text)) {
    if (!v2) {
      findings.push(
        finding(
          "vietnamese_audio_format",
          "warn",
          "Vietnamese dialogue detected but LANGUAGE AND AUDIO / AUDIO blocks are missing. Use Prompt Format V3.",
          "Audio / language instructions",
        ),
      );
    } else {
      if (!/all spoken dialogue must be in vietnamese/i.test(text)) {
        findings.push(
          finding(
            "vietnamese_audio_format",
            "warn",
            "Add: “All spoken dialogue must be in Vietnamese.”",
            "Audio / language instructions",
          ),
        );
      }
      if (!/no english speech/i.test(text)) {
        findings.push(
          finding(
            "vietnamese_audio_format",
            "info",
            "Consider adding “No English speech / No English narration.”",
            "Audio / language instructions",
          ),
        );
      }
      if (!promptHasDialogueDensityBlock(text)) {
        findings.push(
          finding(
            "dialogue_density",
            "info",
            "Add DIALOGUE DENSITY / 80%+ spoken timeline (Copy format V3) so clips stay dialogue-heavy.",
            "Audio pacing",
          ),
        );
      }
    }
  }

  if (!promptHasNoSubtitlesClause(text)) {
    findings.push(
      finding(
        "on_screen_text",
        "warn",
        'End with: "No subtitles, no captions, no text on screen."',
        "Synthetic media / misleading presentation",
      ),
    );
  } else if (!promptHasVisualTextRestrictionBlock(text)) {
    findings.push(
      finding(
        "visual_text_restriction",
        "info",
        'Add the VISUAL TEXT RESTRICTION block (ABSOLUTELY NO TEXT ON SCREEN) from Prompt Format V3 — Create scene adds it automatically at generation.',
        "Synthetic media / on-screen text",
      ),
    );
  }

  const fictionOk = hasFictionalFraming(text);
  if (POLICY_TOPIC.test(text) && !fictionOk) {
    findings.push(
      finding(
        "fictional_context",
        "warn",
        "This looks like social-policy satire but lacks clear fictional framing. Add lines such as “Clearly fictional comedy sketch” and “This is a fictional alternate-universe scenario.”",
        "Misleading content",
      ),
    );
  }

  if (flowNewsRiskInPrompt(text) && !fictionOk) {
    findings.push(
      finding(
        "misleading_news",
        "block",
        "News-style wording without clear fictional comedy framing. Reframe as a staged satire — not a broadcast or documentary.",
        "Misleading content",
      ),
    );
  }

  if (OFFICIAL_DECEPTIVE.test(text) && !fictionOk) {
    findings.push(
      finding(
        "fake_official",
        "block",
        "Language suggests a real official announcement or document. Keep the premise humorous but mark it imaginary; avoid seals, decrees, or “verified” claims.",
        "Deceptive practices",
      ),
    );
  }

  if (IMPERSONATION.test(text) && REAL_ROLE.test(text) && !fictionOk) {
    findings.push(
      finding(
        "deceptive_impersonation",
        "block",
        "Impersonation of a recognizable real role or public figure. Use fictional characters and @character references only.",
        "Impersonation / likeness",
      ),
    );
  }

  if (LIKENESS_UPLOAD_RISK.test(text)) {
    findings.push(
      finding(
        "unauthorized_likeness",
        "warn",
        "Prompt mentions a real person’s likeness. Use only characters you are allowed to reference.",
        "Privacy / likeness",
      ),
    );
  }

  if (HARASSMENT.test(text)) {
    findings.push(
      finding("harassment", "block", "Harassment or hateful content is not allowed.", "Harassment & hate"),
    );
  }
  if (SEXUAL_EXPLICIT.test(text)) {
    findings.push(finding("sexual", "block", "Explicit sexual content is not allowed.", "Sexual content"));
  }
  if (GRAPHIC_VIOLENCE.test(text)) {
    findings.push(finding("violence", "block", "Graphic violence is not allowed.", "Dangerous / violent content"));
  }
  if (ILLEGAL_HOWTO.test(text)) {
    findings.push(finding("illegal", "block", "Harmful or illegal instructions are not allowed.", "Illegal activities"));
  }

  if (/@\w+/.test(text) && /(celebrity|taylor swift|elon musk|donald trump|nguyễn phú trọng)/i.test(text)) {
    findings.push(
      finding(
        "character_reference",
        "warn",
        "Named public figures in prompts can trigger policy filters. Prefer @Character references you created in Flow.",
        "Likeness",
      ),
    );
  }

  if (v2 && !fictionOk) {
    findings.push(
      finding(
        "v3_framing",
        "info",
        "Prompt Format V2 detected. Adding V3 fictional framing may reduce policy refusals.",
        "Misleading content",
      ),
    );
  }

  return {
    sceneNumber: num,
    status: aggregateStatus(findings),
    format,
    findings,
  };
}

export function validateFilmScript(
  scenes: { number?: number; prompt: string }[],
): FilmPolicySummary {
  const out = scenes.map((s, i) => validateScenePolicy(s.prompt, s.number ?? i + 1));
  return {
    pass: out.filter((s) => s.status === "pass").length,
    warn: out.filter((s) => s.status === "warn").length,
    block: out.filter((s) => s.status === "block").length,
    scenes: out,
  };
}