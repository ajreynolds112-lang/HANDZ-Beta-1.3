// Shared PIN authentication used to gate admin-only editors (Neural Network, Punch Animation)
// wherever they're surfaced in the app. Keeping this in one place ensures every entry point
// (Career Hub Neural view, in-fight Pause menu, etc.) checks the exact same PIN set.

export const ADMIN_PIN = "7342";
export const PIN_STORAGE_KEY = "handz_career_pins";

export function getCareerPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return [];
    const store = JSON.parse(raw);
    return Object.values(store).filter((v): v is string => typeof v === "string" && v.length === 4);
  } catch {
    return [];
  }
}

export function isValidPin(pin: string): boolean {
  if (pin === ADMIN_PIN) return true;
  const careerPins = getCareerPins();
  return careerPins.includes(pin);
}
