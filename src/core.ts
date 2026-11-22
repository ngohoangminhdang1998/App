import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, voiceTrack } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_MB, KOKORO_VOICES, kokoroReady, speakWithKokoro } from "./kokoro.js";
import { extractFirstFrame, extractFrameAt, extractLastFrame } from "./chain.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { presenter } from "./presenter.js";
import { repairProjectDownloads } from "./media-download.js";
import {
  cacheIsValid,
  compositionKey,
  contentHashFromTitles,
  getComposition,
  getCompositionByFlowId,
  loadCompositions,
  saveComposition,
  type FlowCompositionRecord,
} from "./flow-composition.js";
import { PUBLISH_STAGING_DIR } from "./chrome.js";
import {
  characterLook,
  characterRecord,
  createCharacter,
  createProject,
  downloadAsset,
  downloadCollection,
  downloadFlowComposition,
  trashAsset,
  editCharacter,
  getFlowState,
  listAssets,
  forgetCharacter,
  listCharacters,
  rememberCharacter,
  assetPublishHandle,
  downloadFlowAssetForPublish,
  listFlowProjectVideos,
  listFlowProjects,
  mergeClipsIntoFlowScene,
  openFlowProject,
  runAgentBatch,
  runContinue,
  runEdit,
  runGeneration,
} from "./flow.js";
import { buildPublishHistory, prunePublishHistoryStores, PUBLISH_HISTORY_KEEP } from "./publish-history.js";
import { guessDefaultVideo, listPublishableVideos, publishManager, summarizeClipPublish } from "./publish.js";
import { normalizeHashtags } from "./publish-text.js";
import { JobQueue, type Job } from "./queue.js";
import { dispatchGenerationJob } from "./providers/dispatch-job.js";
import { isMuseProvider } from "./providers/active.js";
import { writeProviderConfig } from "./providers/platform-config.js";
import { providerPayload } from "./providers/registry.js";
import { BIN, COMPUTER, moveToBin } from "./platform.js";
import { cleanMediaRef, cleanMediaRefs, describeJobAssets as formatJobAssets, encodeFlowRef, isLocalClip } from "./media-ref.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

/** AUTO FILM may store a basename, a stale path, or a path under another output root — always prefer the project folder. */
export function resolveClipPaths(dir: string, clips: string[]): string[] {
  return clips.map((c) => {
    const raw = c.trim();
    if (!raw) throw new Error("Empty clip path in merge list.");
    if (isAbsolute(raw) && existsSync(raw)) return resolve(raw);
    const byName = join(dir, basename(raw));
    if (existsSync(byName)) return byName;
    const stem = basename(raw, extname(raw)) || raw.replace(/\.[^.]+$/, "");
    const numbered = join(dir, stem.endsWith(".mp4") ? stem : `${stem}.mp4`);
    if (existsSync(numbered)) return numbered;
    if (existsSync(raw)) return resolve(raw);
    throw new Error(`Clip not found: "${raw}" (looked in ${dir})`);
  });
}

export { cleanMediaRef, cleanMediaRefs, mediaRefLabel } from "./media-ref.js";

export function describeJobAssets(p: {
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  attach?: string[];
  continue_from?: string;
  edit_asset?: string;
}): string {
  return formatJobAssets(p);
}

const flowPickSchema = z.object({
  assetId: z.string().min(1),
  assetName: z.string().min(1),
  projectId: z.string().min(1).optional(),
  assetType: z.enum(["image", "video", "scene", "character"]).optional(),
});
const mediaRefSchema = z.union([z.string().min(1), flowPickSchema]);

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: mediaRefSchema
    .optional()
    .describe("First frame: absolute image path, 'asset:<title>' for an image already in the Flow project, {assetId, assetName, projectId, assetType} for a From Flow pick (matched by data-media-id, not the filename), or the absolute path of a finished clip (.mp4) to start exactly on its last frame."),
  first_frame_at: z
    .number()
    .min(0)
    .optional()
    .describe("When first_frame is a clip: start from the frame at this second instead of its last frame, e.g. right where the speech ends, so dead time at the end of a take is skipped. Cut that clip at the same second in flow_assemble's `trims` and the join stays invisible."),
  last_frame: mediaRefSchema
    .optional()
    .describe("Last frame: absolute image path, 'asset:<title>', a From Flow pick {assetId, assetName, projectId, assetType}, or the absolute path of a finished clip (.mp4) to end exactly where that clip begins."),
  reference_images: z
    .array(mediaRefSchema)
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, 'asset:<title>' (legacy filename), or {assetId, assetName, projectId, assetType} for a From Flow pick. Ids are matched on the project grid; the filename is only the label. Flow's COMPOSER takes references OR first/last frames on a video scene, never both.",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  skip_download: z
    .boolean()
    .optional()
    .describe("When true, generation finishes in Flow only: the tile is renamed for merge but nothing is saved locally. TedVerse Auto Film sets this."),
  flow_title: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Title on the Flow grid after generation (e.g. 1, 2, 3). Auto Film sends the scene number."),
  file_stem: z
    .string()
    .min(1)
    .optional()
    .describe("Local file stem when downloaded; default is sequential scene-NN in the project folder."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  on_screen_text: z
    .boolean()
    .optional()
    .describe("Video only: true when words SHOULD appear in the picture (a sign, a title card). By default every video prompt forbids subtitles and on-screen text, because Omni otherwise burns in its own garbled captions."),
  outfit: z
    .string()
    .max(300)
    .optional()
    .describe("What a referenced character wears in this scene when it differs from their saved look, e.g. 'a plain cream crewneck sweatshirt'. The character lock then keeps face, hair and build but takes the clothes from here."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  words: z
    .array(z.object({ text: z.string().min(1), start: z.number().min(0), end: z.number().min(0) }))
    .max(5000)
    .optional()
    .describe("Word timings to use instead of hearing the whole video, e.g. from flow_transcribe on each clip of a joined film, shifted by where each clip starts in it. Use it when the film's own sound (music, a train, crowd) throws the timing off. text still corrects the words on top."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).max(30).default([]).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
    collection: z
      .string()
      .min(1)
      .optional()
      .describe("Name of a Flow collection: every image in it comes down in ONE ZIP (originals), each under its own title. Use it to fetch a batch whose download stopped."),
  },
  repair_downloads: {
    project: z.string().min(1).describe("Local project folder under the output root."),
  },
  redownload: {
    project: z.string().min(1),
    file_stem: z.string().min(1).describe("Stem without extension, e.g. scene-01 — saved as <project>-scene-01 in Flow."),
    quality: z.enum(["original", "upscaled"]).default("original"),
    force: z.boolean().default(false).describe("Replace a valid video already on disk."),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    end_hold: z.object({ seconds: z.number().min(0).max(10), fade: z.number().min(0).max(10).optional() }).optional().describe("Hold the last frame this many seconds at the end, fading to black over its last `fade` seconds."),
    music_curve: z.array(z.object({ at: z.number().min(0), volume: z.number().min(0).max(2) })).optional().describe("Music level over the film on top of music_volume: {at: seconds, volume}, straight lines between points. Fade in, drop for a quiet moment, rise for the ending."),
    duck_music: z.boolean().optional().describe("Pull the music down automatically while the voiceover speaks, and let it back up in the gaps."),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several Flow takes in your avatar's voice, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
    trims: z
      .array(
        z
          .object({
            from: z.number().min(0).optional(),
            to: z.number().min(0).optional(),
            volume: z.number().min(0).max(2).optional().describe("This clip's own sound level, 1 = as made. Lower a take whose background noise is louder than the clip before it, so the room does not jump at the cut."),
            fade_in: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound in (trimmed edges always get 0.015 s so a cut never clicks)."),
            fade_out: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound out."),
            soften_in: z.number().min(0).max(3).optional().describe("For a clip that continues the one before from its last frame: if it starts noticeably sharper than that clip ends (a visible 'skip' at the join), it opens equally soft and sharpens over this many seconds (1 is good). Measured automatically; does nothing when the two already match."),
            saturation: z.number().min(0.5).max(2).optional().describe("Scales this clip's colour (1 = as is). For a clip animated from the last frame of the one before, which can come back paler, so the join shows: measure both sides and match."),
            crop: z
              .object({
                x: z.number().min(0).max(1).optional().describe("Left edge, as a fraction of the width. Default: centred."),
                y: z.number().min(0).max(1).optional().describe("Top edge, as a fraction of the height. Default: centred."),
                w: z.number().min(0.1).max(1).describe("Width kept, as a fraction (0.8 = a 1.25x punch-in)."),
                h: z.number().min(0.1).max(1).optional().describe("Height kept; defaults to w, which keeps the frame's shape."),
              })
              .optional()
              .describe("Punch in on part of this clip, e.g. {x: 0, y: 0, w: 0.78} drops the bottom and right edges to hide something the model put in a corner."),
          })
          .nullable(),
      )
      .optional()
      .describe("One entry per clip, in play order: the seconds of that clip to keep, e.g. [{from: 0.6}, null, {to: 8.4}] cuts a dead start off clip 1 and an awkward pause off the end of clip 3 (null keeps a clip whole). The same clip may be listed twice with two windows to cut a repeated or fluffed line out of its middle. Use flow_transcribe's word times to find the cut points, and never cut inside a stray sound at the start of a take."),
    end_card: z
      .object({
        text: z.string().min(1).max(120).describe("The words, e.g. 'Link in bio' or 'Desk lamp · link below'. A line break starts a new line."),
        seconds: z.number().min(1).max(10).optional().describe("How long it shows. Default 2.5."),
      })
      .optional()
      .describe("A closing card: big centred words over the film's own last frame, blurred and darkened. Free, made on this computer."),
    inserts: z
      .array(
        z.object({
          clip: z.string().min(1).describe("Absolute path of the cutaway clip, e.g. a product close-up."),
          over: z.number().int().min(1).describe("Which clip it covers, counting from 1 in play order."),
          at: z.number().min(0).describe("Where it starts, in seconds into that clip's kept part (after its trim)."),
          seconds: z.number().min(0.2).optional().describe("How long it shows. Default: as long as the cutaway lasts, or to the end of the covered clip."),
          from: z.number().min(0).optional().describe("Start inside the cutaway clip. Default 0."),
          volume: z.number().min(0).max(1).optional().describe("The cutaway's own sound under the covered clip's sound. Default 0.3."),
          crop: z
            .object({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), w: z.number().min(0.1).max(1), h: z.number().min(0.1).max(1).optional() })
            .optional()
            .describe("Crop the cutaway like a clip's `trims` crop (fractions), e.g. to take a vertical picture out of a 16:9 export."),
        }),
      )
      .optional()
      .describe("B-roll cutaways: show another clip's picture over part of a clip while that clip's own sound keeps playing - the person keeps talking over the product shot and the picture cuts back to them mid-take, in sync and at the same loudness. Better than voice_lines when the line comes from one of the film's own clips."),
    size: z
      .string()
      .regex(/^\d{2,4}x\d{2,4}$/)
      .optional()
      .describe("Film size as WIDTHxHEIGHT, e.g. '1080x1920' for a phone-ready vertical master. Default: the biggest clip, after any crop."),
    loudness: z
      .number()
      .min(-30)
      .max(-9)
      .optional()
      .describe("Level the finished film's sound to this loudness in LUFS. Flow's takes come out near -24, which is quiet on a phone; social video sits around -14."),
    remove_watermark: z
      .boolean()
      .optional()
      .describe("Paint out the sparkle mark Google's video models put in the bottom-right corner, found automatically and filled from the pixels around it (no crop). The invisible SynthID mark stays, and platforms still expect an AI-content label."),
    watermark_margin: z.number().min(0).max(40).optional().describe("With remove_watermark: grow the mask by this many pixels and make it a diamond. Use about 10 after a long Extend chain, where the mark has been redrawn thicker. Look at the corner afterwards."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  presenter: {
    project: z.string().min(1).describe("Films folder to save into."),
    presenter: z.string().min(1).describe("Absolute path of the talking recording (an avatar video, say). Its sound plays throughout."),
    segments: z
      .array(
        z.object({
          from: z.number().min(0).describe("Start in the recording, in seconds."),
          to: z.number().min(0).describe("End in the recording, in seconds."),
          layout: z.enum(["full", "corner"]).describe("full: the presenter fills the frame. corner: a circle in the corner over `background`."),
          zoom: z
            .object({ from: z.number().min(1).max(3).optional(), to: z.number().min(1).max(3).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() })
            .optional()
            .describe("Full layout only. A slow move from `from` to `to`, where 1 is the whole frame; x and y are the point to zoom toward, as fractions of the frame (default 0.5, 0.45)."),
          background: z
            .object({
              clip: z.string().min(1),
              from: z.number().min(0).optional(),
              retime: z.array(z.object({ from: z.number().min(0), to: z.number().min(0), speed: z.number().min(0.1).max(8) })).optional().describe("Parts of the clip to play faster or slower, so its action lands on the presenter's words. Times are in the original clip; `from` above is measured after this."),
            })
            .optional()
            .describe("Corner layout only: the clip behind the presenter, and where in it to start."),
          shrink: z.number().min(0.1).max(3).optional().describe("Corner layout only: animate from full frame into the circle over this many seconds at the start of the stretch."),
        }),
      )
      .min(1)
      .describe("The film in order. Each stretch is cut in as listed."),
    corner: z
      .object({
        position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional(),
        size: z.number().min(0.15).max(0.7).optional().describe("Circle diameter as a fraction of the frame's height. Default 0.36: readable on a phone."),
        face: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.1).max(1) }).optional().describe("The square of the recording to show in the circle: centre x, centre y, width, as fractions of the recording."),
        margin: z.number().min(0).max(0.2).optional(),
        ring_color: z.string().optional(),
      })
      .optional(),
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional().describe("Film size. Default 1920x1080."),
    output_name: z.string().optional(),
  },
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z
      .array(
        z.object({
          image: z.string().min(1).describe("Absolute image path, or 'asset:<title>' for an image or character already in the Flow project."),
          name: z.string().min(1).max(40).describe("Short name the scenes use for it, e.g. 'Ines' or 'the station'."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "Reference images for the whole batch (characters, places, objects), attached once in the agent's composer like the + button does, so every scene stays on-model. Pair with scene_references to say which scenes use which.",
      ),
    scene_references: z
      .array(z.array(z.string()))
      .optional()
      .describe("One list per scene, in scene order: the reference names that scene uses (empty list for none). Without it the agent decides which references fit each scene."),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["kokoro", "gemini"])
      .default("kokoro")
      .describe(
        "'kokoro' (the default) is Kokoro, a free voice that runs on this computer: no key, no quota, any length; the first take downloads its model once (326 MB). 'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier but with a daily limit, needs a key in ~/.flow-mcp/gemini-key; when that limit is used up the take is recorded with Kokoro instead and the result says so.",
      ),
    text: z.string().min(1).max(3000).describe("The line to speak. About 2.5 words per second: 25 words fit 10 s, 75 words fit 30 s. Record a whole narration in one take."),
    voice: z
      .string()
      .min(1)
      .optional()
      .describe("Voice name from flow_voices for the chosen engine. Defaults: am_michael for Kokoro (try af_heart, af_bella, bf_emma), Charon for Google (Aoede, Gacrux...)."),
    speed: z.number().min(0.5).max(2).optional().describe("Kokoro only: speaking speed, 1 = normal. 0.9 is a calmer narrator pace."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly'. Keep it to a few words: long notes make the model ramble."),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets.") },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
  },
  new_project: {
    title: z.string().max(80).optional().describe("Name for the new project, e.g. 'Desk lamp UGC ad'. Default: Flow's own date-and-time name."),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    look: z
      .string()
      .max(1200)
      .optional()
      .describe("With `image`: the person in the picture in words (face, hair, clothes). Every scene's character lock quotes it word for word, so describe only what the picture shows. Without it, an older description saved under the same name is dropped."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
  publish_options: {
    project: z.string().min(1).describe("Local output folder name (TedVerse slug)."),
    flow_project_id: z
      .string()
      .regex(/^[0-9a-f-]{36}$/i)
      .optional()
      .describe("Google Flow project uuid — list videos from that project's grid."),
    flow_video_id: z
      .string()
      .min(1)
      .optional()
      .describe("Publish handle from the video list (uuid or title:<name>)."),
    download: z.boolean().default(false).describe("When true, download the chosen clip into the project folder."),
  },
  flow_projects: {
    open_id: z
      .string()
      .regex(/^[0-9a-f-]{36}$/i)
      .optional()
      .describe("When set, switch the Flow Chrome window to this project after listing."),
  },
  publish: {
    project: z.string().min(1),
    flow_project_id: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
    flow_video_id: z.string().min(1).optional(),
    flow_video_name: z.string().optional(),
    caption: z.string().optional(),
    video: z.string().optional().describe("Local path on disk after download (optional if flow_video_id is set)."),
    platforms: z.array(z.enum(["tiktok", "youtube", "facebook"])).min(1),
    hashtags: z.string().optional().describe("Optional hashtags; normalized before posting."),
    confirm_uncertain: z.boolean().optional().describe("Retry after an uncertain outcome without republishing successful platforms."),
    mode: z.enum(["now", "schedule"]).default("now").describe("Publish Now or native platform scheduling."),
    schedule_at: z.string().optional().describe("datetime-local or ISO — this PC's local time; platforms use the browser clock."),
  },
  publish_status: {
    project: z.string().min(1),
    video: z.string().optional(),
    flow_project_id: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
    flow_video_id: z.string().min(1).optional(),
  },
  publish_retry: {
    project: z.string().min(1),
    video: z.string().optional(),
    flow_project_id: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
    flow_video_id: z.string().min(1).optional(),
    platforms: z.array(z.enum(["tiktok", "youtube", "facebook"])).optional(),
    confirm_uncertain: z.boolean().optional(),
  },
  publish_history: { limit: z.number().int().min(1).max(500).optional() },
  flow_merge: {
    project: z.string().min(1),
    clips: z
      .array(z.object({ stem: z.string().min(1), flow_title: z.string().optional() }))
      .min(1)
      .describe("Scene stems in play order; flow_title defaults to <project>-<stem> in Flow."),
    force: z.boolean().optional().describe("Rebuild the Flow composition even when the clip list matches a saved merge."),
  },
  flow_composition: { project: z.string().min(1) },
  flow_recover_film_scenes: {
    project: z.string().min(1),
    clips: z.array(z.object({ stem: z.string().min(1), flow_title: z.string().min(1) })).min(1),
  },
  provider_info: {},
  provider_select: {
    provider: z.enum(["google-flow", "muse"]).describe("AI generation platform for this TedVerse session."),
  },
  muse_status: {},
  muse_open_login: { show: z.boolean().default(true).describe("Open a visible Chrome window on muse.ai for manual login.") },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, flow_assets, attempts, credits, progress, note, error, failed_scenes }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  flow_assets,
  note,
  error,
  failed_scenes,
  skip_download: params.skip_download,
  // Exact media the job will attach — surfaces stale Studio slots (e.g. asset:14371.png) in the Monitor.
  assets: {
    first_frame: params.first_frame,
    last_frame: params.last_frame,
    reference_images: params.reference_images,
    chain_from: params.chain_from,
    reference_from: params.reference_from,
    attach: params.attach,
    continue_from: params.continue_from,
    edit_asset: params.edit_asset,
  },
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  repair_downloads(a: Args<"repair_downloads">): Promise<unknown>;
  redownload(a: Args<"redownload">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  new_project(a: Args<"new_project">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  presenter(a: Args<"presenter">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
  publish_options(a: Args<"publish_options">): Promise<unknown>;
  publish(a: Args<"publish">): Promise<unknown>;
  publish_status(a: Args<"publish_status">): Promise<unknown>;
  publish_retry(a: Args<"publish_retry">): Promise<unknown>;
  publish_history(a?: Args<"publish_history">): Promise<unknown>;
  flow_merge(a: Args<"flow_merge">): Promise<unknown>;
  flow_composition(a: Args<"flow_composition">): Promise<unknown>;
  flow_recover_film_scenes(a: Args<"flow_recover_film_scenes">): Promise<unknown>;
  flow_projects(a: Args<"flow_projects">): Promise<unknown>;
  provider_info(a: Args<"provider_info">): Promise<unknown>;
  provider_select(a: Args<"provider_select">): Promise<unknown>;
  muse_status(a: Args<"muse_status">): Promise<unknown>;
  muse_open_login(a: Args<"muse_open_login">): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

function releaseEphemeralFile(path: string) {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  try {
    const parent = dirname(path);
    if (parent.startsWith(PUBLISH_STAGING_DIR) && parent !== PUBLISH_STAGING_DIR) rmSync(parent, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function fetchFlowVideoStaging(flowProjectId: string, handle: string): Promise<string> {
  mkdirSync(PUBLISH_STAGING_DIR, { recursive: true });
  const dir = join(PUBLISH_STAGING_DIR, randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return downloadFlowAssetForPublish(flowProjectId, handle, dir);
}

export class LocalCore implements Core {
  private queue: JobQueue = new JobQueue(async (job) =>
    dispatchGenerationJob(job, this.queue, {
      releaseEphemeralFile,
      fetchFlowVideoStaging,
    }),
  );

  async status({ detailed }: Args<"status">) {
    const jobs = this.queue.list().map(jobView);
    const pacing = this.queue.pausedReason;
    if (isMuseProvider()) {
      const { museStatus } = await import("./providers/muse/muse-driver.js");
      const muse = await museStatus().catch((e) => ({ connected: false, error: (e as Error).message }));
      return {
        active_provider: "muse" as const,
        flow: { signedIn: false, hint: "Google Flow status skipped while Muse is selected." },
        muse,
        provider: providerPayload("muse"),
        pacing,
        output_root: OUTPUT_ROOT,
        jobs,
      };
    }
    const flow = await getFlowState(detailed && !this.queue.busy);
    return { active_provider: "google-flow" as const, flow, pacing, output_root: OUTPUT_ROOT, jobs };
  }

  async generate({ project, scenes }: Args<"generate">) {
    if (isMuseProvider()) {
      const { assertMuseGenerateAllowed } = await import("./providers/muse/validate-generate.js");
      assertMuseGenerateAllowed(scenes);
    }
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    for (const [i, { chain_previous, reference_previous, technique, outfit, on_screen_text, ...scene }] of scenes.entries()) {
      // Only explicitly provided media ride along. Blank strings and empty asset: refs are dropped so a stale Studio
      // localStorage slot cannot force-attach an old Flow upload the user did not pick for this roll.
      const first_frame = cleanMediaRef(scene.first_frame);
      const last_frame = cleanMediaRef(scene.last_frame);
      const reference_images = cleanMediaRefs(scene.reference_images);
      const phrase = technique ? techniqueById(technique)!.phrase : "";
      // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
      // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
      const cast = (reference_images ?? [])
        .filter((r) => r.startsWith("asset:"))
        .map((r) => r.slice(6).trim())
        .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
      // With an outfit the lock still pins face, hair and build, but the clothes come from the scene: otherwise the
      // saved look (Skye's denim shirt) fights a costume the prompt asks for.
      const lock = cast.length
        ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions,${outfit ? "" : " same clothing items in the same colours,"} same hands, and the same rendering style and level of realism as the reference. Never redesign, ${outfit ? "" : "restyle, "}re-proportion, re-age or re-colour them${outfit ? "" : ", and never swap an item for a similar one"}.${cast
            .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
            .join("")}${outfit ? ` WARDROBE IN THIS SCENE: ${outfit.trim().replace(/\.$/, "")}. This replaces any clothing in the reference image or the description above, and stays identical for the whole scene.` : ""}`
        : "";
      // Omni burns its own subtitles into talking clips now and then, garbled ("thyel", "voch"), even when the prompt
      // says "no captions" near the end (protein soda clip 1, 15 credits). Every video therefore opens AND closes on it,
      // unless the scene really wants words in the picture. Captions are added afterwards by flow_captions.
      const noText = scene.type !== "image" && !on_screen_text;
      const textFirst = noText ? "NO SUBTITLES, NO CAPTIONS, NO TEXT OF ANY KIND ON SCREEN. " : "";
      const textLast = noText
        ? " NO TEXT ON SCREEN: never add subtitles, captions, titles, speech transcripts, words or letters anywhere in the picture, at any moment; any speech is heard only, never written."
        : "";
      const inherit = reference_previous
        ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
        : "";
      const params = {
        ...scene,
        first_frame,
        last_frame,
        reference_images,
        skip_download: scene.skip_download ?? scene.type === "video",
        prompt: `${textFirst}${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}${textLast}`,
        chain_from: chain_previous ? jobs[i - 1].id : undefined,
        reference_from: reference_previous ? jobs[i - 1].id : undefined,
        output_dir,
        file_stem: scene.file_stem ?? `scene-${String(offset + i + 1).padStart(2, "0")}`,
        flow_title: scene.flow_title?.trim() || undefined,
      };
      const job = this.queue.add(params);
      const assetsNote = describeJobAssets(params);
      job.note = assetsNote;
      console.error(`[flow-mcp ${job.id}] queued ${params.file_stem}: ${assetsNote}`);
      jobs.push(job);
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.failed_scenes?.length && p?.agent_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Agent batch: ${pick.length} failed image(s) again`,
            agent_scenes: pick.map((i) => p.agent_scenes![i]),
            agent_numbers: pick.map((i) => numbers[i]),
            agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    return { jobs: jobs.map(jobView) };
  }

  async assets({ kind }: Args<"assets">) {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind, id, projectId, thumbnail }) => ({
      name,
      kind,
      assetId: id,
      assetName: name,
      projectId,
      assetType: kind,
      thumbnail,
    }));
  }

  async download({ project, assets, quality, collection }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!assets.length && !collection) throw new Error("Name the assets to download, or a collection.");
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = collection ? await downloadCollection(collection, dir) : [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async repair_downloads({ project }: Args<"repair_downloads">) {
    return repairProjectDownloads(projectDir(project));
  }

  /** Fetches a clip that already exists in Flow — no new generation. */
  async redownload({ project, file_stem, quality, force }: Args<"redownload">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const stem = join(dir, file_stem);
    const asset = `${project.replace(/[^\w.-]+/g, "_")}-${file_stem}`;
    const files = await downloadAsset(asset, stem, quality, { overwrite: force });
    return { dir, files };
  }

  async assemble({ project, voice_lines, clips, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    const resolved = clips?.length ? resolveClipPaths(dir, clips) : clips;
    const body = { dir, ...rest, clips: resolved };
    if (!voice_lines?.length) return assemble(body);
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ ...body, voiceover: track.file });
    return { ...film, voice: track };
  }

  transcribe = transcribeHere;
  caption_preview = captionPreviewHere;
  captions = captionsHere;
  presenter = presenterHere;
  caption_setup = captionSetupHere;

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, download_quality, references, scene_references }: Args<"agent">) {
    const output_dir = projectDir(project);
    if (scene_references && scene_references.length !== scenes.length) {
      throw new Error(`scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
    }
    const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
    const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
    if (unknown.length) throw new Error(`scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
    for (const r of references ?? []) {
      if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new Error(`Reference image not found: ${r.image}`);
    }
    const job = this.queue.add({
      agent_refs: references?.length ? references : undefined,
      agent_scene_refs: references?.length ? scene_references : undefined,
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await listAssets()).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name }: Args<"trash">) {
    if (this.queue.busy) throw new Error(BUSY);
    return trashAsset(name);
  }

  async new_project({ title }: Args<"new_project">) {
    if (this.queue.busy) throw new Error(BUSY);
    const made = await createProject(title);
    return { ...made, note: "The Flow window now has this empty project open; every generation goes into it. Characters belong to a project, so make them again here." };
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    const made = await createCharacter(a);
    // Every scene quotes the saved description in its character lock, so a character made from a picture must not
    // inherit an older description saved under the same name: it described someone else (a "Maya" with a ponytail and
    // a mustard sweater, when the new picture showed loose hair and a grey tee).
    if (a.describe) rememberCharacter(a.name, a.describe, a.voice);
    else if (a.look) rememberCharacter(a.name, a.look, a.voice);
    else if (a.voice) rememberCharacter(a.name, characterLook(a.name) ?? "", a.voice);
    else forgetCharacter(a.name);
    return { ...made, use_as: `asset:${a.name}` };
  }

  async character_edit({ name, change, look }: Args<"character_edit">) {
    if (this.queue.busy) throw new Error(BUSY);
    const out = await editCharacter(name, change);
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(name, look);
    else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { ...out, use_as: `asset:${name}` };
  }

  async characters() {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listCharacters()).map((c) => ({
      name: c.displayName,
      displayName: c.displayName,
      assetId: c.characterId,
      characterId: c.characterId,
      projectId: c.projectId,
      thumbnail: c.thumbnail,
      voice: c.voice,
      source: "character",
      kind: "character",
      assetType: "character",
      use_as: encodeFlowRef({
        assetId: c.characterId,
        assetName: c.displayName,
        projectId: c.projectId,
        assetType: "character",
      }),
    }));
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  voices = voicesHere;
  narrate = narrateHere;

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }

  async ensureCompositionDownload(project: string, comp?: FlowCompositionRecord): Promise<string> {
    const record = comp ?? getComposition(project);
    if (!record || record.publish_status !== "ready_to_publish") {
      throw new Error("No merged Final composition is ready on Google Flow for this project.");
    }
    if (cacheIsValid(record)) return record.cached_video_path!;
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const stem = join(dir, `${compositionKey(project)}-final`);
    const path = await downloadFlowComposition(record, stem);
    record.cached_video_path = path;
    record.cached_video_hash = record.content_hash;
    record.updated_at = new Date().toISOString();
    saveComposition(record);
    return path;
  }

  async flow_projects({ open_id }: Args<"flow_projects">) {
    if (this.queue.busy) throw new Error(BUSY);
    const signed = await getFlowState(false);
    if (!signed.signedIn) throw new Error(signed.hint ?? "Not signed in to Flow.");
    const flowList = await listFlowProjects();
    const local = (await this.outputs()) as { projects: { name: string }[] };
    const localNames = new Set(local.projects.map((p) => p.name));
    const comps = loadCompositions();
    const byFlowId = new Map<string, FlowCompositionRecord>();
    for (const rec of Object.values(comps)) byFlowId.set(rec.flow_project_id, rec);

    const pickFolder = (flowId: string, title: string) => {
      const fromComp = byFlowId.get(flowId);
      if (fromComp) return fromComp.tedverse_project;
      const slug = compositionKey(title);
      if (localNames.has(slug)) return slug;
      if (localNames.has(title)) return title;
      return slug;
    };

    const projects = flowList.map((fp) => {
      const tedverse_project = pickFolder(fp.id, fp.title);
      const composition = getComposition(tedverse_project) ?? getCompositionByFlowId(fp.id);
      const compReady = composition?.publish_status === "ready_to_publish";
      const dir = projectDir(tedverse_project);
      const hasFinalOnDisk = Boolean(guessDefaultVideo(dir, tedverse_project));
      return {
        id: fp.id,
        title: fp.title,
        url: fp.url,
        tedverse_project,
        has_local_folder: localNames.has(tedverse_project),
        has_final_on_flow: compReady,
        has_final_on_disk: hasFinalOnDisk,
      };
    });

    projects.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

    if (open_id) await openFlowProject(open_id);

    return { projects, signed_in: true };
  }

  async publish_options({ project, flow_project_id, flow_video_id, download }: Args<"publish_options">) {
    if (this.queue.busy) throw new Error(BUSY);
    let folder = project;
    const composition =
      (flow_project_id ? getCompositionByFlowId(flow_project_id) : undefined) ?? getComposition(project) ?? null;
    if (composition?.tedverse_project) folder = composition.tedverse_project;
    const dir = projectDir(folder);
    mkdirSync(dir, { recursive: true });

    if (!flow_project_id) {
      const locals = listPublishableVideos(dir);
      return {
        project: folder,
        flow_project_id: undefined,
        flow_videos: locals.map((v) => ({
          handle: v.path,
          name: v.name,
          kind: "file" as const,
          local_path: v.path,
        })),
        default_flow_video_handle: locals[0]?.path,
        note: "Pick a Flow project to list videos on Google Flow.",
      };
    }

    const grid = await listFlowProjectVideos(flow_project_id);
    const flow_videos = grid.map((a) => {
      const handle = assetPublishHandle(a);
      const published = summarizeClipPublish(flow_project_id, handle);
      return {
        handle,
        id: a.id,
        name: a.name,
        kind: a.kind,
        local_path: undefined as string | undefined,
        published_on: published.platforms,
        posted: published.posted,
        posted_label: published.posted.length ? published.labels : "",
      };
    });

    const prefer = (a: { name: string; kind: string }) =>
      /^final$/i.test(a.name.trim()) ? 0 : a.kind === "scene" ? 1 : 2;
    flow_videos.sort((a, b) => prefer(a) - prefer(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    let default_flow_video_handle =
      flow_videos.find((v) => /^final$/i.test(v.name.trim()))?.handle ?? flow_videos[0]?.handle;
    let downloaded_path: string | undefined;
    let note = flow_videos.length
      ? `${flow_videos.length} video(s) / scene(s) in Flow project ${flow_project_id.slice(0, 8)}….`
      : `No videos found in Flow project ${flow_project_id.slice(0, 8)}… — check the Flow Chrome window is on that project's All media grid, then change project or press Refresh videos.`;

    const want = flow_video_id || default_flow_video_handle;
    if (download && want) {
      downloaded_path = await downloadFlowAssetForPublish(flow_project_id, want, dir);
      const row = flow_videos.find((v) => v.handle === want);
      if (row) row.local_path = downloaded_path;
      note = `Saved to ${basename(downloaded_path)} on this PC.`;
    }

    return {
      project: folder,
      flow_project_id,
      flow_videos,
      default_flow_video_handle,
      downloaded_path,
      note,
    };
  }

  async flow_composition({ project }: Args<"flow_composition">) {
    return { composition: getComposition(project) ?? null };
  }

  async flow_recover_film_scenes({ project, clips }: Args<"flow_recover_film_scenes">) {
    if (this.queue.busy) throw new Error(BUSY);
    const grid = await listAssets();
    const flowProjectId = grid.find((a) => a.projectId)?.projectId;
    const scenes = clips.map((clip, order) => {
      const flow_title = clip.flow_title.trim();
      const legacy = `${project}-${clip.stem}`;
      const hit = grid.find(
        (a) =>
          a.kind === "video" &&
          (a.name === flow_title ||
            a.name === clip.stem ||
            a.name === legacy ||
            a.name === `${project}-${flow_title}`),
      );
      if (!hit) return { order: order + 1, stem: clip.stem, flow_title, found: false as const };
      return {
        order: order + 1,
        stem: clip.stem,
        flow_title: hit.name,
        found: true as const,
        asset_id: hit.id ?? `title:${hit.name}`,
        project_id: hit.projectId ?? flowProjectId,
        kind: hit.kind,
      };
    });
    return { project, flow_project_id: flowProjectId, scenes };
  }

  async flow_merge({ project, clips, force }: Args<"flow_merge">) {
    if (isMuseProvider()) {
      throw new Error("Merge in Google Flow is unavailable while Muse AI is selected. Use local Cut/assemble, or switch to Google Flow.");
    }
    if (this.queue.busy) throw new Error(BUSY);
    const { sortClipsForMerge } = await import("./film-script.js");
    const orderedClips = sortClipsForMerge([...clips]);
    const titles = orderedClips.map((c) => c.flow_title?.trim() || `${project}-${c.stem}`);
    const hash = contentHashFromTitles(titles);
    const existing = getComposition(project);
    if (!force && existing?.merge_status === "completed" && existing.content_hash === hash) {
      return {
        composition: existing,
        merge_status: existing.merge_status,
        publish_status: existing.publish_status,
        reused: true,
      };
    }
    const composition = await mergeClipsIntoFlowScene({
      tedverseProject: project,
      clips: orderedClips,
      aspect_ratio: "9:16",
    });
    return {
      composition,
      merge_status: composition.merge_status,
      publish_status: composition.publish_status,
    };
  }

  async publish({
    project,
    video,
    platforms,
    hashtags,
    confirm_uncertain,
    flow_project_id,
    flow_video_id,
    flow_video_name,
    caption,
    mode,
    schedule_at,
  }: Args<"publish">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    let resolved: string | undefined;
    let ephemeral = false;
    if (video?.trim()) {
      const candidate = isAbsolute(video) ? resolve(video) : resolve(dir, video);
      if (existsSync(candidate)) resolved = candidate;
    }
    if (!resolved && flow_project_id && flow_video_id) {
      resolved = await fetchFlowVideoStaging(flow_project_id, flow_video_id);
      ephemeral = true;
    }
    if (!resolved) throw new Error("Pick a video from Flow, then Publish — TedVerse downloads it briefly for upload.");
    if (resolved && !ephemeral) {
      const rel = relative(dir, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Video must be in this project's folder.");
    }
    const flowTitle =
      flow_video_name?.trim() ||
      (flow_video_id?.startsWith("title:") ? flow_video_id.slice("title:".length) : undefined);
    const postCaption = (caption ?? flowTitle ?? project).trim() || project;
    try {
      const record = await publishManager.publish({
        project,
        video: resolved,
        platforms,
        caption: postCaption,
        hashtags: normalizeHashtags(hashtags ?? ""),
        confirm_uncertain,
        flow_project_id,
        flow_video_handle: flow_video_id,
        flow_video_name: flowTitle,
        mode: mode ?? "now",
        schedule_at,
      });
      prunePublishHistoryStores(PUBLISH_HISTORY_KEEP);
      return record;
    } finally {
      if (ephemeral && resolved) releaseEphemeralFile(resolved);
    }
  }

  async publish_status({ project, video, flow_project_id, flow_video_id }: Args<"publish_status">) {
    const dir = projectDir(project);
    const resolved = video ? (isAbsolute(video) ? resolve(video) : resolve(dir, video)) : undefined;
    const flowClip =
      flow_project_id && flow_video_id ? { flow_project_id, flow_video_handle: flow_video_id } : undefined;
    const snap = publishManager.snapshot(project, resolved, flowClip);
    if (flow_project_id && flow_video_id) {
      const summary = summarizeClipPublish(flow_project_id, flow_video_id);
      return { ...snap, clip: summary };
    }
    return snap;
  }

  async publish_retry({
    project,
    video,
    platforms,
    confirm_uncertain,
    flow_project_id,
    flow_video_id,
  }: Args<"publish_retry">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    const composition = getComposition(project);
    let resolved: string | undefined;
    let ephemeral = false;
    const flowId = flow_project_id ?? composition?.flow_project_id;
    const handle = flow_video_id ?? (composition?.publish_status === "ready_to_publish" ? "title:Final" : undefined);
    if (flowId && handle) {
      resolved = await fetchFlowVideoStaging(flowId, handle);
      ephemeral = true;
    } else if (video?.trim()) {
      resolved = isAbsolute(video) ? resolve(video) : resolve(dir, video);
      if (!existsSync(resolved)) throw new Error("Pick a Flow video or finish merging first.");
      const rel = relative(dir, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Video must be in this project's folder.");
    } else {
      throw new Error("Pick a Flow video or finish merging in Google Flow first.");
    }
    try {
      return await publishManager.retry({
        project,
        video: resolved,
        platforms,
        confirm_uncertain,
      });
    } finally {
      if (ephemeral) releaseEphemeralFile(resolved);
    }
  }

  async publish_history({ limit }: Args<"publish_history"> = {}) {
    const cap = limit ?? PUBLISH_HISTORY_KEEP;
    prunePublishHistoryStores(PUBLISH_HISTORY_KEEP);
    return { rows: buildPublishHistory(cap) };
  }

  async provider_info() {
    const { getActiveProviderId } = await import("./providers/platform-config.js");
    const provider = getActiveProviderId();
    return {
      ...providerPayload(provider),
      queue_busy: this.queue.busy,
      jobs_running: this.queue.list().some((j) => j.status === "running" || j.status === "queued"),
    };
  }

  async provider_select({ provider }: Args<"provider_select">) {
    if (this.queue.busy || this.queue.list().some((j) => j.status === "running" || j.status === "queued")) {
      throw new Error("Cannot switch AI platform while a generation job is queued or running. Wait for the Monitor to finish.");
    }
    const saved = writeProviderConfig(provider);
    return { ok: true, active_provider: provider, ...providerPayload(provider), updatedAt: saved.updatedAt };
  }

  async muse_status() {
    const { museStatus } = await import("./providers/muse/muse-driver.js");
    return museStatus();
  }

  async muse_open_login({ show }: Args<"muse_open_login">) {
    const mod = await import("./providers/muse/muse-driver.js");
    if (show) {
      await mod.openMuseBrowser();
      mod.getMuse(true);
      // Return quickly — status() can block 30s+ on Chrome/Muse lock; Safari shows "Load failed" on slow POST.
      return { opened: true, connected: false, email: null as string | null };
    }
    return mod.museStatus().catch((e: Error) => ({ connected: false, email: null, error: e.message }));
  }

}

// Narration never touches Chrome, so it runs in whichever process gets the call. A client then never depends on the
// owner's code: Claude Desktop's own flow-mcp process can be a release behind until the user restarts the app.
export async function voicesHere() {
  // The panel words itself from these, so a PC never reads "this Mac".
  const place = { computer: COMPUTER, bin: BIN, platform: process.platform };
  return { kokoro: KOKORO_VOICES, kokoro_ready: kokoroReady(), kokoro_mb: KOKORO_MB, gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), place };
}

export async function narrateHere({ project, text, voice, engine, speed, style }: Args<"narrate">) {
  const output_dir = projectDir(project);
  mkdirSync(output_dir, { recursive: true });
  const taken = readdirSync(output_dir).map((f) => Number(f.match(/^narration-(\d+)/)?.[1] ?? 0));
  const target = join(output_dir, `narration-${String(Math.max(0, ...taken) + 1).padStart(2, "0")}.m4a`);
  const line = text.trim();
  if (engine === "kokoro") {
    const v = voice ?? KOKORO_DEFAULT_VOICE;
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithKokoro(line, v, target, speed)) };
  }
  const v = voice ?? "Charon";
  try {
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithGemini(line, v, target, style)) };
  } catch (err) {
    // The free AI Studio tier has a daily limit. Running out of it should not stop the film: Kokoro records the line
    // now, and the note says how to get the Google voice back once the limit resets.
    if (!/\b429\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(String((err as Error).message))) throw err;
    const spoken = await speakWithKokoro(line, KOKORO_DEFAULT_VOICE, target);
    return {
      output_dir, credits: 0, engine: "kokoro", voice: KOKORO_DEFAULT_VOICE, fell_back_from: "gemini", ...spoken,
      note: `Google AI Studio's daily limit is used up, so this take was recorded with Kokoro (${KOKORO_DEFAULT_VOICE}) instead. Record it again with ${v} once the limit resets.`,
    };
  }
}

// Captions never touch Flow or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them. So,
// like narration, they run in whichever process gets the call and never wait for the owner to be restarted.
export async function transcribeHere({ video, language, words }: Args<"transcribe">) {
  const t = await transcribe(video, language);
  return {
    text: t.text,
    word_count: t.words.length,
    language: t.language,
    model: t.model,
    ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
  };
}

export async function presenterHere({ project, ...a }: Args<"presenter">) {
  return presenter({ ...a, dir: projectDir(project) });
}

export async function captionPreviewHere(a: Args<"caption_preview">) {
  return previewCaptions(a.video, a);
}

export async function captionsHere({ project, ...a }: Args<"captions">) {
  // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
  const rel = relative(OUTPUT_ROOT, dirname(a.video));
  const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
  mkdirSync(dir, { recursive: true });
  return burnCaptions(a.video, a, captionedName(dir, a.video));
}

export async function captionSetupHere() {
  return captionSetup();
}
