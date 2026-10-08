/**
 * "Push to GitHub" on the Neural Network screen: commits the workspace's
 * source files to the HANDZ repo through the Replit GitHub connector.
 *
 * The repo's history is unrelated to local git (it was uploaded through the
 * web), so this pushes by tree diff: hash every local file, compare with the
 * remote tree, upload only what differs, commit on top of the remote head.
 * Workspace-only: a published server's filesystem isn't the source.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const REPO = "/repos/ajreynolds112-lang/HANDZ-Beta-1.3";
const BRANCH = "main";
const ROOT = process.cwd();
/** Never pushed: agent/workspace config the repo deliberately leaves out. */
const EXCLUDE = [/^\.agents\//, /^\.local\//, /^\.replit$/, /^\.gitignore$/, /^\.config\//, /^\.cache\//];
/** Remote files absent locally are deleted only under these source roots. */
const SOURCE_ROOTS = /^(client|server|shared|script|scripts|data)\//;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class GithubPushError extends Error {
  constructor(message: string, readonly status = 500) { super(message); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function gh<T = any>(apiPath: string, body?: unknown, method?: string): Promise<T> {
  const connectors = new ReplitConnectors();
  const m = method ?? (body === undefined ? "GET" : "POST");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await connectors.proxy("github", apiPath, body === undefined
        ? { method: m }
        : { method: m, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (err) {
      throw new GithubPushError(`Can't reach GitHub: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
    // The connector proxy is rate-limited per workspace.
    if (res.status === 429 && attempt < 20) { await sleep(1200); continue; }
    const text = await res.text();
    if (!res.ok) throw new GithubPushError(`GitHub ${m} ${apiPath.replace(REPO, "")} failed (${res.status}): ${text.slice(0, 200)}`, 502);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Reachability of the repo through the connector, for the button's online state. */
export async function githubStatus(): Promise<{ online: boolean; reason?: string }> {
  try {
    await gh(REPO);
    return { online: true };
  } catch (err) {
    return { online: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\u0000/g, ".*");
  return new RegExp(glob.includes("/") ? `^${esc}$` : `(^|/)${esc}$`);
}

function nyTimestamp(d = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ET`;
}

/** One push or import at a time: they read and write the same files. */
let pushing = false;

export interface GithubPushResult { changed: number; deleted: number; commit?: string; url?: string; }

/** Local file hashes and the remote head/tree, for diffing either way. */
async function snapshot() {
    // Local files: tracked + untracked, minus ignored and excluded.
    const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 64 << 20 })
      .toString().split("\0").filter(Boolean)
      .filter(p => !EXCLUDE.some(re => re.test(p)))
      .filter(p => { try { const st = fs.statSync(path.join(ROOT, p)); return st.isFile() && st.size <= MAX_FILE_BYTES; } catch { return false; } });
    const shas = listed.length
      ? execFileSync("git", ["hash-object", "--no-filters", "--stdin-paths"], { cwd: ROOT, input: listed.join("\n"), maxBuffer: 64 << 20 }).toString().trim().split("\n")
      : [];
    const local = new Map(listed.map((p, i) => [p, shas[i]]));

    const ref = await gh<{ object: { sha: string } }>(`${REPO}/git/refs/heads/${BRANCH}`);
    const head = await gh<{ tree: { sha: string } }>(`${REPO}/git/commits/${ref.object.sha}`);
    const tree = await gh<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(`${REPO}/git/trees/${head.tree.sha}?recursive=1`);
    if (tree.truncated) throw new GithubPushError("The repo tree is too large to diff in one request.");
    const remote = new Map(tree.tree.filter(e => e.type === "blob").map(e => [e.path, e.sha]));

    // Git LFS paths are never overwritten with raw content or deleted.
    let lfs: RegExp[] = [];
    const attrsSha = remote.get(".gitattributes");
    if (attrsSha) {
      const blob = await gh<{ content: string }>(`${REPO}/git/blobs/${attrsSha}`);
      lfs = Buffer.from(blob.content, "base64").toString("utf8").split("\n")
        .map(l => l.trim()).filter(l => l && !l.startsWith("#") && /filter=lfs/.test(l))
        .map(l => globToRegex(l.split(/\s+/)[0]));
    }
    const isLfs = (p: string) => lfs.some(re => re.test(p));

    return { local, ref, head, remote, isLfs };
}

export async function pushSourceToGithub(message: string): Promise<GithubPushResult> {
  if (pushing) throw new GithubPushError("A push or import is already running.", 409);
  pushing = true;
  try {
    const { local, ref, head, remote, isLfs } = await snapshot();

    const changed = Array.from(local).filter(([p, sha]) => remote.get(p) !== sha && !isLfs(p)).map(([p]) => p);
    const deleted = Array.from(remote.keys()).filter(p => SOURCE_ROOTS.test(p) && !local.has(p) && !isLfs(p));
    if (changed.length === 0 && deleted.length === 0) return { changed: 0, deleted: 0 };

    const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] =
      deleted.map(p => ({ path: p, mode: "100644", type: "blob", sha: null }));
    let next = 0;
    const worker = async () => {
      while (next < changed.length) {
        const p = changed[next++];
        const abs = path.join(ROOT, p);
        const blob = await gh<{ sha: string }>(`${REPO}/git/blobs`, { content: fs.readFileSync(abs).toString("base64"), encoding: "base64" });
        const mode = (fs.statSync(abs).mode & 0o111) ? "100755" : "100644";
        entries.push({ path: p, mode, type: "blob", sha: blob.sha });
        await sleep(250);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));

    const summary = message.trim() || `Update from the Neural Network screen (${changed.length} changed, ${deleted.length} deleted)`;
    const newTree = await gh<{ sha: string }>(`${REPO}/git/trees`, { base_tree: head.tree.sha, tree: entries });
    const commit = await gh<{ sha: string; html_url: string }>(`${REPO}/git/commits`, { message: summary, tree: newTree.sha, parents: [ref.object.sha] });
    await gh(`${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha }, "PATCH");
    const description = `Last update: ${nyTimestamp()} — ${summary}`.slice(0, 350);
    await gh(REPO, { description }, "PATCH");
    return { changed: changed.length, deleted: deleted.length, commit: commit.sha.slice(0, 7), url: commit.html_url };
  } finally {
    pushing = false;
  }
}

/** Remote-only upload artifacts that never belong in the workspace. */
const IMPORT_SKIP = /(^|\/)(\.DS_Store|\.gitattributes)$/;

export interface GithubImportResult {
  updated: string[]; added: string[]; deleted: string[];
  applied: boolean; commit?: string; installed?: boolean; serverChanged?: boolean;
}

/**
 * Make the workspace match the repo: write every file that differs, add new
 * ones, and delete source files the repo no longer has. `dryRun` only reports
 * what would change, so the screen can confirm first. Agent/workspace config
 * and Git LFS files are never touched.
 */
export async function importFromGithub(dryRun: boolean): Promise<GithubImportResult> {
  if (pushing) throw new GithubPushError("A push or import is already running.", 409);
  pushing = true;
  try {
    const { local, ref, remote, isLfs } = await snapshot();
    const wanted = Array.from(remote).filter(([p]) => !EXCLUDE.some(re => re.test(p)) && !IMPORT_SKIP.test(p) && !isLfs(p));
    const updated = wanted.filter(([p, sha]) => local.has(p) && local.get(p) !== sha).map(([p]) => p);
    const added = wanted.filter(([p]) => !local.has(p) && !fs.existsSync(path.join(ROOT, p))).map(([p]) => p);
    const deleted = Array.from(local.keys()).filter(p => SOURCE_ROOTS.test(p) && !remote.has(p));
    const result: GithubImportResult = { updated, added, deleted, applied: false, commit: ref.object.sha.slice(0, 7) };
    if (dryRun || (updated.length + added.length + deleted.length) === 0) return result;

    // Download everything before writing anything, so a failed fetch leaves the workspace untouched.
    const toWrite = updated.concat(added);
    const contents = new Map<string, Buffer>();
    let next = 0;
    const worker = async () => {
      while (next < toWrite.length) {
        const p = toWrite[next++];
        const blob = await gh<{ content: string }>(`${REPO}/git/blobs/${remote.get(p)}`);
        contents.set(p, Buffer.from(blob.content, "base64"));
        await sleep(250);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));

    for (const [p, buf] of Array.from(contents)) {
      const abs = path.join(ROOT, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    for (const p of deleted) fs.rmSync(path.join(ROOT, p), { force: true });
    result.applied = true;

    const touched = toWrite.concat(deleted);
    if (touched.some(p => p === "package.json" || p === "package-lock.json")) {
      try {
        execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "ignore", timeout: 240_000 });
        result.installed = true;
      } catch {
        result.installed = false;
      }
    }
    result.serverChanged = touched.some(p => /^(server|shared)\//.test(p) || p === "package.json");
    return result;
  } finally {
    pushing = false;
  }
}
