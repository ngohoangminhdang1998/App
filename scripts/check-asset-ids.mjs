import { cleanMediaRef, encodeFlowRef, mediaRefLabel, optionIsExactMedia, parseStoredRef } from "../dist/media-ref.js";
import { listAssets, matchProjectAsset } from "../dist/flow.js";

const pick = { assetId: "0fd5cbd1-ae75-4ab6-b63d-ec22f5fbb037", assetName: "14371.png", projectId: "2cccad81-91ec-4e68-a4a8-e143aee8559e", assetType: "image" };
const stored = cleanMediaRef(pick);
if (!stored.startsWith("flowref:") || parseStoredRef(stored).pick.assetId !== pick.assetId) {
  throw new Error("cleanMediaRef did not keep the asset id");
}
if (!optionIsExactMedia("14371.png Image", "14371.png") || optionIsExactMedia("14371.png-copy Image", "14371.png")) {
  throw new Error("exact option match is wrong");
}
const assets = [
  { name: "14371.png", kind: "image", id: pick.assetId, projectId: pick.projectId },
  { name: "14371.png", kind: "image", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", projectId: pick.projectId },
];
const hit = matchProjectAsset(assets, stored, pick.projectId);
if (hit.assetId !== pick.assetId || hit.name !== "14371.png" || !hit.ambiguousName) throw new Error("id match failed: " + JSON.stringify(hit));
let mismatched = false;
try {
  matchProjectAsset([{ name: "14371.png", kind: "image", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", projectId: pick.projectId }], stored, pick.projectId);
} catch (err) {
  mismatched = /id mismatch/i.test(err.message);
}
if (!mismatched) throw new Error("id mismatch was not refused");
let dup = false;
try {
  matchProjectAsset(assets, "asset:14371.png", pick.projectId);
} catch (err) {
  dup = /Duplicate filenames/i.test(err.message);
}
if (!dup) throw new Error("duplicate filenames were not refused");
let wrongProject = false;
try {
  matchProjectAsset(assets, stored, "00000000-0000-0000-0000-000000000000");
} catch (err) {
  wrongProject = /belongs to project/i.test(err.message);
}
if (!wrongProject) throw new Error("wrong project was not refused");
const legacy = matchProjectAsset([{ name: "14371.png", kind: "image", id: pick.assetId, projectId: pick.projectId }], "asset:14371.png", pick.projectId);
if (legacy.assetId !== pick.assetId || !legacy.onGrid) throw new Error("legacy name did not resolve to the id");
console.log("unit ok", mediaRefLabel(stored));
console.log("encoded", encodeFlowRef(pick));

if (process.argv.includes("--live")) {
  const live = await listAssets();
  const projectId = live.find((a) => a.projectId)?.projectId;
  const named = live.filter((a) => a.name === "14371.png");
  console.log("project", projectId, "assets", live.length, "named 14371.png", named.map((a) => ({ id: a.id, kind: a.kind })));
  if (!named.length) {
    console.log("14371.png is not on the open project's grid");
  } else if (named.length > 1) {
    console.log("duplicate names on the grid; generation must use assetId");
  } else {
    const ref = encodeFlowRef({ assetId: named[0].id, assetName: named[0].name, projectId: named[0].projectId, assetType: named[0].kind });
    const resolved = matchProjectAsset(live, ref, projectId);
    console.log("runGeneration would attach", JSON.stringify({ name: resolved.name, assetId: resolved.assetId, byId: resolved.byId }));
    if (resolved.assetId !== named[0].id) throw new Error("resolved id does not match the grid id");
  }
  process.exit(0);
}
