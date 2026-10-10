import type { Express, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "./db";
import { cloudWriteSchema } from "@shared/cloudSave";
import { getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";

/** No client-supplied owner: every query scopes directly to the verified Clerk user. */
export async function registerCloudSaves(app: Express): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS career_cloud_saves (
    user_id text PRIMARY KEY,
    save jsonb,
    revision integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  const requireAccount: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!getAuth(req).userId) {
      res.status(401).json({ error: "Sign in to access your cloud career." });
      return;
    }
    next();
  };
  const writes = new Map<string, { since: number; count: number }>();
  const writeGuard: RequestHandler = (req, res, next) => {
    try {
      const origin = req.get("origin");
      if (!origin || new URL(origin).host !== getClerkProxyHost(req)) {
        res.status(403).json({ error: "Cloud saves require a same-origin request." });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin." });
      return;
    }
    const now = Date.now();
    writes.forEach((entry, id) => { if (now - entry.since >= 60_000) writes.delete(id); });
    const id = getAuth(req).userId!;
    const entry = writes.get(id) ?? { since: now, count: 0 };
    writes.set(id, entry);
    if (++entry.count > 40) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many saves. Try again in a minute." });
      return;
    }
    next();
  };

  app.get("/api/cloud-save", requireAccount, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT save, revision, updated_at FROM career_cloud_saves WHERE user_id = $1",
        [getAuth(req).userId],
      );
      const row = rows[0];
      res.json({ save: row?.save ?? null, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null });
    } catch (error) { next(error); }
  });

  app.put("/api/cloud-save", requireAccount, writeGuard, async (req, res, next) => {
    const parsed = cloudWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    try {
      const { save, revision } = parsed.data;
      // A revision-zero write creates only; all subsequent writes compare-and-swap.
      const result = revision === 0
        ? await pool.query(`INSERT INTO career_cloud_saves (user_id, save)
            VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING revision, updated_at`,
            [getAuth(req).userId, JSON.stringify(save)])
        : await pool.query(`UPDATE career_cloud_saves SET save = $2::jsonb,
            revision = revision + 1, updated_at = now()
            WHERE user_id = $1 AND revision = $3 RETURNING revision, updated_at`,
            [getAuth(req).userId, JSON.stringify(save), revision]);
      if (!result.rows[0]) {
        res.status(409).json({ error: "This career changed on another tab or device. Reload the cloud career before replacing it." });
        return;
      }
      const row = result.rows[0];
      res.json({ revision: row.revision, updatedAt: row.updated_at });
    } catch (error) { next(error); }
  });
}
