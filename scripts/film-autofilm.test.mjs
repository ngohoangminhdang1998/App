import assert from "node:assert/strict";
import { sceneAction, sceneReadyOnFlow } from "../dist/film-script.js";
import { jobView } from "../dist/core.js";

assert.equal(sceneReadyOnFlow({ status: "generated_on_flow", flowTitle: "MyFilm-scene-01" }), true);
assert.equal(sceneReadyOnFlow({ status: "failed", flowTitle: "x" }), false);
assert.equal(sceneReadyOnFlow({ status: "download_failed", flowTitle: "MyFilm-scene-01" }), true);

assert.equal(sceneAction({ selected: true, status: "generated_on_flow", prompt: "ok", jobId: "", flowTitle: "A" }, { spent: 0, next: 7, budget: 300 }), "skip");

const view = jobView({
  id: "test01",
  status: "done",
  params: {
    prompt: "p",
    type: "video",
    max_credits: 7,
    output_dir: "/tmp/AutoTest",
    file_stem: "scene-01",
    skip_download: true,
  },
  files: [],
  flow_assets: [{ id: "title:AutoTest-scene-01", title: "AutoTest-scene-01", project_id: "00000000-0000-0000-0000-000000000001" }],
  attempts: 1,
  createdAt: new Date().toISOString(),
});
assert.equal(view.skip_download, true);
assert.equal(view.flow_assets?.[0]?.title, "AutoTest-scene-01");
assert.equal(view.files.length, 0);

console.log("film-autofilm.test.mjs OK");