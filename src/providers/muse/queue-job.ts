import type { Job } from "../../queue.js";

/** Muse-only queue path — not loaded when Google Flow is selected. */
export async function runMuseQueueJob(job: Job): Promise<string[]> {
  if (job.params.agent_scenes?.length || job.params.continue_from || job.params.edit_asset) {
    throw new Error("This job requires Google Flow. Switch to Google Flow in the platform picker, or use a simple image/video scene.");
  }
  if ((job.params.reference_images ?? []).some((r) => r.startsWith("asset:"))) {
    throw new Error("Muse mode does not support Flow asset: references. Use a local image path in reference_images.");
  }
  const { runMuseJob } = await import("./run-job.js");
  return runMuseJob(job);
}