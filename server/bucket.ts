import { Client } from "@replit/object-storage";

/**
 * The App Storage bucket is the one store the workspace build and the live
 * build share (their databases and Clerk users are separate).
 */
export type BuildEnv = "dev" | "live";
export const HERE: BuildEnv = process.env.REPLIT_DEPLOYMENT ? "live" : "dev";

let client: Client | null = null;
export const bucket = () => client ??= new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID });
