// How a scene points at media. A local file is a path. An older Flow pick is "asset:<filename>".
// A new From Flow pick is "flowref:" plus JSON carrying the grid's data-media-id, which is stable.
// The asset picker itself does not expose that id (verified on the live listbox: role=option, aria name
// "<filename> Image|Video", thumbnail src only), so the id is resolved on the project grid first.

export interface FlowPick {
  assetId: string;
  assetName: string;
  projectId?: string;
  assetType?: "image" | "video" | "scene" | "character";
}

export const FLOW_REF_PREFIX = "flowref:";

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMediaId(id?: string): boolean {
  return !!id && MEDIA_ID.test(id);
}

export function encodeFlowRef(pick: FlowPick): string {
  const assetId = pick.assetId.trim();
  const assetName = pick.assetName.trim();
  if (!assetId || !assetName) throw new Error("A Flow asset needs both an id and a name.");
  return (
    FLOW_REF_PREFIX +
    JSON.stringify({
      assetId,
      assetName,
      projectId: pick.projectId?.trim() || undefined,
      assetType: pick.assetType,
    })
  );
}

export type StoredRef = { kind: "file"; path: string } | { kind: "name"; name: string } | { kind: "flow"; pick: FlowPick };

export function parseStoredRef(value: string): StoredRef | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (t.startsWith(FLOW_REF_PREFIX)) {
    let data: Partial<FlowPick>;
    try {
      data = JSON.parse(t.slice(FLOW_REF_PREFIX.length)) as Partial<FlowPick>;
    } catch {
      throw new Error(`Unreadable Flow asset reference (${t.slice(0, 60)}). Pick the asset again from Flow.`);
    }
    const assetId = String(data.assetId ?? "").trim();
    const assetName = String(data.assetName ?? "").trim();
    if (!assetId || !assetName) throw new Error("Flow asset reference is missing assetId or assetName.");
    return {
      kind: "flow",
      pick: {
        assetId,
        assetName,
        projectId: data.projectId?.trim() || undefined,
        assetType: data.assetType,
      },
    };
  }
  if (t.toLowerCase().startsWith("asset:")) {
    const name = t.slice(6).trim();
    if (!name) return undefined;
    return { kind: "name", name };
  }
  return { kind: "file", path: t };
}

export function cleanMediaRef(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const o = value as Partial<FlowPick>;
    const assetId = String(o.assetId ?? "").trim();
    const assetName = String(o.assetName ?? "").trim();
    if (!assetId || !assetName) return undefined;
    return encodeFlowRef({ assetId, assetName, projectId: o.projectId, assetType: o.assetType });
  }
  if (typeof value !== "string") return undefined;
  const parsed = parseStoredRef(value);
  if (!parsed) return undefined;
  if (parsed.kind === "flow") return encodeFlowRef(parsed.pick);
  if (parsed.kind === "name") return `asset:${parsed.name}`;
  return parsed.path;
}

export function cleanMediaRefs(values: unknown[] | undefined | null): string[] | undefined {
  if (!values?.length) return undefined;
  const out = [...new Set(values.map(cleanMediaRef).filter((v): v is string => Boolean(v)))];
  return out.length ? out : undefined;
}

export function mediaRefLabel(value: string): string {
  const parsed = parseStoredRef(value);
  if (!parsed) return value;
  if (parsed.kind === "file") return parsed.path;
  if (parsed.kind === "name") return `asset:${parsed.name}`;
  const id = isMediaId(parsed.pick.assetId) ? parsed.pick.assetId.slice(0, 8) : parsed.pick.assetId.startsWith("title:") ? "title" : parsed.pick.assetId.slice(0, 8);
  return `${parsed.pick.assetName} [${id}]`;
}

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
  const bits: string[] = [];
  if (p.first_frame) bits.push(`first_frame=${mediaRefLabel(p.first_frame)}`);
  if (p.last_frame) bits.push(`last_frame=${mediaRefLabel(p.last_frame)}`);
  if (p.reference_images?.length) bits.push(`reference_images=[${p.reference_images.map(mediaRefLabel).join(", ")}]`);
  if (p.chain_from) bits.push(`chain_from=${p.chain_from}`);
  if (p.reference_from) bits.push(`reference_from=${p.reference_from}`);
  if (p.attach?.length) bits.push(`attach=[${p.attach.join(", ")}]`);
  if (p.continue_from) bits.push(`continue_from=${p.continue_from}`);
  if (p.edit_asset) bits.push(`edit_asset=${p.edit_asset}`);
  return bits.length ? bits.join(" · ") : "text-only (no frames or references)";
}

export function isLocalClip(value: string): boolean {
  const parsed = parseStoredRef(value);
  return parsed?.kind === "file" && /\.(mp4|webm|mov)$/i.test(parsed.path);
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Picker options read "<name> Image", "<name> Video" or "<name> Avatar" (live listbox, 2026-11-19).
export function optionIsExactMedia(optionName: string, assetName: string): boolean {
  return new RegExp(`^${escapeRe(assetName.trim())}(?:\\s+(?:Image|Video|Avatar))?$`, "i").test(optionName.trim());
}

export function optionHasNamePrefix(optionName: string, assetName: string): boolean {
  return new RegExp(`^${escapeRe(assetName.trim())}`, "i").test(optionName.trim());
}
