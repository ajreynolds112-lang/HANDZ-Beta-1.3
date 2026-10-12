import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { injectTunedDefaults } from "./tuningDefaults";
import { liveTrainingRev, liveTunedBundle, liveTuningRev } from "./liveTuning";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // The page carries the tuned parameter defaults inline: the workspace's
  // newest live bundle when one is published, else the build's. Rebuilt only
  // when that bundle changes.
  let page: string | null = null;
  let pageRev: string | null = null;
  const sendIndex = (_req: Request, res: Response) => {
    const rev = liveTuningRev();
    if (page === null || rev !== pageRev) {
      page = injectTunedDefaults(fs.readFileSync(path.resolve(distPath, "index.html"), "utf-8"), liveTunedBundle(), {
        __HANDZ_TUNED_LIVE_REV__: rev,
        __HANDZ_TRAINING_REV__: liveTrainingRev(),
      });
      pageRev = rev;
    }
    res.status(200).type("html").send(page);
  };

  // Ahead of express.static, and with its own index disabled, so the built
  // index.html is never served raw.
  app.get("/", sendIndex);
  app.get("/index.html", sendIndex);

  app.use(express.static(distPath, { index: false }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", sendIndex);
}
