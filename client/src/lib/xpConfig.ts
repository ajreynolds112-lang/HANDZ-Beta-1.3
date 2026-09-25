export const XP_CONFIG_KEY = "handz_xp_config";
export const XP_DEFAULTS_KEY = "handz_xp_defaults";

export interface XpConfig {
  boutBase: number;
  careerMult: number;
  careerOpponentMult: number;
  careerOpponentPowerMult: number;
  careerOpponentSpeedMult: number;
  careerPlayerMult: number;
  careerPlayerPowerMult: number;
  careerPlayerSpeedMult: number;
  careerOppGrowthChanceJourneyman: number;
  careerOppGrowthChanceContender: number;
  careerOppGrowthChanceElite: number;
  careerOppGrowthChanceChampion: number;
  careerOppGrowthFreezeGap: number;
  careerOppGrowthCapOverPlayer: number;
  finalDoubler: number;
  champBonus: number;
  endgameMult: number;
  preChampMult: number;
  accMult50: number;
  accMult60: number;
  accMult65: number;
  accMult70: number;
  accMult75: number;
  sparWinBase: number;
  trainWinBase: number;
  xpWlPrepBonus: number;
  xpWlIdleBonus: number;
  xpHbPrepBonus: number;
  xpHbIdleBonus: number;
  xpSparPrepBonus: number;
  xpSparIdleBonus: number;
  statBoutMult: number;
  statWlMult: number;
  statSparMult: number;
  statHbMult: number;
  statWlBonusX: number;
  statWlBonusY: number;
  statSparBonusX: number;
  statSparBonusY: number;
  statWlPrepBonus: number;
  statWlIdleBonus: number;
  statHbPrepBonus: number;
  statHbIdleBonus: number;
  statSparPrepBonus: number;
  statSparIdleBonus: number;
}

export const DEFAULT_XP_CONFIG: XpConfig = {
  boutBase: 1.1,
  careerMult: 1.5,
  careerOpponentMult: 1.0,
  careerOpponentPowerMult: 1.0,
  careerOpponentSpeedMult: 1.0,
  careerPlayerMult: 1.0,
  careerPlayerPowerMult: 1.0,
  careerPlayerSpeedMult: 1.0,
  careerOppGrowthChanceJourneyman: 0.15,
  careerOppGrowthChanceContender: 0.20,
  careerOppGrowthChanceElite: 0.30,
  careerOppGrowthChanceChampion: 0.40,
  careerOppGrowthFreezeGap: 3,
  careerOppGrowthCapOverPlayer: 4,
  finalDoubler: 2.0,
  champBonus: 1.5,
  endgameMult: 0.3,
  preChampMult: 0.5,
  accMult50: 1.3,
  accMult60: 1.6,
  accMult65: 1.9,
  accMult70: 2.2,
  accMult75: 2.5,
  sparWinBase: 1.1,
  trainWinBase: 1.1,
  xpWlPrepBonus: 0,
  xpWlIdleBonus: 0,
  xpHbPrepBonus: 0,
  xpHbIdleBonus: 0,
  xpSparPrepBonus: 0,
  xpSparIdleBonus: 0,
  statBoutMult: 1.0,
  statWlMult: 1.0,
  statSparMult: 1.0,
  statHbMult: 1.0,
  statWlBonusX: 1,
  statWlBonusY: 5,
  statSparBonusX: 1,
  statSparBonusY: 5,
  statWlPrepBonus: 0,
  statWlIdleBonus: 0,
  statHbPrepBonus: 0,
  statHbIdleBonus: 0,
  statSparPrepBonus: 0,
  statSparIdleBonus: 0,
};

export function loadXpConfig(): XpConfig {
  try {
    const raw = localStorage.getItem(XP_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_XP_CONFIG };
    return { ...DEFAULT_XP_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_XP_CONFIG };
  }
}

export function saveXpConfig(config: XpConfig): void {
  localStorage.setItem(XP_CONFIG_KEY, JSON.stringify(config));
}

export function loadXpDefaults(): XpConfig {
  try {
    const raw = localStorage.getItem(XP_DEFAULTS_KEY);
    if (!raw) return { ...DEFAULT_XP_CONFIG };
    return { ...DEFAULT_XP_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_XP_CONFIG };
  }
}

export function saveXpDefaults(config: XpConfig): void {
  localStorage.setItem(XP_DEFAULTS_KEY, JSON.stringify(config));
}

export function hasCustomXpDefaults(): boolean {
  return localStorage.getItem(XP_DEFAULTS_KEY) !== null;
}
