import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// Everything that differs between macOS, Windows and Linux lives here, so the rest of the code stays the same on all
// three. macOS is the tested platform; the Windows and Linux branches are written to each system's own documented
// tools but have not been run on a real machine yet.
export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

// How the panel names this computer and its bin, so nothing says "Mac" on a PC.
export const COMPUTER = IS_MAC ? "this Mac" : IS_WIN ? "this PC" : "this computer";
export const BIN = IS_MAC ? "the Mac's Trash" : IS_WIN ? "the Recycle Bin" : "the Trash";

export const FFMPEG_HINT = IS_MAC
  ? "brew install ffmpeg (or static builds: evermeet.cx/ffmpeg)"
  : IS_WIN
    ? "winget install Gyan.FFmpeg"
    : "sudo apt install ffmpeg";

const binCache: Partial<Record<"ffmpeg" | "ffprobe", string>> = {};

function toolRuns(path: string): boolean {
  try {
    execFileSync(path, ["-version"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function winFfmpegCandidates(name: "ffmpeg" | "ffprobe"): string[] {
  const exe = `${name}.exe`;
  const roots = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "ffmpeg", "bin", exe),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "ffmpeg", "bin", exe),
    join("C:", "ffmpeg", "bin", exe),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", exe),
  ];
  const winget = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (existsSync(winget)) {
    for (const pkg of readdirSync(winget)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pkgRoot = join(winget, pkg);
      for (const entry of readdirSync(pkgRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        roots.push(join(pkgRoot, entry.name, "bin", exe));
      }
    }
  }
  try {
    const found = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
    roots.push(...found);
  } catch {
    /* not on PATH */
  }
  return [...new Set(roots)];
}

/** Resolves ffmpeg/ffprobe on Windows (WinGet often installs without updating PATH for Node). */
export function resolveFfmpegBinary(name: "ffmpeg" | "ffprobe"): string {
  if (binCache[name]) return binCache[name]!;
  const env = name === "ffmpeg" ? process.env.FLOW_MCP_FFMPEG : process.env.FLOW_MCP_FFPROBE;
  if (env && toolRuns(env)) {
    binCache[name] = env;
    return env;
  }
  if (IS_WIN) {
    for (const candidate of winFfmpegCandidates(name)) {
      if (candidate && existsSync(candidate) && toolRuns(candidate)) {
        binCache[name] = candidate;
        return candidate;
      }
    }
  } else if (toolRuns(name)) {
    binCache[name] = name;
    return name;
  }
  binCache[name] = name;
  return name;
}

// PowerShell single-quoted string: the only character that needs escaping is the quote itself.
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

// Puts a file or folder in the system's own bin so it can be restored: the Mac's Trash, Windows' Recycle Bin, or the
// freedesktop Trash on Linux. Never deletes anything outright.
export function moveToBin(target: string): string {
  if (IS_MAC) {
    const bin = join(homedir(), ".Trash");
    const name = basename(target);
    const ext = extname(name);
    const dest = existsSync(join(bin, name)) ? join(bin, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`) : join(bin, name);
    renameSync(target, dest);
    return dest;
  }
  if (IS_WIN) {
    const kind = statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    );
    return BIN;
  }
  try {
    execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return BIN;
  } catch {
    const bin = join(homedir(), ".local", "share", "Trash", "files");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${Date.now()}`);
    renameSync(target, dest);
    return dest;
  }
}

// Unpacks a ZIP with the system's own tools: tar on macOS and Windows 10+ is bsdtar, which reads ZIPs; unzip is the
// fallback (Linux, older Windows). Returns every file inside, however deeply the archive nested them.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  return files;
}

/** Opens a local file with the OS default app (video player, etc.). */
export function openPath(file: string): void {
  try {
    if (IS_MAC) execFileSync("open", [file], { stdio: "ignore" });
    else if (IS_WIN) execFileSync("cmd", ["/c", "start", "", file], { stdio: "ignore", windowsHide: true });
    else execFileSync("xdg-open", [file], { stdio: "ignore" });
  } catch {
    try {
      openUrl(IS_WIN ? file : `file://${file}`);
    } catch {
      /* best-effort */
    }
  }
}

// Opens a page in the default browser.
export function openUrl(url: string): void {
  try {
    if (IS_MAC) execFileSync("open", [url], { stdio: "ignore" });
    else if (IS_WIN) execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // Opening the browser is a convenience; the address is printed either way.
  }
}
