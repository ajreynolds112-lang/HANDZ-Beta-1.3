import { createHash } from "crypto";
import { clerkClient } from "@clerk/express";
import { bucket, HERE, type BuildEnv } from "./bucket";

/**
 * The workspace build and the live build use separate databases and separate
 * Clerk users, but share one App Storage bucket. Each build mirrors its
 * account careers there, keyed by verified email, so Sync can pull the other
 * build's career.
 */
type Env = BuildEnv;
const OTHER: Env = HERE === "live" ? "dev" : "live";
const storage = bucket;

const emails = new Map<string, string | null>();
async function verifiedEmail(userId: string): Promise<string | null> {
  if (emails.has(userId)) return emails.get(userId)!;
  const user = await clerkClient.users.getUser(userId);
  const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
  const email = primary?.verification?.status === "verified" ? primary.emailAddress.trim().toLowerCase() : null;
  emails.set(userId, email);
  return email;
}
const keyFor = (env: Env, email: string) =>
  `career-mirror/${env}/${createHash("sha256").update(email).digest("hex")}.json`;

// Latest-wins: one upload in flight per user; saves landing meanwhile collapse into one follow-up.
const inFlight = new Set<string>();
const queued = new Map<string, { save: unknown; updatedAt: string }>();
export function mirrorCareer(userId: string, save: unknown, updatedAt: string): void {
  queued.set(userId, { save, updatedAt });
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  void (async () => {
    try {
      for (let next = queued.get(userId); next; next = queued.get(userId)) {
        queued.delete(userId);
        const email = await verifiedEmail(userId);
        if (!email) break;
        const res = await storage().uploadFromText(keyFor(HERE, email), JSON.stringify(next));
        if (!res.ok) console.error("[career-mirror] upload failed:", res.error);
      }
    } catch (error) {
      console.error("[career-mirror] upload failed:", error);
    } finally {
      inFlight.delete(userId);
    }
  })();
}

/** The other build's mirrored career for this user's verified email, if any. */
export async function readOtherCareer(userId: string): Promise<{ save: unknown; updatedAt: string; source: Env } | null> {
  const email = await verifiedEmail(userId);
  if (!email) return null;
  const key = keyFor(OTHER, email);
  const exists = await storage().exists(key);
  if (!exists.ok || !exists.value) return null;
  const res = await storage().downloadAsText(key);
  if (!res.ok) throw new Error("Could not read the other build's career.");
  const data = JSON.parse(res.value) as { save: unknown; updatedAt: string };
  return { ...data, source: OTHER };
}
