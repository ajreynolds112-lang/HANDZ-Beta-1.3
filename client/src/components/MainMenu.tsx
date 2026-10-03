import { useState } from "react";
import { Trophy, Settings, Volume2, VolumeX, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BoxingGloveIcon } from "@/components/BoxingGloveIcon";
import { soundEngine, musicEngine } from "@/game/sound";
import { isDirectionalPerfectBlockEnabled } from "@/components/NeuralNetworkView";
import { getGraphicsMode, setGraphicsMode, type GraphicsMode } from "@/game/graphicsSetting";

interface MainMenuProps {
  onQuickFight: () => void;
  onCareer: () => void;
  onEditRoster?: () => void;
  onTutorial?: () => void;
  fighterName?: string;
  fighterLevel?: number;
  wins?: number;
  losses?: number;
}

export default function MainMenu({ onQuickFight, onCareer, onEditRoster, onTutorial, fighterName, fighterLevel, wins, losses }: MainMenuProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [, forceUpdate] = useState(0);

  const handleVolumeChange = (key: "master" | "sfx" | "crowd" | "ui" | "music", value: number) => {
    soundEngine.updateSetting(key, value);
    if (key === "master" || key === "music") musicEngine.refreshVolume();
    forceUpdate(v => v + 1);
  };

  const handleToggleMute = () => {
    soundEngine.toggleMute();
    musicEngine.refreshVolume();
    forceUpdate(v => v + 1);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-full gap-6 p-6 relative">
      <button
        onClick={() => setShowSettings(!showSettings)}
        className="absolute top-4 right-4 p-2 rounded-full hover:bg-muted transition-colors"
        data-testid="button-settings"
      >
        <Settings className="w-5 h-5 text-muted-foreground" />
      </button>
      {showSettings && <SoundSettings onClose={() => setShowSettings(false)} onVolumeChange={handleVolumeChange} onToggleMute={handleToggleMute} />}
      <div className="text-center mb-2">
        <h1
          className="text-6xl font-black tracking-wider text-[#deb345]"
          style={{ textShadow: "0 0 40px rgba(200,50,50,0.4), 0 4px 8px rgba(0,0,0,0.5)" }}
          data-testid="text-game-title"
        >
          HANDZ
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1" data-testid="text-subtitle">
          Boxing
        </p>
      </div>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <Button
          size="lg"
          onClick={() => onCareer()}
          className="w-full text-lg gap-3 bg-[#deb345] border-t-[transparent] border-r-[transparent] border-b-[transparent] border-l-[transparent] border-t-[0px] border-r-[0px] border-b-[0px] border-l-[0px] rounded-tl-[0px] rounded-tr-[0px] rounded-br-[0px] rounded-bl-[0px]"
          data-testid="button-career"
        >
          <Trophy className="w-5 h-5" />
          Career Mode
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => onQuickFight()}
          className="w-full text-lg gap-3 bg-[#634b3b] opacity-[0.88]"
          data-testid="button-quick-fight"
        >
          <BoxingGloveIcon className="w-5 h-5" />
          Quick Fight
        </Button>
        {onEditRoster && (
          <Button
            size="lg"
            variant="outline"
            onClick={() => onEditRoster()}
            className="w-full text-lg gap-3 text-[#f1f2f4] bg-[#292929] opacity-[0.88]"
            data-testid="button-edit-roster"
          >
            <Pencil className="w-5 h-5" />
            Edit Roster
          </Button>
        )}
        {onTutorial && (
          <Button
            size="lg"
            variant="ghost"
            onClick={() => onTutorial()}
            className="w-full text-lg gap-3"
            data-testid="button-tutorial"
          >
            Tutorial
          </Button>
        )}
      </div>
    </div>
  );
}

function SoundSettings({ onClose, onVolumeChange, onToggleMute }: {
  onClose: () => void;
  onVolumeChange: (key: "master" | "sfx" | "crowd" | "ui" | "music", value: number) => void;
  onToggleMute: () => void;
}) {
  const volumes = soundEngine.getVolumes();
  const muted = soundEngine.isMuted();
  const [tab, setTab] = useState<"sound" | "controls">("sound");
  const [graphics, setGraphics] = useState<GraphicsMode>(getGraphicsMode);
  const chooseGraphics = (mode: GraphicsMode) => {
    setGraphicsMode(mode);
    setGraphics(mode);
  };
  const categories: { label: string; key: "master" | "sfx" | "crowd" | "ui" | "music" }[] = [
    { label: "Master", key: "master" },
    { label: "Music", key: "music" },
    { label: "SFX", key: "sfx" },
    { label: "Crowd", key: "crowd" },
    { label: "UI", key: "ui" },
  ];

  return (
    <Card className="absolute top-14 right-4 p-4 w-72 z-50" data-testid="panel-sound-settings">
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setTab("sound")}
          className={`flex-1 text-xs py-1 rounded font-semibold transition-colors ${tab === "sound" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          data-testid="tab-sound"
        >Sound</button>
        <button
          onClick={() => setTab("controls")}
          className={`flex-1 text-xs py-1 rounded font-semibold transition-colors ${tab === "controls" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          data-testid="tab-controls"
        >Controls</button>
      </div>

      {tab === "sound" && (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted-foreground">SOUND</h3>
            <button onClick={onToggleMute} className="p-1 rounded hover:bg-muted" data-testid="button-mute-toggle">
              {muted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4 text-muted-foreground" />}
            </button>
          </div>
          {categories.map(cat => (
            <div key={cat.key} className="mb-3">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">{cat.label}</span>
                <span className={`font-mono ${muted ? "text-muted-foreground/50" : ""}`}>{Math.round(volumes[cat.key] * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(volumes[cat.key] * 100)}
                onChange={e => onVolumeChange(cat.key, parseInt(e.target.value) / 100)}
                className="w-full h-1.5 accent-primary cursor-pointer"
                disabled={muted}
                data-testid={`slider-${cat.key}`}
              />
            </div>
          ))}
          <div className="mt-4 pt-3 border-t border-border">
            <h3 className="text-sm font-semibold text-muted-foreground mb-2">GRAPHICS</h3>
            <div className="flex gap-2">
              {([["3d", "3D"], ["classic", "Classic 2D"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => chooseGraphics(mode)}
                  className={`flex-1 text-xs py-1.5 rounded font-semibold transition-colors ${graphics === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground bg-muted/40 hover:bg-muted"}`}
                  data-testid={`button-graphics-${mode}`}
                >{label}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === "controls" && (
        <>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">CONTROLS</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <ControlRow label="Move" value="Arrow Keys" />
            <ControlRow label="Duck" value="Shift" />
            <ControlRow label="Jab" value="W" />
            <ControlRow label="Cross" value="E" />
            <ControlRow label="L Hook" value="Q" />
            <ControlRow label="R Hook" value="R" />
            <ControlRow label="L Upper" value="S" />
            <ControlRow label="R Upper" value="D" />
            <ControlRow label="Body Shot" value="Shift+Punch" />
            <ControlRow label="Feint" value="F, then Punch" />
            <ControlRow label="Full Guard" value="Space x2" />
            <ControlRow label="Block Up/Down" value="Space+Arrow" />
            <ControlRow label="Rhythm Up" value="Tab+Right" />
            <ControlRow label="Rhythm Down" value="Tab+Left" />
            <ControlRow label="Charge Punch" value="A, then Punch" />
            <ControlRow label="Slip" value="C + Arrow" />
            <ControlRow label="Stance Cycle" value="Tab + C" />
            {isDirectionalPerfectBlockEnabled() ? (
              <>
                <ControlRow label="Perfect Block (head)" value="V" />
                <ControlRow label="Perfect Block (body)" value="Shift + V" />
              </>
            ) : (
              <ControlRow label="Perfect Block" value="V" />
            )}
            <ControlRow label="Pause" value="Esc" />
          </div>
        </>
      )}

      <Button variant="ghost" size="sm" onClick={onClose} className="w-full mt-3 text-xs" data-testid="button-close-settings">
        Close
      </Button>
    </Card>
  );
}

function ControlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
