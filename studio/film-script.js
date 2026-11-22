// Local script splitter for Auto Film. No network, no rewriting. Headers must be their own line.
// A script with no header is not split: guessing paragraph boundaries would drop or merge dialogue.
export const FILM_RATES = {
    "Omni 1.1 Flash": { "360p": { 4: 4, 6: 5, 8: 6, 10: 7 }, "720p": { 4: 7, 6: 10, 8: 12, 10: 15 } },
    "Veo 3.1 - Lite": 10,
    "Veo 3.1 - Fast": 20,
    "Veo 3.1 - Quality": 100,
};
export function omniModel(model) {
    return model.startsWith("Omni");
}
// Same prices the Shots tab uses. Returns null when this model has no row for those settings.
export function shotCost(model, resolution, duration, takes) {
    const row = FILM_RATES[model];
    if (row == null || !Number.isFinite(takes) || takes < 1)
        return null;
    const per = typeof row === "number" ? row : row[resolution]?.[duration];
    return per == null ? null : per * takes;
}
// === SCENE 001 ===  |  SCENE 001:  |  Scene 1:  |  [SCENE 1]  |  CẢNH 001
const HEADER = /^\s*(?:===\s*)?\[?\s*(?:scene|cảnh)\s+(\d+)\s*\]?\s*(?:===\s*)?:?\s*$/iu;
/** Phrases that often trigger Flow policy (fake news / misinformation) or extra scrutiny. */
const FLOW_NEWS_RISK = /\b(breaking news|news report|live news|news channel|news bulletin|báo chính|tin nóng|điểm tin|thời sự|current events|misinformation|reputational)\b/i;
export function flowNewsRiskInPrompt(prompt) {
    return FLOW_NEWS_RISK.test(prompt);
}
export function parseFilmScript(script) {
    const text = String(script ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!text.trim())
        return { scenes: [], warnings: ["The script is empty."], preamble: "" };
    const lines = text.split("\n");
    const headers = [];
    lines.forEach((line, index) => {
        const match = HEADER.exec(line);
        if (match)
            headers.push({ index, number: Number(match[1]), header: line.trim() });
    });
    if (!headers.length) {
        return {
            scenes: [],
            warnings: [
                "No scene headers found, so nothing was split. Put each scene on its own line, for example === SCENE 001 === or SCENE 001:. Paragraphs were not guessed.",
            ],
            preamble: text,
        };
    }
    const warnings = [];
    const counts = new Map();
    for (const header of headers)
        counts.set(header.number, (counts.get(header.number) ?? 0) + 1);
    for (const [number, count] of counts) {
        if (count > 1)
            warnings.push(`Scene number ${number} appears ${count} times. Every copy was kept, in the order written.`);
    }
    const preamble = lines.slice(0, headers[0].index).join("\n").replace(/^\n+|\n+$/g, "");
    if (preamble.trim()) {
        warnings.push("Text before the first scene header was not put into a scene. It is kept below so you can move it by hand.");
    }
    const scenes = headers.map((header, i) => {
        const end = i + 1 < headers.length ? headers[i + 1].index : lines.length;
        const prompt = lines.slice(header.index + 1, end).join("\n").replace(/^\n+|\n+$/g, "");
        if (!prompt.trim())
            warnings.push(`Scene ${header.number} has an empty prompt.`);
        return { number: header.number, header: header.header, prompt };
    });
    for (const sc of scenes) {
        if (flowNewsRiskInPrompt(sc.prompt)) {
            warnings.push(`Scene ${sc.number}: wording looks like real news ("breaking news", "news report", etc.). Flow often refuses that. Reframe as fictional comedy — e.g. "staged satire sketch", "impossible fantasy snow in Saigon", no TV news graphics.`);
        }
    }
    return { scenes, warnings, preamble };
}
// Type comes from where the row was found. A grid tile stays an image even when its title matches a character.
// Product is used only when the stored metadata itself says product.
export function listedAssetKind(row) {
    if (row.source === "character" || row.assetType === "character" || row.kind === "character")
        return "character";
    if (row.kind === "product" || row.assetType === "product")
        return "product";
    if (row.kind === "image" || row.assetType === "image")
        return "image";
    if (row.kind === "video" || row.assetType === "video")
        return "video";
    if (row.kind === "scene" || row.assetType === "scene")
        return "scene";
    return "unknown";
}
export function assetKindLabel(kind) {
    if (kind === "character")
        return "CHARACTER";
    if (kind === "image")
        return "IMAGE";
    if (kind === "product")
        return "PRODUCT";
    if (kind === "video")
        return "VIDEO";
    if (kind === "scene")
        return "SCENE";
    return "UNKNOWN";
}
export function statusBadge(status) {
    const key = String(status || "pending").toLowerCase();
    const known = [
        "pending",
        "generating",
        "waiting_flow",
        "generated_on_flow",
        "completed",
        "failed",
        "skipped",
        "download_failed",
    ];
    if (known.includes(key)) {
        if (key === "generated_on_flow")
            return "ON FLOW";
        if (key === "waiting_flow")
            return "WAITING FOR FLOW";
        return key.toUpperCase();
    }
    return "PENDING";
}
/** Play order for merge: numeric Flow title (1,2,3…) beats scene number, then digits in stem. */
export function mergePlayOrderKey(clip, fallbackIndex = 0) {
    const title = (clip.flow_title || clip.flowTitle || "").trim();
    if (/^\d+$/.test(title))
        return Number(title);
    const leading = title.match(/^(\d+)\b/);
    if (leading)
        return Number(leading[1]);
    if (typeof clip.number === "number" && clip.number > 0)
        return clip.number;
    const stem = clip.stem || "";
    const stemNum = stem.match(/(\d+)/);
    if (stemNum)
        return Number(stemNum[1]);
    return 100000 + fallbackIndex;
}
export function sortClipsForMerge(clips, sceneNumbers) {
    return [...clips].sort((a, b) => {
        const na = sceneNumbers?.get(a.stem);
        const nb = sceneNumbers?.get(b.stem);
        const ka = mergePlayOrderKey({ stem: a.stem, flow_title: a.flow_title, number: na }, 0);
        const kb = mergePlayOrderKey({ stem: b.stem, flow_title: b.flow_title, number: nb }, 0);
        return ka - kb || a.stem.localeCompare(b.stem);
    });
}
/** Scene is ready for Google Flow merge (asset in Flow, no local file required). */
export function sceneReadyOnFlow(scene) {
    const st = String(scene.status || "").toLowerCase();
    const hasRef = Boolean(scene.flowTitle?.trim() ||
        scene.flow_title?.trim() ||
        scene.flowAssetId?.trim() ||
        scene.flow_asset_id?.trim());
    if (st === "generated_on_flow" && hasRef)
        return true;
    if ((st === "completed" || st === "download_failed") && hasRef)
        return true;
    return false;
}
// First two lines of the prompt. Anything past that, or a very long line, ends with "...".
export function promptPreview(prompt) {
    const raw = String(prompt ?? "").replace(/\r\n/g, "\n");
    const lines = raw.split("\n");
    let shown = lines.slice(0, 2).join("\n");
    const more = lines.length > 2;
    if (shown.length > 160)
        shown = shown.slice(0, 160);
    if ((more || shown.length < raw.length) && !shown.endsWith("..."))
        shown += "...";
    return shown;
}
// Which rows to paint. The window stays small no matter how many scenes exist.
export function tableWindow(total, scrollTop, rowHeight, viewHeight, overscan = 4) {
    if (total <= 0 || rowHeight <= 0)
        return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
    const count = Math.ceil(viewHeight / rowHeight) + overscan * 2;
    return { start, end: Math.min(total, start + count) };
}
// Old Auto Film saves may contain a voice block. It is not part of the project anymore.
export function dropFilmVoice(saved) {
    const copy = { ...saved };
    delete copy.voice;
    return copy;
}
// Only a character row can carry a voice, and only a voice that was actually saved.
export function voiceStatus(row) {
    if (listedAssetKind(row) !== "character")
        return null;
    const voice = row.voice?.trim();
    return voice ? `Voice: ${voice}` : "No voice assigned";
}
const MATERIAL_ICON_WORDS = /\b(favorite|more_vert|accessibility_new|person|movie|image|videocam|mic|star|share|arrow_forward|edit|delete|download)\b/gi;
const REF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isRefId(id) {
    return !!id && REF_ID.test(id);
}
/** Strip Material icon ligature text Flow renders inside character cards. */
export function cleanDisplayName(raw) {
    return String(raw ?? "")
        .replace(MATERIAL_ICON_WORDS, "")
        .replace(/\s+/g, " ")
        .trim();
}
export function normalizeLookEntry(raw) {
    if (typeof raw === "string")
        return { look: raw };
    if (raw && typeof raw === "object") {
        const entry = raw;
        const look = typeof entry.look === "string" ? entry.look : undefined;
        const voice = typeof entry.voice === "string" && entry.voice.trim() ? entry.voice.trim() : undefined;
        return { look, voice };
    }
    return {};
}
// Characters from the Characters list stay characters. Grid rows keep the tile type Flow already gave them.
export function mergePickerRows(characters, assets) {
    const cast = characters.map((c) => {
        const displayName = cleanDisplayName(c.displayName || c.name);
        const id = c.characterId || c.assetId;
        return {
            name: displayName,
            displayName,
            assetName: displayName,
            assetId: id,
            characterId: id,
            projectId: c.projectId,
            thumbnail: c.thumbnail,
            kind: "character",
            assetType: "character",
            source: "character",
            voice: c.voice?.trim() ? c.voice.trim() : null,
        };
    });
    const grid = assets.map((a) => ({
        ...a,
        assetName: a.name,
        assetType: a.assetType || a.kind,
        source: "grid",
        voice: null,
    }));
    return [...cast, ...grid];
}
function slotFilled(slot) {
    return Boolean(slot && (slot.assetId || slot.asset || slot.assetName || slot.path));
}
// Shared film references, or a scene's own list. Never more than 3. The prompt is not involved.
export function sceneReferenceSlots(filmRefs, scene, applyToAll = true) {
    const mode = scene.refMode || "film";
    const list = mode === "none" ? [] : mode === "custom" ? (scene.refs ?? []) : applyToAll ? filmRefs : [];
    const out = [];
    for (const item of list) {
        if (!slotFilled(item))
            continue;
        out.push(item);
        if (out.length === 3)
            break;
    }
    return out;
}
/** Legacy name-only slots: clean icon words and resolve ids from the live picker list. */
export function migrateRefSlot(ref, rows) {
    if (!ref || typeof ref !== "object")
        return ref;
    const out = { ...ref };
    const label = cleanDisplayName(out.displayName || out.assetName || out.asset || out.name || "");
    if (label) {
        out.displayName = label;
        out.assetName = label;
        out.asset = label;
    }
    const wantedId = out.assetId?.trim();
    if (wantedId && isRefId(wantedId)) {
        const hit = rows.find((r) => (r.characterId || r.assetId) === wantedId);
        if (hit) {
            const dn = cleanDisplayName(hit.displayName || hit.assetName || hit.name || label);
            out.displayName = dn;
            out.assetName = dn;
            out.asset = dn;
            out.assetId = wantedId;
            out.projectId = hit.projectId ?? out.projectId;
            out.thumbnail = hit.thumbnail ?? out.thumbnail;
            if (hit.voice)
                out.voice = hit.voice;
            out.assetType = "character";
            out.kind = "character";
            out.needsReselect = false;
            return out;
        }
        const grid = rows.find((r) => r.source !== "character" && r.assetId === wantedId);
        if (grid) {
            out.needsReselect = false;
            return out;
        }
        out.needsReselect = true;
        return out;
    }
    if (!label)
        return out;
    const character = rows.find((r) => r.source === "character" && cleanDisplayName(r.displayName || r.assetName || r.name || "") === label);
    if (character && (character.characterId || character.assetId)) {
        out.assetId = character.characterId || character.assetId;
        out.projectId = character.projectId ?? out.projectId;
        out.thumbnail = character.thumbnail ?? out.thumbnail;
        if (character.voice)
            out.voice = character.voice;
        out.assetType = "character";
        out.kind = "character";
        out.needsReselect = false;
        return out;
    }
    const grid = rows.find((r) => r.source === "grid" && cleanDisplayName(r.assetName || r.name || "") === label && r.assetId);
    if (grid?.assetId) {
        out.assetId = grid.assetId;
        out.projectId = grid.projectId ?? out.projectId;
        out.thumbnail = grid.thumbnail ?? out.thumbnail;
        out.needsReselect = false;
        return out;
    }
    out.needsReselect = true;
    return out;
}
// Names only. The prompt is never changed to mention them. More than 3 is left intact so the caller can refuse.
export function sceneCharacters(cast, scene) {
    const names = [];
    if (scene.override === "none") { /* this scene opted out of the main character */ }
    else if (scene.override)
        names.push(scene.override);
    else if (cast.applyMain && scene.useMain !== false && cast.main)
        names.push(cast.main);
    if (cast.support)
        names.push(cast.support);
    if (scene.support)
        names.push(scene.support);
    return [...new Set(names.filter(Boolean))];
}
export function moveItem(list, index, dir) {
    const next = index + dir;
    if (next < 0 || next >= list.length)
        return index;
    const [row] = list.splice(index, 1);
    list.splice(next, 0, row);
    return next;
}
export function queueGate(paused, stop) {
    if (stop)
        return "stop";
    if (paused)
        return "wait";
    return "go";
}
export function overBudget(spent, next, budget) {
    return spent + next > budget;
}
// What to do with one scene. Completed work is never submitted again.
export function sceneAction(scene, budget) {
    if (!scene.selected || scene.status === "skipped")
        return "skip";
    if (sceneReadyOnFlow(scene))
        return "skip";
    if (scene.status === "completed")
        return "skip";
    if (scene.status === "generating" && scene.jobId)
        return "poll";
    if (scene.status === "generating")
        return "blocked";
    if (!scene.prompt.trim())
        return "empty";
    if (overBudget(budget.spent, budget.next, budget.budget))
        return "over-budget";
    return "submit";
}
