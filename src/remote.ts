import { readFileSync } from "node:fs";
import { captionPreviewHere, captionSetupHere, captionsHere, narrateHere, presenterHere, transcribeHere, voicesHere, type Core } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";

// Used when another flow-mcp process (Studio or a second Claude client) already owns the Flow tab and queue.
async function call(method: string, args: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flow-token": readFileSync(TOKEN_FILE, "utf8").trim() },
    body: JSON.stringify(args ?? {}),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `flow-mcp owner process answered ${res.status}`);
  return data;
}

export class RemoteCore implements Core {
  status = (a: unknown) => call("status", a);
  generate = (a: unknown) => call("generate", a);
  cancel = (a: unknown) => call("cancel", a);
  retry = (a: unknown) => call("retry", a);
  assets = (a: unknown) => call("assets", a);
  download = (a: unknown) => call("download", a);
  repair_downloads = (a: unknown) => call("repair_downloads", a);
  redownload = (a: unknown) => call("redownload", a);
  assemble = (a: unknown) => call("assemble", a);
  techniques = (a: unknown) => call("techniques", a);
  // Run here, not in the owner: they never touch Chrome, and the owner may be running older code.
  voices = voicesHere;
  narrate = narrateHere;
  new_project = (a: unknown) => call("new_project", a);
  character = (a: unknown) => call("character", a);
  characters = () => call("characters", {});
  picker_list = () => call("picker_list", {});
  character_edit = (a: unknown) => call("character_edit", a);
  edit = (a: unknown) => call("edit", a);
  trash = (a: unknown) => call("trash", a);
  discard = (a: unknown) => call("discard", a);
  set_key = (a: unknown) => call("set_key", a);
  continue_shot = (a: unknown) => call("continue_shot", a);
  agent = (a: unknown) => call("agent", a);
  outputs = () => call("outputs", {});
  publish_options = (a: unknown) => call("publish_options", a);
  publish = (a: unknown) => call("publish", a);
  publish_status = (a: unknown) => call("publish_status", a);
  publish_retry = (a: unknown) => call("publish_retry", a);
  publish_history = (a: unknown) => call("publish_history", a ?? {});
  publish_settings_get = () => call("publish_settings_get", {});
  publish_settings_save = (a: unknown) => call("publish_settings_save", a);
  publish_oauth_begin = (a: unknown) => call("publish_oauth_begin", a);
  publish_oauth_disconnect = (a: unknown) => call("publish_oauth_disconnect", a);
  open_local_path = (a: unknown) => call("open_local_path", a);
  flow_merge = (a: unknown) => call("flow_merge", a);
  flow_composition = (a: unknown) => call("flow_composition", a);
  flow_recover_film_scenes = (a: unknown) => call("flow_recover_film_scenes", a);
  flow_projects = (a: unknown) => call("flow_projects", a ?? {});
  provider_info = () => call("provider_info", {});
  provider_select = (a: unknown) => call("provider_select", a);
  muse_status = () => call("muse_status", {});
  muse_open_login = (a: unknown) => call("muse_open_login", a ?? {});
  film_allocate = () => call("film_allocate", {});
  film_next_from_history = () => call("film_next_from_history", {});
  film_numbers = () => call("film_numbers", {});
  film_peek_no = () => call("film_peek_no", {});
  film_ensure_next = (a: unknown) => call("film_ensure_next", a);
  film_history = (a?: unknown) => call("film_history", a ?? {});
  film_history_delete = (a?: unknown) => call("film_history_delete", a ?? {});
  film_template_export = (a?: unknown) => call("film_template_export", a ?? {});
  film_template_import = (a: unknown) => call("film_template_import", a);
  // Captions, like narration, run here: they never touch the Flow Chrome.
  transcribe = transcribeHere;
  caption_preview = captionPreviewHere;
  captions = captionsHere;
  presenter = presenterHere;
  caption_setup = captionSetupHere;

  // Long waits are split up so no single HTTP request outlives fetch's header timeout.
  async wait(a: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await call("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}
