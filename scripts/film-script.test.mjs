import assert from "node:assert/strict";
import {
  parseFilmScript,
  shotCost,
  sceneCharacters,
  sceneAction,
  queueGate,
  overBudget,
  moveItem,
  listedAssetKind,
  assetKindLabel,
  voiceStatus,
  normalizeLookEntry,
  mergePickerRows,
  sceneReferenceSlots,
  promptPreview,
  statusBadge,
  dropFilmVoice,
  tableWindow,
  sortClipsForMerge,
  mergePlayOrderKey,
  hookFromFilmScript,
  extractFirstVietnameseSentence,
  isPromptFormatV2,
  isPromptFormatV3,
  promptHasNoSubtitlesClause,
  promptHasVisualTextRestrictionBlock,
  promptHasFullNoTextPolicy,
  ensurePromptVisualTextRestriction,
  validateScenePolicy,
  validateFilmScript,
  policyStatusLabel,
} from "../dist/film-script.js";

const scriptOf = (n, line) => Array.from({ length: n }, (_, i) => {
  const number = String(i + 1).padStart(3, "0");
  return `=== SCENE ${number} ===\n${line(i, number)}`;
}).join("\n\n");

function check(n) {
  const line = (i) => `Cảnh ${i + 1}. Teddy nói: "Đây là đâu? Chuyện gì đang xảy ra vậy?"`;
  const parsed = parseFilmScript(scriptOf(n, line));
  assert.equal(parsed.scenes.length, n, `${n} scenes`);
  assert.equal(parsed.scenes[0].prompt, line(0));
  assert.equal(parsed.scenes[n - 1].number, n);
  assert.equal(parsed.scenes[n - 1].prompt, line(n - 1));
  const again = parseFilmScript(parsed.scenes.map((s) => `${s.header}\n${s.prompt}`).join("\n"));
  assert.equal(again.scenes[0].prompt, parsed.scenes[0].prompt);
}

check(5);
check(100);
check(500);

const long = "à".repeat(20000) + "\nđây là một câu rất dài, không được cắt.";
const longParsed = parseFilmScript(`=== SCENE 001 ===\n${long}\n=== SCENE 002 ===\nTiếp.`);
assert.equal(longParsed.scenes[0].prompt, long);
assert.equal(longParsed.scenes[1].prompt, "Tiếp.");

const mixed = parseFilmScript([
  "Ghi chú phía trước, giữ lại.",
  "=== SCENE 001 ===",
  "A cinematic shot.",
  'Teddy says in Vietnamese:',
  '"Đây là đâu?"',
  "SCENE 001:",
  "Bản thứ hai, cùng số.",
  "[SCENE 2]",
  "Cổng sáng mở ra.",
  "Scene 3:",
  "Kết.",
].join("\n"));
assert.equal(mixed.scenes.length, 4);
assert.deepEqual(mixed.scenes.map((s) => s.number), [1, 1, 2, 3]);
assert.equal(mixed.scenes[0].prompt, 'A cinematic shot.\nTeddy says in Vietnamese:\n"Đây là đâu?"');
assert.ok(mixed.warnings.some((w) => w.includes("Scene number 1")));
assert.ok(mixed.warnings.some((w) => w.includes("before the first")));
assert.equal(mixed.preamble, "Ghi chú phía trước, giữ lại.");

const vnHeader = parseFilmScript("CẢNH 7\nMột người.\n");
assert.equal(vnHeader.scenes.length, 1);
assert.equal(vnHeader.scenes[0].number, 7);
assert.equal(vnHeader.scenes[0].prompt, "Một người.");

const none = parseFilmScript("Một đoạn văn.\n\nKhông có tiêu đề cảnh.");
assert.equal(none.scenes.length, 0);
assert.ok(none.warnings[0].includes("No scene headers"));

const empty = parseFilmScript("=== SCENE 004 ===\n\n=== SCENE 005 ===\nCó hình.");
assert.equal(empty.scenes.length, 2);
assert.equal(empty.scenes[0].prompt, "");
assert.ok(empty.warnings.some((w) => w.includes("empty prompt")));

assert.equal(shotCost("Omni 1.1 Flash", "720p", 8, 1), 12);
assert.equal(shotCost("Omni 1.1 Flash", "360p", 4, 2), 8);
assert.equal(shotCost("Veo 3.1 - Lite", "720p", 8, 1), 10);
assert.equal(shotCost("Veo 3.1 - Quality", "360p", 4, 1), 100);
assert.equal(shotCost("Omni 1.1 Flash", "720p", 7, 1), null);

const cast = { applyMain: true, main: "Teddy", support: "Mèo" };
assert.deepEqual(sceneCharacters(cast, { override: "", useMain: true, support: "" }), ["Teddy", "Mèo"]);
assert.deepEqual(sceneCharacters(cast, { override: "none", useMain: true, support: "Cổng" }), ["Mèo", "Cổng"]);
assert.deepEqual(sceneCharacters(cast, { override: "Mai", useMain: true, support: "" }), ["Mai", "Mèo"]);
assert.deepEqual(sceneCharacters({ applyMain: false, main: "Teddy", support: "" }, { override: "", useMain: true, support: "" }), []);

const budget = { spent: 24, next: 12, budget: 30 };
assert.equal(overBudget(24, 12, 30), true);
assert.equal(sceneAction({ selected: true, status: "pending", prompt: "x", jobId: "" }, budget), "over-budget");
assert.equal(sceneAction({ selected: true, status: "completed", prompt: "x", jobId: "j" }, { spent: 0, next: 12, budget: 12 }), "skip");
assert.equal(sceneAction({ selected: true, status: "generating", prompt: "x", jobId: "j1" }, { spent: 0, next: 12, budget: 100 }), "poll");
assert.equal(sceneAction({ selected: true, status: "waiting_flow", prompt: "x", jobId: "j1" }, { spent: 0, next: 12, budget: 100 }), "poll");
assert.equal(sceneAction({ selected: true, status: "generating", prompt: "x", jobId: "" }, { spent: 0, next: 12, budget: 100 }), "blocked");
assert.equal(sceneAction({ selected: true, status: "pending", prompt: "   ", jobId: "" }, { spent: 0, next: 12, budget: 100 }), "empty");
assert.equal(sceneAction({ selected: true, status: "pending", prompt: "đi", jobId: "" }, { spent: 0, next: 12, budget: 12 }), "submit");

assert.equal(queueGate(true, false), "wait");
assert.equal(queueGate(true, true), "stop");
assert.equal(queueGate(false, false), "go");

const rows = [{ n: 1, prompt: "một" }, { n: 2, prompt: "hai" }, { n: 3, prompt: "ba" }];
assert.equal(moveItem(rows, 2, -1), 1);
assert.deepEqual(rows.map((r) => r.n), [1, 3, 2]);
rows[1].prompt = "đã sửa, không đổi hàng khác";
assert.equal(rows[0].prompt, "một");
assert.equal(rows[2].prompt, "hai");

const body = (i) => `Cảnh ${i}: Teddy đi qua phố.`;
const saved = JSON.parse(JSON.stringify({ script: scriptOf(500, body), scenes: parseFilmScript(scriptOf(500, body)).scenes }));
assert.equal(saved.scenes.length, 500);
assert.ok(saved.script.includes("Cảnh 499: Teddy"));
assert.equal(saved.scenes[499].prompt, body(499));

assert.equal(listedAssetKind({ name: "Teddy Ngo", kind: "image", assetType: "image", source: "grid" }), "image");
assert.equal(assetKindLabel(listedAssetKind({ source: "character", kind: "character" })), "CHARACTER");
assert.equal(listedAssetKind({ kind: "poster" }), "unknown");
assert.equal(voiceStatus({ kind: "character", voice: "Aoede" }), "Voice: Aoede");
assert.equal(voiceStatus({ kind: "character", voice: null }), "No voice assigned");
assert.equal(voiceStatus({ kind: "image", name: "Teddy Ngo", voice: "Aoede" }), null);
assert.deepEqual(normalizeLookEntry("navy coat"), { look: "navy coat" });
assert.deepEqual(normalizeLookEntry({ look: "navy coat", voice: "Aoede" }), { look: "navy coat", voice: "Aoede" });

const merged = mergePickerRows(
  [{ name: "Teddy Ngo", voice: "Aoede" }],
  [{ name: "Teddy Ngo", kind: "image", assetId: "0fd5cbd1-ae75-4ab6-b63d-ec22f5fbb037" }, { name: "City Background", kind: "image" }],
);
assert.equal(merged[0].source, "character");
assert.equal(merged[0].voice, "Aoede");
assert.equal(listedAssetKind(merged[1]), "image");
assert.equal(merged[1].name, "Teddy Ngo");

const shared = [{ asset: "Teddy Ngo", assetName: "Teddy Ngo", assetType: "character", voice: "Aoede" }, { assetId: "abc", assetName: "City", assetType: "image" }];
assert.equal(sceneReferenceSlots(shared, { refMode: "film" }).length, 2);
assert.equal(sceneReferenceSlots(shared, { refMode: "none" }).length, 0);
assert.equal(sceneReferenceSlots(shared, { refMode: "film" }, false).length, 0);
assert.equal(sceneReferenceSlots(shared, { refMode: "custom", refs: [shared[1], shared[1], shared[1], shared[1]] }).length, 3);
assert.deepEqual(sceneReferenceSlots(shared, { refMode: "custom", refs: [shared[1], shared[0]] }).map((r) => r.assetName), ["City", "Teddy Ngo"]);

assert.equal(promptPreview("one line"), "one line");
assert.equal(promptPreview("first\nsecond\nthird"), "first\nsecond...");
assert.ok(promptPreview("x".repeat(200)).endsWith("..."));
assert.equal(promptPreview("x".repeat(200)).length, 163);
for (const status of ["pending", "generating", "completed", "failed", "skipped", "download_failed"]) assert.equal(statusBadge(status), status.toUpperCase());
assert.equal(assetKindLabel(listedAssetKind({ assetType: "product" })), "PRODUCT");
assert.equal(listedAssetKind({ name: "Teddy Ngo", kind: "image" }), "image");

const oldProject = dropFilmVoice({
  project: "OldVoice",
  voice: { keepAudio: true, language: "Vietnamese", style: "soft", note: "saved voice" },
  scenes: [{ number: 1, prompt: "Hello\nthere\nmore", status: "pending" }],
});
assert.equal(oldProject.voice, undefined);
assert.equal(oldProject.scenes[0].prompt, "Hello\nthere\nmore");
assert.equal(oldProject.project, "OldVoice");

for (const total of [2, 100, 500]) {
  const win = tableWindow(total, 0, 56, 440);
  assert.equal(win.start, 0);
  assert.ok(win.end <= total);
  assert.ok(win.end - win.start < 30, `${total} scenes painted ${win.end - win.start} rows`);
}
const mid = tableWindow(500, 56 * 250, 56, 440);
assert.ok(mid.start > 200 && mid.end < 280);
assert.ok(mid.end - mid.start < 30);

const scenes = [
  { id: "a", prompt: "Alpha\nline\nextra", selected: true, status: "pending", jobId: "", error: "" },
  { id: "b", prompt: "Beta", selected: true, status: "failed", jobId: "", error: "busy" },
];
scenes.forEach((s) => (s.selected = true));
assert.ok(scenes.every((s) => s.selected));
scenes.forEach((s) => (s.selected = false));
assert.ok(scenes.every((s) => !s.selected));
scenes[0].selected = true;
const draft = scenes[0].prompt;
assert.equal(draft, "Alpha\nline\nextra");
scenes[0].prompt = "Alpha\nline\nextra saved";
assert.notEqual(scenes[0].prompt, "Alpha\nline");
const copy = { ...scenes[0], id: "c", status: "pending", error: "", prompt: scenes[0].prompt };
scenes.splice(1, 0, copy);
assert.equal(scenes[1].id, "c");
assert.equal(scenes[1].prompt, scenes[0].prompt);
scenes.splice(1, 1);
assert.deepEqual(scenes.map((s) => s.id), ["a", "b"]);
moveItem(scenes, 1, -1);
assert.deepEqual(scenes.map((s) => s.id), ["b", "a"]);
const per = shotCost("Omni 1.1 Flash", "720p", 8, 1);
assert.equal(per, 12);
const gate = { spent: 0, next: per, budget: 300 };
assert.equal(sceneAction(scenes[1], gate), "submit");
scenes[1].status = "generating";
assert.equal(statusBadge(scenes[1].status), "GENERATING");
assert.equal(sceneAction(scenes[1], gate), "blocked");
scenes[1].status = "completed";
scenes[1].actualCredits = per;
assert.equal(sceneAction(scenes[1], gate), "skip");
assert.equal(statusBadge(scenes[1].status), "COMPLETED");
scenes[0].status = "failed";
assert.equal(statusBadge(scenes[0].status), "FAILED");

const outOfOrder = [
  { stem: "scene-03", flow_title: "3" },
  { stem: "scene-04", flow_title: "4" },
  { stem: "scene-01", flow_title: "1" },
  { stem: "scene-02", flow_title: "2" },
];
const ordered = sortClipsForMerge(outOfOrder).map((c) => c.flow_title);
assert.deepEqual(ordered, ["1", "2", "3", "4"]);
assert.equal(mergePlayOrderKey({ flow_title: "12" }, 0), 12);
assert.equal(mergePlayOrderKey({ flow_title: "0001-3" }, 0), 3);
assert.equal(mergePlayOrderKey({ stem: "scene-08" }, 7), 8);

const hookScript = [
  "=== SCENE 001 ===",
  "ENGLISH PROMPT ONLY.",
  'FRIEND: "Ly hôn xong là mất luôn 1 tỷ đó nha!"',
  'TEDDY: "HẢ?! Một tỷ?!"',
  "=== SCENE 002 ===",
  '"Câu thứ hai."',
].join("\n");
assert.equal(hookFromFilmScript(hookScript), "Ly hôn xong là mất luôn 1 tỷ đó nha!");
assert.equal(
  extractFirstVietnameseSentence('AUDIO\nTEDDY: HẢ?! Một tỷ?!'),
  "HẢ?! Một tỷ?!",
);

const V2_SCENE = `=== SCENE 001 ===

Create a photorealistic cinematic comedy video.
Vertical 9:16. EXACTLY 6 SECONDS.

LANGUAGE AND AUDIO:
All spoken dialogue must be in Vietnamese.
Natural Southern Vietnamese accent.

DIALOGUE:

@Teddy Ngo says:
"Nếu Việt Nam bắt buộc công khai lương thì sao?"

AUDIO:
Natural Vietnamese speech only.

No subtitles, no captions, no text on screen.`;

const v2One = parseFilmScript(V2_SCENE);
assert.equal(v2One.scenes.length, 1);
assert.equal(v2One.scenes[0].number, 1);
assert.ok(isPromptFormatV2(v2One.scenes[0].prompt));
assert.ok(promptHasNoSubtitlesClause(v2One.scenes[0].prompt));
const v2OneEnsured = ensurePromptVisualTextRestriction(v2One.scenes[0].prompt);
assert.ok(promptHasVisualTextRestrictionBlock(v2OneEnsured));
assert.ok(promptHasFullNoTextPolicy(v2OneEnsured));
assert.equal(ensurePromptVisualTextRestriction(v2OneEnsured), v2OneEnsured);
assert.ok(v2One.scenes[0].prompt.includes("Nếu Việt Nam bắt buộc công khai lương thì sao?"));
assert.ok(v2One.scenes[0].prompt.includes("@Teddy Ngo"));
assert.ok(!v2One.scenes[0].prompt.includes("=== SCENE"));

const v2Five = parseFilmScript(
  [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `=== SCENE ${String(n).padStart(3, "0")} ===\nLANGUAGE AND AUDIO:\nVietnamese only.\nAUDIO:\nClear.\n"No ${n}."`,
    )
    .join("\n\n"),
);
assert.equal(v2Five.scenes.length, 5);
for (const s of v2Five.scenes) assert.ok(isPromptFormatV2(s.prompt));

const legacy = parseFilmScript(`=== SCENE 001 ===\nOLD FORMAT FACE LOCK prompt.\n"Teddy nói tiếng Việt."`);
assert.ok(!isPromptFormatV2(legacy.scenes[0].prompt));

const V3_FICTION =
  ensurePromptVisualTextRestriction(V2_SCENE) +
  "\n\nClearly fictional comedy sketch.\nNo news broadcast or documentary presentation.\nThis is a fictional alternate-universe social comedy scenario.";
const v3 = parseFilmScript(V3_FICTION);
assert.ok(isPromptFormatV3(v3.scenes[0].prompt));
assert.ok(promptHasVisualTextRestrictionBlock(v3.scenes[0].prompt));
const okPolicy = validateScenePolicy(v3.scenes[0].prompt, 1);
assert.equal(okPolicy.status, "pass");

const satireNoFiction = validateScenePolicy(
  `=== SCENE 001 ===\nLANGUAGE AND AUDIO:\nVietnamese.\nAUDIO:\nClear.\n"DIALOGUE"\n"Nếu Việt Nam bắt buộc công khai lương thì sao?"\nNo subtitles, no captions, no text on screen.`,
  1,
);
assert.equal(satireNoFiction.status, "warn");
assert.ok(satireNoFiction.findings.some((f) => f.code === "fictional_context"));

const newsBlock = validateScenePolicy(
  `BREAKING NEWS: the government announced a new law.\nNo subtitles, no captions, no text on screen.`,
  1,
);
assert.equal(newsBlock.status, "block");

const batch = validateFilmScript([
  { number: 1, prompt: v3.scenes[0].prompt },
  { number: 2, prompt: "BREAKING NEWS: verified government announcement today. No subtitles, no captions, no text on screen." },
]);
assert.equal(batch.pass, 1);
assert.equal(batch.block, 1);

assert.equal(policyStatusLabel("block"), "POLICY BLOCK");

console.log("film-script tests passed");
