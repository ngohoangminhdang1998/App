import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR } from "./chrome.js";
import { LocalCore, OUTPUT_ROOT, shapes, type Core } from "./core.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const TOKEN_FILE = join(HOME_DIR, "token");
const TOKEN_BYTES = 24;

function loadOrCreateToken(): string {
  if (process.env.FLOW_MCP_NEW_TOKEN === "1") return randomBytes(TOKEN_BYTES).toString("hex");
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{48}$/i.test(existing)) return existing;
  } catch {
    /* no saved session token yet */
  }
  return randomBytes(TOKEN_BYTES).toString("hex");
}
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const STUDIO_ASSETS = fileURLToPath(new URL("../studio/assets", import.meta.url));
const STUDIO_FAVICON = join(STUDIO_ASSETS, "favicon-32.png");
const FILM_SCRIPT = fileURLToPath(new URL("../dist/film-script.js", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

/** HTTPS Studio on Vercel may call this loopback API (Private Network Access + token). */
function studioCorsAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (/^https:\/\/([\w-]+\.)*vercel\.app$/i.test(origin)) return true;
  const extra = (process.env.FLOW_MCP_STUDIO_ORIGINS ?? "https://tedverse.vercel.app")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

function applyStudioCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && studioCorsAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-flow-token, range");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(origin && studioCorsAllowed(origin) ? 204 : 403);
    res.end();
    return true;
  }
  return false;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// owns the port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
export async function startServer(core: Core): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = loadOrCreateToken();
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const server = createServer(async (req, res) => {
    try {
      // The Host check blocks DNS-rebinding; the token blocks other local pages from driving the queue.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      if (applyStudioCors(req, res)) return;
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { name: "flow-mcp" });
      // Lets an open Studio tab pick up the token after the owner restarts (localhost only; same Host check as above).
      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        const { getActiveProviderId } = await import("./providers/platform-config.js");
        const { providerPayload } = await import("./providers/registry.js");
        const provider = getActiveProviderId();
        return json(res, 200, { token, port: PORT, provider, capabilities: providerPayload(provider).capabilities });
      }
      if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
        if (!existsSync(STUDIO_FAVICON)) return void res.writeHead(204).end();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        return res.end(readFileSync(STUDIO_FAVICON));
      }
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const rel = url.pathname.slice("/assets/".length);
        if (!rel || rel.includes("..") || rel.includes("/") || rel.includes("\\")) return json(res, 404, { error: "Not found." });
        const file = join(STUDIO_ASSETS, rel);
        if (!inside(file, STUDIO_ASSETS) || !existsSync(file)) return json(res, 404, { error: "Not found." });
        const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=604800" });
        return createReadStream(file).pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }
      if (req.method === "GET" && url.pathname === "/film-script.js") {
        if (!existsSync(FILM_SCRIPT)) return json(res, 404, { error: "film-script.js is missing. Run npm run build." });
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(FILM_SCRIPT));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return "owner";
  }
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // busy inside a Playwright call, so one 2 s health check timing out proves nothing.
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return "client";
    // A valid answer from something that is NOT us means the port belongs to an unrelated program, and driving Flow
    // locally is safe.
    if (other) return "none";
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
  // calls fail loudly is far better than a second process silently spending the user's credits.
  return "client";
}
