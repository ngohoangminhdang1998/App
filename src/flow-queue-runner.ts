/**
 * Google Flow job runner only — unchanged pipeline (chain, agent, edit, runGeneration).
 * Imported only from provider dispatch when Flow is active.
 */
import { extractFirstFrame, extractFrameAt, extractLastFrame } from "./chain.js";
import { runAgentBatch, runContinue, runEdit, runGeneration } from "./flow.js";
import { isLocalClip } from "./media-ref.js";
import type { Job, JobQueue } from "./queue.js";

type ReleaseFile = (path: string) => void;
type FetchStaging = (flowProjectId: string, handle: string) => Promise<string>;

export async function runFlowQueueJob(
  job: Job,
  queue: JobQueue,
  deps: { releaseEphemeralFile: ReleaseFile; fetchFlowVideoStaging: FetchStaging },
): Promise<string[]> {
  const { chain_from, reference_from } = job.params;
  if (reference_from) {
    const prev = queue.get(reference_from);
    const still = prev?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
    if (still) {
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    } else {
      const flow = prev?.flow_assets?.[0];
      if (!flow?.id) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image on Flow.`);
      const ref = flow.id.startsWith("title:") ? flow.id : flow.title ? `title:${flow.title}` : flow.id;
      job.params.reference_images = [ref, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
  }
  const ff = job.params.first_frame;
  if (ff && isLocalClip(ff))
    job.params.first_frame = job.params.first_frame_at !== undefined ? await extractFrameAt(ff, job.params.first_frame_at) : await extractLastFrame(ff);
  const lf = job.params.last_frame;
  if (lf && isLocalClip(lf)) job.params.last_frame = await extractFirstFrame(lf);
  if (chain_from) {
    const prev = queue.get(chain_from);
    const clip = prev?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
    if (clip) {
      job.params.first_frame = await extractLastFrame(clip);
    } else {
      const flow = prev?.flow_assets?.[0];
      if (!flow?.id || !flow.project_id) {
        throw new Error(`chain_previous: the previous scene (${chain_from}) has no video on Flow.`);
      }
      const clipPath = await deps.fetchFlowVideoStaging(flow.project_id, flow.id);
      try {
        job.params.first_frame = await extractLastFrame(clipPath);
      } finally {
        deps.releaseEphemeralFile(clipPath);
      }
    }
  }
  if (job.params.continue_from) return runContinue(job);
  if (job.params.agent_scenes) return runAgentBatch(job);
  if (job.params.edit_asset) return runEdit(job);
  return runGeneration(job);
}