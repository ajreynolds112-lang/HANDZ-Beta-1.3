import { z } from "zod";

export const MAX_CLOUD_SAVE_BYTES = 20 * 1024 * 1024;
export const IMPORT_CONFIRMATIONS = ["replace-career", "replace-cloud-save"] as const;
export const isCareerStorageKey = (key: string) =>
  key.startsWith("handz_") && !key.startsWith("handz_cloud_");

const fighterSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  archetype: z.string().min(1).max(50),
  level: z.number().int().min(1).max(1_000_000),
  xp: z.number().finite().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  knockouts: z.number().int().nonnegative(),
  skillPoints: z.object({
    power: z.number().finite(),
    speed: z.number().finite(),
    defense: z.number().finite(),
    stamina: z.number().finite(),
    focus: z.number().finite().optional(),
  }).passthrough().nullable(),
}).passthrough();

function safeData(value: unknown, depth = 0): boolean {
  if (depth > 60) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) =>
    !["__proto__", "prototype", "constructor"].includes(key) && safeData(child, depth + 1));
}

export const careerSaveSchema = z.unknown().superRefine((value, ctx) => {
  if (!safeData(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The file contains invalid data." });
}).pipe(z.object({
  version: z.literal(1),
  fighter: fighterSchema,
  fightResults: z.array(z.object({}).passthrough()).max(100_000),
  browserState: z.record(z.string()).optional(),
  tuning: z.record(z.unknown()).optional(),
}).passthrough().superRefine((save, ctx) => {
  for (const key of Object.keys(save.browserState ?? {})) {
    if (!isCareerStorageKey(key) || key === "handz_career_pins" || key === "handz_career_pin_locks") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The file contains private or invalid browser settings." });
      break;
    }
  }
}));

export function validateCareerSave(data: unknown) {
  const result = careerSaveSchema.safeParse(data);
  if (!result.success) throw new Error("Invalid HANDZ career save: " + result.error.issues[0].message);
  if (new TextEncoder().encode(JSON.stringify(result.data)).length > MAX_CLOUD_SAVE_BYTES) {
    throw new Error("The career save exceeds the 20 MB limit.");
  }
  return result.data;
}

export const cloudWriteSchema = z.object({
  revision: z.number().int().nonnegative(),
  save: careerSaveSchema.nullable(),
  reason: z.enum(["autosave", "import"]),
  confirmations: z.tuple([z.literal(IMPORT_CONFIRMATIONS[0]), z.literal(IMPORT_CONFIRMATIONS[1])]).optional(),
}).superRefine((write, ctx) => {
  if (write.reason === "import" && (!write.confirmations || !write.save)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Both replacement confirmations are required." });
  }
});
