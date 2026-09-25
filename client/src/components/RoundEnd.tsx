import { useEffect, useCallback } from "react";
import { GameState } from "@/game/types";
import { formatRoundRecordingForExport } from "@/game/engine";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useEnterKey } from "@/hooks/useEnterKey";

interface RoundEndProps {
  state: GameState;
  onNextRound: () => void;
}

const JUDGE_NAMES = ["J. Martinez", "K. Williams", "R. Thompson"];

export default function RoundEnd({ state, onNextRound }: RoundEndProps) {
  useEnterKey(onNextRound);
  const lastScore = state.roundScores[state.roundScores.length - 1];

  const handleDownloadRecording = useCallback(() => {
    if (!state.inputRecording) return;
    const text = formatRoundRecordingForExport(state.inputRecording, state.currentRound);
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const s = state.inputRecording.fightSettings;
    const typeTag = s.cpuVsCpu ? "cpuVcpu" : "pVcpu";
    const modeTag = s.practiceMode ? "practice" : "normal";
    a.download = `handz_${typeTag}_${modeTag}_rd${state.currentRound}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.inputRecording, state.currentRound]);

  return (
    <div className="w-[95%] max-w-[700px] mx-auto select-none" data-testid="overlay-round-end">
      <div className="bg-[#1a1a2e] border border-[#2a2a4a] rounded-md overflow-hidden">
        <div className="bg-[#0f0f1f] px-4 py-2 text-center border-b border-[#2a2a4a]">
          <h2 className="text-white text-sm font-bold tracking-widest uppercase" data-testid="text-scorecard-title">
            Scorecard
          </h2>
        </div>

        <div className="px-3 py-2">
          <div className="grid grid-cols-[auto_1fr_1fr] gap-0 text-[11px]">
            <div className="flex items-center gap-2 px-2 py-1">
              <span className="text-gray-400 font-medium w-8 text-center">RD</span>
            </div>
            <div className="text-center text-blue-400 font-bold truncate px-1">
              {state.player.name || "PLAYER"}
            </div>
            <div className="text-center text-red-400 font-bold truncate px-1">
              {state.enemy.name || "OPPONENT"}
            </div>
          </div>

          {JUDGE_NAMES.map((judgeName, ji) => {
            const judgeTotal = { player: 0, enemy: 0 };
            state.roundScores.forEach(score => {
              judgeTotal.player += score.judges[ji].player;
              judgeTotal.enemy += score.judges[ji].enemy;
            });

            return (
              <div key={ji} className="mt-1">
                <div className="text-[9px] text-gray-500 px-2 font-medium">{judgeName}</div>
                <div className="grid grid-cols-[auto_1fr_1fr] gap-0">
                  <div className="flex flex-col gap-0">
                    {state.roundScores.map((_, ri) => (
                      <div key={ri} className="text-gray-500 text-[10px] w-8 text-center py-0.5">
                        {ri + 1}
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-col gap-0">
                    {state.roundScores.map((score, ri) => {
                      const j = score.judges[ji];
                      const isWinner = j.player > j.enemy;
                      const isTied = j.player === j.enemy;
                      return (
                        <div
                          key={ri}
                          className={`text-center text-[11px] font-bold py-0.5 ${
                            isWinner ? "bg-blue-500/20 text-blue-300" : isTied ? "text-gray-400" : "text-gray-500"
                          }`}
                        >
                          {j.player}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-col gap-0">
                    {state.roundScores.map((score, ri) => {
                      const j = score.judges[ji];
                      const isWinner = j.enemy > j.player;
                      const isTied = j.player === j.enemy;
                      return (
                        <div
                          key={ri}
                          className={`text-center text-[11px] font-bold py-0.5 ${
                            isWinner ? "bg-red-500/20 text-red-300" : isTied ? "text-gray-400" : "text-gray-500"
                          }`}
                        >
                          {j.enemy}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-[auto_1fr_1fr] gap-0 border-t border-[#2a2a4a]">
                  <div className="w-8"></div>
                  <div className={`text-center text-[11px] font-black py-0.5 ${
                    judgeTotal.player > judgeTotal.enemy ? "text-blue-300" : "text-gray-500"
                  }`}>
                    {judgeTotal.player}
                  </div>
                  <div className={`text-center text-[11px] font-black py-0.5 ${
                    judgeTotal.enemy > judgeTotal.player ? "text-red-300" : "text-gray-500"
                  }`}>
                    {judgeTotal.enemy}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {lastScore && (
          <div className="border-t border-[#2a2a4a] px-3 py-2">
            <div className="text-[9px] text-gray-500 text-center mb-1 font-medium uppercase">Round {state.currentRound} Stats</div>
            <div className="grid grid-cols-3 gap-1 text-[10px] text-center">
              <span className="text-blue-300 font-bold">{lastScore.playerLandedPct}%</span>
              <span className="text-gray-500">Accuracy</span>
              <span className="text-red-300 font-bold">{lastScore.enemyLandedPct}%</span>

              <span className="text-blue-300 font-bold">{lastScore.playerDamage}</span>
              <span className="text-gray-500">Damage</span>
              <span className="text-red-300 font-bold">{lastScore.enemyDamage}</span>

              <span className="text-blue-300 font-bold">{lastScore.playerKDsThisRound}</span>
              <span className="text-gray-500">Knockdowns</span>
              <span className="text-red-300 font-bold">{lastScore.enemyKDsThisRound}</span>

              <span className="text-blue-300 font-bold" data-testid="text-round-player-punches">{lastScore.playerLandedThisRound}</span>
              <span className="text-gray-500">Punches Landed</span>
              <span className="text-red-300 font-bold" data-testid="text-round-enemy-punches">{lastScore.enemyLandedThisRound}</span>
            </div>
          </div>
        )}

        <div className="border-t border-[#2a2a4a] px-3 py-2">
          <div className="text-[9px] text-gray-500 text-center mb-1 font-medium uppercase">Total Fight Stats</div>
          <div className="grid grid-cols-3 gap-1 text-[10px] text-center">
            <span className="text-blue-300 font-bold" data-testid="text-total-player-punches">{state.player.punchesLanded}</span>
            <span className="text-gray-500">Punches Landed</span>
            <span className="text-red-300 font-bold" data-testid="text-total-enemy-punches">{state.enemy.punchesLanded}</span>
          </div>
        </div>

        {state.midFightLevelUpTimer > 0 && (
          <div className="border-t border-[#2a2a4a] px-3 py-3" data-testid="mid-fight-level-up-banner">
            <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-md px-4 py-2 text-center">
              <div className="text-yellow-300 text-xs font-black tracking-widest uppercase">LEVEL UP!</div>
              <div className="text-yellow-200 text-lg font-black mt-0.5">Level {state.playerLevel}</div>
            </div>
          </div>
        )}

        <div className="p-3 border-t border-[#2a2a4a] flex gap-2">
          <Button
            onClick={onNextRound}
            autoFocus
            className="flex-1 bg-blue-600 text-white font-bold"
            data-testid="button-next-round"
          >
            Next Round
          </Button>
          {state.recordInputs && state.inputRecording && (
            <Button
              onClick={handleDownloadRecording}
              variant="outline"
              size="icon"
              className="border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
              data-testid="button-download-recording"
              title="Download input recording"
            >
              <Download className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
