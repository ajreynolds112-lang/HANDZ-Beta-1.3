/**
 * The tuned parameter defaults that ship with a build.
 *
 * The Neural Network screen keeps every tunable in the browser's localStorage,
 * which is per-browser and would be empty for anyone opening the published
 * site. So the workspace writes its current bundle to `data/tuned-defaults.json`
 * and the server inlines that file into the page as `window.__HANDZ_TUNED__`;
 * the client seeds it into localStorage before it boots. Tweak in the
 * workspace, publish, and the published app opens on those numbers.
 *
 * Deliberately a file inlined into the HTML rather than a module the client
 * imports: it sits outside `client/`, so writing it never trips the dev
 * server's watcher and reloads the page out from under whoever is tuning.
 *
 * Writes only happen in development. A published server is short-lived and can
 * be replaced or scaled at any time, so anything written there would vanish;
 * the file has to change in the workspace and go out with the next publish.
 */
import fs from "fs";
import path from "path";

const DEFAULTS_FILE = path.resolve(process.cwd(), "data", "tuned-defaults.json");

/** The stored bundle, or null when there is nothing (yet) to hand over. */
export function readTunedDefaults(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const params = (parsed as Record<string, unknown>).params;
    if (!params || typeof params !== "object" || Object.keys(params).length === 0) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeTunedDefaults(bundle: unknown): void {
  fs.mkdirSync(path.dirname(DEFAULTS_FILE), { recursive: true });
  fs.writeFileSync(DEFAULTS_FILE, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8");
}

/**
 * Put the bundle in the page ahead of the app's own script. Every `<` is
 * escaped, so a parameter whose value contains `</script>` can't end the tag.
 */
export function injectTunedDefaults(html: string): string {
  const bundle = readTunedDefaults();
  if (!bundle) return html;
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  const tag = `<script>window.__HANDZ_TUNED__=${json};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}
