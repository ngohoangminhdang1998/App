export function assertMuseGenerateAllowed(scenes: { reference_images?: unknown[] }[]): void {
  const assetRef = scenes.find((s) => (s.reference_images ?? []).some((r) => String(r).startsWith("asset:")));
  if (assetRef) {
    throw new Error("Muse mode: replace asset: references with local image paths (Cast → Frames stills).");
  }
}