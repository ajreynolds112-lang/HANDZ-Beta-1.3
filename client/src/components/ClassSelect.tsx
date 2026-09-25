import { useState, useMemo } from "react";
import { Archetype, ARCHETYPE_STATS, FighterColors, AIDifficulty, AI_DIFFICULTY_LABELS, AI_DIFFICULTY_DESCRIPTIONS, TimerSpeed } from "@/game/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Settings, Users, X, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import FighterStanceCanvas from "@/components/FighterStanceCanvas";
import { SkinColorField } from "@/components/ColorPicker";
import { defaultLaceColor, defaultSoleColor, defaultWaistStripeColor } from "@/game/renderer";
import { ROSTER_DATA, getRosterDisplayName, type RosterEntry } from "@/game/rosterData";

interface ClassSelectProps {
  selected: Archetype;
  onSelect: (archetype: Archetype) => void;
  onConfirm: () => void;
  onBack: () => void;
  colors: FighterColors;
  onColorsChange: (colors: FighterColors) => void;
  lockedArchetype?: boolean;
  playerLevel?: number;
  enemyLevel?: number;
  onPlayerLevelChange?: (level: number) => void;
  onEnemyLevelChange?: (level: number) => void;
  showLevelSelect?: boolean;
  difficulty?: AIDifficulty;
  onDifficultyChange?: (d: AIDifficulty) => void;
  roundDuration?: number;
  onRoundDurationChange?: (mins: number) => void;
  timerSpeed?: TimerSpeed;
  onTimerSpeedChange?: (speed: TimerSpeed) => void;
  maxRounds?: number;
  onMaxRoundsChange?: (rounds: number) => void;
  playerArmLength?: number;
  enemyArmLength?: number;
  onPlayerArmLengthChange?: (len: number) => void;
  onEnemyArmLengthChange?: (len: number) => void;
  towelStoppageEnabled?: boolean;
  onTowelStoppageChange?: (enabled: boolean) => void;
  practiceMode?: boolean;
  onPracticeModeChange?: (enabled: boolean) => void;
  recordInputs?: boolean;
  onRecordInputsChange?: (enabled: boolean) => void;
  cpuVsCpu?: boolean;
  onCpuVsCpuChange?: (enabled: boolean) => void;
  aiPowerMult?: number;
  onAiPowerMultChange?: (val: number) => void;
  aiSpeedMult?: number;
  onAiSpeedMultChange?: (val: number) => void;
  aiStaminaMult?: number;
  onAiStaminaMultChange?: (val: number) => void;
  selectedRosterFighters?: RosterEntry[];
  onRosterFightersChange?: (fighters: RosterEntry[]) => void;
  nightmareMode?: boolean;
  onNightmareModeChange?: (enabled: boolean) => void;
}

const ARCHETYPE_ICONS: Record<Archetype, string> = {
  BoxerPuncher: "BP",
  OutBoxer: "OB",
  Brawler: "BR",
  Swarmer: "SW",
};

const ARCHETYPE_COLORS: Record<Archetype, string> = {
  BoxerPuncher: "border-blue-500/50",
  OutBoxer: "border-green-500/50",
  Brawler: "border-red-500/50",
  Swarmer: "border-yellow-500/50",
};

const DIFFICULTIES: AIDifficulty[] = ["journeyman", "contender", "elite", "champion"];

const DIFFICULTY_COLORS: Record<AIDifficulty, string> = {
  journeyman: "ring-green-500/50",
  contender: "ring-yellow-500/50",
  elite: "ring-orange-500/50",
  champion: "ring-red-500/50",
};

export default function ClassSelect({ selected, onSelect, onConfirm, onBack, colors, onColorsChange, lockedArchetype, playerLevel = 1, enemyLevel = 1, onPlayerLevelChange, onEnemyLevelChange, showLevelSelect, difficulty = "contender", onDifficultyChange, roundDuration = 3, onRoundDurationChange, timerSpeed = "normal", onTimerSpeedChange, maxRounds = 3, onMaxRoundsChange, playerArmLength = 65, enemyArmLength = 65, onPlayerArmLengthChange, onEnemyArmLengthChange, towelStoppageEnabled = true, onTowelStoppageChange, practiceMode = false, onPracticeModeChange, recordInputs = false, onRecordInputsChange, cpuVsCpu = false, onCpuVsCpuChange, aiPowerMult = 1, onAiPowerMultChange, aiSpeedMult = 1, onAiSpeedMultChange, aiStaminaMult = 1, onAiStaminaMultChange, selectedRosterFighters = [], onRosterFightersChange, nightmareMode = false, onNightmareModeChange }: ClassSelectProps) {
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [rosterPickerOpen, setRosterPickerOpen] = useState(false);
  const [rosterSearch, setRosterSearch] = useState("");
  const archetypes: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
  const stats = ARCHETYPE_STATS[selected];

  return (
    <div className="flex flex-col h-full p-3 gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => onBack()} data-testid="button-back">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-xl font-bold" data-testid="text-class-select-title">Choose Your Style</h2>
      </div>
      <div className="flex gap-3 flex-1 min-h-0">
        <div className="flex flex-col gap-2 flex-1 min-w-0">
          <div className="grid grid-cols-2 gap-2">
            {archetypes.map(a => {
              const aStats = ARCHETYPE_STATS[a];
              const isSelected = selected === a;
              return (
                <Card
                  key={a}
                  className="shadcn-card rounded-xl border text-card-foreground shadow-sm p-2.5 cursor-pointer transition-all ring-2 ring-primary border-blue-500/50 bg-[#634b3b] border-t-[transparent] border-r-[transparent] border-b-[transparent] border-l-[transparent] border-t-[2px] border-r-[2px] border-b-[2px] border-l-[2px]"
                  onClick={() => !lockedArchetype && onSelect(a)}
                  data-testid={`card-archetype-${a}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`w-7 h-7 rounded-md flex items-center justify-center text-[10px] font-bold ${
                      isSelected ? "bg-[#17aebf] text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}>
                      {ARCHETYPE_ICONS[a]}
                    </div>
                    <p className="font-bold text-xs">{a}</p>
                  </div>
                  <div className="space-y-1">
                    <StatBar label="POW" value={aStats.damageMult} max={1.3} />
                    <StatBar label="SPD" value={aStats.speedMult} max={1.3} />
                    <StatBar label="STA" value={aStats.maxStaminaMult} max={1.3} />
                    <StatBar label="EFF" value={1 / aStats.punchCostMult} max={1.3} />
                  </div>
                </Card>
              );
            })}
          </div>

          {showLevelSelect && (<>
            <div className="flex gap-2">
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">AI DIFFICULTY</h3>
                <div className="grid grid-cols-2 gap-1">
                  {DIFFICULTIES.map(d => {
                    const isSelected = difficulty === d;
                    return (
                      <button
                        key={d}
                        onClick={() => onDifficultyChange?.(d)}
                        className={`py-1 px-1.5 rounded-md text-center transition-all ${
                          isSelected ? `ring-2 ${DIFFICULTY_COLORS[d]} bg-muted` : "opacity-60 hover-elevate"
                        }`}
                        data-testid={`button-difficulty-${d}`}
                      >
                        <p className="text-[10px] font-bold">{AI_DIFFICULTY_LABELS[d]}</p>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground text-center mt-1" data-testid="text-difficulty-description">
                  {AI_DIFFICULTY_DESCRIPTIONS[difficulty]}
                </p>
              </Card>
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">LEVELS</h3>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] w-10 text-right text-muted-foreground shrink-0">You</span>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={playerLevel}
                      onChange={e => onPlayerLevelChange?.(parseInt(e.target.value))}
                      className="flex-1 accent-primary h-1"
                      data-testid="slider-player-level"
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={playerLevel}
                      onChange={e => {
                        const v = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
                        onPlayerLevelChange?.(v);
                      }}
                      className="w-10 text-center text-[10px] rounded-md border bg-background p-0.5"
                      data-testid="input-player-level"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] w-10 text-right text-muted-foreground shrink-0">Enemy</span>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      value={enemyLevel}
                      onChange={e => onEnemyLevelChange?.(parseInt(e.target.value))}
                      className="flex-1 accent-primary h-1"
                      data-testid="slider-enemy-level"
                    />
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={enemyLevel}
                      onChange={e => {
                        const v = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
                        onEnemyLevelChange?.(v);
                      }}
                      className="w-10 text-center text-[10px] rounded-md border bg-background p-0.5"
                      data-testid="input-enemy-level"
                    />
                  </div>
                </div>
              </Card>
            </div>
            <div className="flex gap-2">
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">ROUND TIMER</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={3}
                    value={roundDuration}
                    onChange={e => onRoundDurationChange?.(parseInt(e.target.value))}
                    className="flex-1 accent-primary h-1"
                    data-testid="slider-round-duration"
                  />
                  <span className="text-[10px] font-bold w-10 text-center" data-testid="text-round-duration">{roundDuration} min</span>
                </div>
                <div className="flex items-center gap-1 mt-1.5">
                  <span className="text-[10px] text-muted-foreground shrink-0">Speed:</span>
                  {(["normal", "double"] as TimerSpeed[]).map(s => (
                    <button
                      key={s}
                      onClick={() => onTimerSpeedChange?.(s)}
                      className="py-0.5 px-2 rounded-md text-[10px] transition-all ring-2 ring-primary bg-muted font-bold border-t-[transparent] border-r-[transparent] border-b-[transparent] border-l-[transparent]"
                      data-testid={`button-timer-speed-${s}`}
                    >
                      {s === "normal" ? "1x" : "2x"}
                    </button>
                  ))}
                </div>
              </Card>
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">MAX ROUNDS</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={3}
                    max={12}
                    value={maxRounds}
                    onChange={e => onMaxRoundsChange?.(parseInt(e.target.value))}
                    className="flex-1 accent-primary h-1"
                    data-testid="slider-max-rounds"
                  />
                  <span className="text-[10px] font-bold w-6 text-center" data-testid="text-max-rounds">{maxRounds}</span>
                </div>
              </Card>
            </div>
            <div className="flex gap-2">
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">ARM LENGTH</h3>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] w-10 text-right text-muted-foreground shrink-0">You</span>
                    <input
                      type="range"
                      min={60}
                      max={75}
                      value={playerArmLength}
                      onChange={e => onPlayerArmLengthChange?.(parseInt(e.target.value))}
                      className="flex-1 accent-primary h-1"
                      data-testid="slider-player-arm-length"
                    />
                    <span className="text-[10px] font-bold w-10 text-center" data-testid="text-player-arm-length">{playerArmLength}"</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] w-10 text-right text-muted-foreground shrink-0">Enemy</span>
                    <input
                      type="range"
                      min={60}
                      max={75}
                      value={enemyArmLength}
                      onChange={e => onEnemyArmLengthChange?.(parseInt(e.target.value))}
                      className="flex-1 accent-primary h-1"
                      data-testid="slider-enemy-arm-length"
                    />
                    <span className="text-[10px] font-bold w-10 text-center" data-testid="text-enemy-arm-length">{enemyArmLength}"</span>
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground text-center mt-1">
                  {playerArmLength < 65 ? `+${(65 - playerArmLength) * 2}% power` : playerArmLength > 65 ? `+${((playerArmLength - 65) * 1.5).toFixed(0)}px reach` : "Base reach"}
                </p>
              </Card>
              <Card className="p-2.5 flex-1">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">TOWEL STOPPAGE</h3>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => onTowelStoppageChange?.(!towelStoppageEnabled)}
                    className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-2.5 flex-1 bg-[#634b3b]"
                    data-testid="button-towel-toggle"
                    disabled={practiceMode}
                  >
                    {towelStoppageEnabled && !practiceMode ? "ON" : "OFF"}
                  </button>
                </div>
              </Card>
              <Card className="p-2.5 flex-1">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">PRACTICE MODE</h3>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => onPracticeModeChange?.(!practiceMode)}
                    className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-2.5 flex-1 bg-[#634b3b] border-t-[#17aebf] border-r-[#17aebf] border-b-[#17aebf] border-l-[#17aebf]"
                    data-testid="button-practice-toggle"
                  >
                    {practiceMode ? "ON" : "OFF"}
                  </button>
                </div>
              </Card>
              <Card className="p-2.5 flex-1">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">RECORD INPUTS</h3>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => onRecordInputsChange?.(!recordInputs)}
                    className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-2.5 flex-1 bg-[#634b3b]"
                    data-testid="button-record-toggle"
                  >
                    {recordInputs ? "ON" : "OFF"}
                  </button>
                </div>
              </Card>
              <Card className="p-2.5 flex-1">
                <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">CPU vs CPU</h3>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => onCpuVsCpuChange?.(!cpuVsCpu)}
                    className="shadcn-card rounded-xl border border-card-border text-card-foreground shadow-sm p-2.5 flex-1 bg-[#634b3b]"
                    data-testid="button-cpuvcpu-toggle"
                  >
                    {cpuVsCpu ? "ON" : "OFF"}
                  </button>
                </div>
              </Card>
              {!lockedArchetype && (
                <Card className="p-2.5 flex-1">
                  <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">NIGHTMARE MODE</h3>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => onNightmareModeChange?.(!nightmareMode)}
                      className={`shadcn-card rounded-xl border text-card-foreground shadow-sm p-2.5 flex-1 ${nightmareMode ? "bg-[#FFABAB] text-black border-[#FFABAB]" : "bg-[#634b3b] border-card-border"}`}
                      data-testid="button-nightmare-toggle"
                    >
                      {nightmareMode ? "ON" : "OFF"}
                    </button>
                  </div>
                </Card>
              )}
            </div>
            <div className="flex gap-2">
              <Card className="p-2.5 flex-1 bg-[#634b3b]">
                <button
                  onClick={() => setAiSettingsOpen(!aiSettingsOpen)}
                  className="flex items-center justify-center gap-1.5 w-full"
                  data-testid="button-ai-settings-gear"
                >
                  <Settings className={`w-3.5 h-3.5 transition-transform ${aiSettingsOpen ? "rotate-90" : ""}`} />
                  <h3 className="text-[10px] font-semibold text-muted-foreground">AI MULTIPLIERS</h3>
                </button>
                {aiSettingsOpen && (
                  <div className="space-y-2 mt-2">
                    <MultSlider label="AI Power" value={aiPowerMult} onChange={v => onAiPowerMultChange?.(v)} testId="ai-power-mult" />
                    <MultSlider label="AI Move Speed" value={aiSpeedMult} onChange={v => onAiSpeedMultChange?.(v)} testId="ai-speed-mult" />
                    <MultSlider label="AI Stamina" value={aiStaminaMult} onChange={v => onAiStaminaMultChange?.(v)} testId="ai-stamina-mult" />
                    <button
                      onClick={() => { onAiPowerMultChange?.(1); onAiSpeedMultChange?.(1); onAiStaminaMultChange?.(1); }}
                      className="text-[9px] text-muted-foreground hover:text-foreground transition-colors w-full text-center mt-1"
                      data-testid="button-reset-ai-mults"
                    >
                      Reset All to 1x
                    </button>
                  </div>
                )}
              </Card>
            </div>

            <Card className="p-2.5 bg-[#634b3b]">
              <button
                onClick={() => setRosterPickerOpen(!rosterPickerOpen)}
                className="flex items-center justify-center gap-1.5 w-full"
                data-testid="button-roster-picker-toggle"
              >
                <Users className={`w-3.5 h-3.5 transition-transform ${rosterPickerOpen ? "rotate-90" : ""}`} />
                <h3 className="text-[10px] font-semibold text-muted-foreground">
                  SELECT OPPONENT{selectedRosterFighters.length > 0 ? ` (${selectedRosterFighters.length})` : ""}
                </h3>
              </button>
              {selectedRosterFighters.length > 0 && !rosterPickerOpen && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {selectedRosterFighters.map(f => (
                    <span key={f.id} className="inline-flex items-center gap-1 text-[9px] bg-primary/10 text-primary rounded px-1.5 py-0.5" data-testid={`tag-roster-fighter-${f.id}`}>
                      {f.firstName} {f.lastName}
                      <button onClick={e => { e.stopPropagation(); onRosterFightersChange?.(selectedRosterFighters.filter(s => s.id !== f.id)); }} className="hover:text-destructive">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                  <button
                    onClick={() => onRosterFightersChange?.([])}
                    className="text-[9px] text-muted-foreground hover:text-destructive transition-colors"
                    data-testid="button-clear-roster-selection"
                  >
                    Clear
                  </button>
                </div>
              )}
              {rosterPickerOpen && (
                <RosterPicker
                  search={rosterSearch}
                  onSearchChange={setRosterSearch}
                  selectedIds={new Set(selectedRosterFighters.map(f => f.id))}
                  onToggle={entry => {
                    const exists = selectedRosterFighters.find(f => f.id === entry.id);
                    if (exists) {
                      onRosterFightersChange?.(selectedRosterFighters.filter(f => f.id !== entry.id));
                    } else {
                      onRosterFightersChange?.([...selectedRosterFighters, entry]);
                    }
                  }}
                  onClear={() => onRosterFightersChange?.([])}
                />
              )}
            </Card>
          </>)}
        </div>

        <div className="flex flex-col gap-2 w-52 shrink-0">
          <Card className="p-3 flex-1 flex flex-col items-center justify-center">
            <div className="w-40 h-48">
              <FighterStanceCanvas colors={colors} width={160} height={192} />
            </div>
            <p className="text-xs font-semibold mt-1">{selected}</p>
            <p className="text-[10px] text-muted-foreground text-center leading-tight mt-0.5">{stats.description}</p>
          </Card>
          <Card className="p-2.5">
            <h3 className="text-[10px] font-semibold text-center mb-1.5 text-muted-foreground">GEAR</h3>
            <div className="space-y-1.5">
              <div className="flex items-start gap-1.5">
                <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0 mt-1">Skin</span>
                <SkinColorField
                  value={colors.skin}
                  onChange={c => onColorsChange({ ...colors, skin: c })}
                  unlocked={playerLevel >= 100}
                  testId="color-skin"
                  swatchClassName="w-5 h-5"
                  inputClassName="w-6 h-6"
                />
              </div>
              <ColorPickerRow label="Gloves" value={colors.gloves} onChange={c => onColorsChange({ ...colors, gloves: c })} testId="color-gloves" />
              <ColorPickerRow label="Tape" value={colors.gloveTape} onChange={c => onColorsChange({ ...colors, gloveTape: c })} testId="color-tape" />
              <ColorPickerRow label="Trunks" value={colors.trunks} onChange={c => onColorsChange({ ...colors, trunks: c })} testId="color-trunks" />
              <ColorPickerRow label="Shoes" value={colors.shoes} onChange={c => onColorsChange({ ...colors, shoes: c })} testId="color-shoes" />
              <ColorPickerRow label="Socks" value={colors.socks || "#f0f0f0"} onChange={c => onColorsChange({ ...colors, socks: c })} testId="color-socks" />
              <ColorPickerRow label="Laces" value={colors.laces || defaultLaceColor(colors.shoes)} onChange={c => onColorsChange({ ...colors, laces: c })} testId="color-laces" />
              <ColorPickerRow label="Soles" value={colors.soles || defaultSoleColor(colors.shoes)} onChange={c => onColorsChange({ ...colors, soles: c })} testId="color-soles" />
              <ColorPickerRow label="Waist" value={colors.waistStripe || defaultWaistStripeColor(colors.trunks)} onChange={c => onColorsChange({ ...colors, waistStripe: c })} testId="color-waist-stripe" />
            </div>
          </Card>
        </div>
      </div>
      <Button
        onClick={() => onConfirm()}
        className="w-full text-sm"
        data-testid="button-confirm-class"
      >
        Begin
      </Button>
    </div>
  );
}

function ColorPickerRow({ label, value, onChange, testId }: {
  label: string;
  value: string;
  onChange: (color: string) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{label}</span>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-6 h-6 rounded cursor-pointer border border-border bg-transparent p-0"
        data-testid={testId}
      />
    </div>
  );
}

function MultSlider({ label, value, onChange, testId }: { label: string; value: number; onChange: (v: number) => void; testId: string }) {
  const step = 0.1;
  const displayVal = Math.round(value * 10) / 10;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-20 text-right text-muted-foreground shrink-0">{label}</span>
      <input
        type="range"
        min={0.1}
        max={10}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-primary h-1"
        data-testid={`slider-${testId}`}
      />
      <span className="text-[10px] font-bold w-8 text-center" data-testid={`text-${testId}`}>{displayVal}x</span>
    </div>
  );
}

const ARCHETYPE_SHORT: Record<Archetype, string> = {
  BoxerPuncher: "BP",
  OutBoxer: "OB",
  Brawler: "BR",
  Swarmer: "SW",
};

function RosterPicker({ search, onSearchChange, selectedIds, onToggle, onClear }: {
  search: string;
  onSearchChange: (s: string) => void;
  selectedIds: Set<number>;
  onToggle: (entry: RosterEntry) => void;
  onClear: () => void;
}) {
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ROSTER_DATA;
    return ROSTER_DATA.filter(e => {
      const name = getRosterDisplayName(e).toLowerCase();
      return name.includes(q);
    });
  }, [search]);

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search fighters..."
            className="h-7 text-[10px] pl-6"
            data-testid="input-roster-search"
          />
        </div>
        {selectedIds.size > 0 && (
          <button
            onClick={onClear}
            className="text-[9px] text-muted-foreground hover:text-destructive transition-colors whitespace-nowrap"
            data-testid="button-clear-roster-picker"
          >
            Clear ({selectedIds.size})
          </button>
        )}
      </div>
      <div className="max-h-32 overflow-y-auto space-y-0.5">
        {filtered.map(entry => {
          const isSelected = selectedIds.has(entry.id);
          const name = getRosterDisplayName(entry);
          return (
            <button
              key={entry.id}
              onClick={() => onToggle(entry)}
              className={`w-full text-left px-2 py-1 rounded text-[10px] flex items-center gap-2 transition-all ${
                isSelected ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "hover:bg-muted/50"
              }`}
              data-testid={`button-roster-pick-${entry.id}`}
            >
              <span className={`w-5 h-5 rounded flex items-center justify-center text-[8px] font-bold shrink-0 ${
                isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>
                {ARCHETYPE_SHORT[entry.archetype]}
              </span>
              <span className="truncate flex-1">{name}</span>
              {entry.isKeyFighter && <span className="text-[8px] text-amber-500">KEY</span>}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-[10px] text-muted-foreground text-center py-2">No fighters found</p>
        )}
      </div>
    </div>
  );
}

function StatBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] text-muted-foreground w-7 text-right">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all bg-[#17aebf]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
