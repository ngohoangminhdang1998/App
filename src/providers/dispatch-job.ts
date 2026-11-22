import { runFlowQueueJob } from "../flow-queue-runner.js";
import type { Job, JobQueue } from "../queue.js";
import { isMuseProvider } from "./active.js";

type FlowDeps = Parameters<typeof runFlowQueueJob>[2];

/** Generation queue entry: Flow path is default; Muse loads only when provider.json says muse. */
export async function dispatchGenerationJob(job: Job, queue: JobQueue, flowDeps: FlowDeps): Promise<string[]> {
  if (isMuseProvider()) {
    const { runMuseQueueJob } = await import("./muse/queue-job.js");
    return runMuseQueueJob(job);
  }
  return runFlowQueueJob(job, queue, flowDeps);
}