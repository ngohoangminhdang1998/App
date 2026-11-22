import assert from "node:assert/strict";
import { sceneAction, queueGate, parseFilmScript } from "../dist/film-script.js";

assert.equal(sceneAction({ selected: true, status: "completed", prompt: "ok", jobId: "" }, { spent: 40, next: 10, budget: 300 }), "skip");
assert.equal(sceneAction({ selected: true, status: "pending", prompt: "ok", jobId: "" }, { spent: 40, next: 10, budget: 300 }), "submit");
assert.equal(sceneAction({ selected: true, status: "failed", prompt: "ok", jobId: "" }, { spent: 40, next: 10, budget: 300 }), "submit");
assert.equal(sceneAction({ selected: true, status: "generating", prompt: "ok", jobId: "abc" }, { spent: 0, next: 10, budget: 300 }), "poll");
assert.equal(queueGate(false, true), "stop");
assert.equal(queueGate(false, false), "go");

const script = `=== SCENE 001 ===\nFirst shot.\n\n=== SCENE 002 ===\nSecond shot.`;
const parsed = parseFilmScript(script);
assert.equal(parsed.scenes.length, 2);
const rows = parsed.scenes.map((s, i) => ({
  selected: true,
  status: i === 0 ? "completed" : "pending",
  prompt: s.prompt,
  jobId: "",
  file: i === 0 ? "scene-01.mp4" : "",
}));
const todo = rows.filter((s) => {
  if (!s.selected || s.status === "skipped" || !s.prompt.trim()) return false;
  if (s.status === "generated_on_flow") return false;
  if (s.status === "completed") return false;
  return true;
});
assert.equal(todo.length, 1);
assert.equal(sceneAction(rows[0], { spent: 7, next: 7, budget: 300 }), "skip");
assert.equal(sceneAction(rows[1], { spent: 7, next: 7, budget: 300 }), "submit");

const failed = { ...rows[1], status: "failed" };
assert.equal(sceneAction(failed, { spent: 7, next: 7, budget: 300 }), "submit");
const afterRetry = { ...failed, status: "pending" };
assert.equal(sceneAction(afterRetry, { spent: 7, next: 7, budget: 300 }), "submit");

console.log("film-oneclick tests passed");