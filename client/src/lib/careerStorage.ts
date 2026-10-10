import { isCareerStorageKey } from "@shared/cloudSave";
import { reloadScaling } from "./scalingConfig";

/** Private local backups stay outside portable downloads and cloud payloads. */
export function captureCareerStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isCareerStorageKey(key)) snapshot[key] = localStorage.getItem(key)!;
  }
  return snapshot;
}

export function replaceCareerStorage(snapshot: Record<string, string>): void {
  if (Object.entries(snapshot).some(([key, value]) => !isCareerStorageKey(key) || typeof value !== "string")) {
    throw new Error("Invalid local career backup.");
  }
  const previous = captureCareerStorage();
  const apply = (values: Record<string, string>) => {
    for (const key of Object.keys(captureCareerStorage())) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  };
  try { apply(snapshot); }
  catch (error) { apply(previous); throw error; }
  finally { reloadScaling(); }
}
