import { useCallback, useState } from "react";
import { GameState } from "@/game/types";
import { formatRecordingForExport } from "@/game/engine";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useEnterKey } from "@/hooks/useEnterKey";

interface FightEndProps {
  state: GameState;
  onContinue: () => void;
  xpToNext: number;
  currentXp: number;
  forceEarned?: number;
  diamondsEarned?: number;
}

const JUDGE_NAMES = ["J. Martinez", "K. Williams", "R. Thompson"];

export default function FightEnd({ state, onContinue, xpToNext, currentXp, forceEarned = 0, diamondsEarned = 0 }: FightEndProps) {
  const [stage, setStage] = useState<"victory" | "stats">("victory");
  useEnterKey(() => { if (stage === "victory") setStage("stats"); else onContinue(); });

  const handleDownloadRecording = useCallback(() => {
    if (!state.inputRecording) return;
    const text = formatRecordingForExport(state.inputRecording);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const s = state.inputRecording.fightSettings;
    const typeTag = s.cpuVsCpu ? "cpuVcpu" : "pVcpu";
    const modeTag = s.practiceMode ? "practice" : "normal";
    a.download = `handz_${typeTag}_${modeTag}_full_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [state.inputRecording]);

  const isWin = state.fightWinner === "player";
  const isDraw = state.fightResult === "Draw";
  const isKO = state.fightResult === "KO" || state.fightResult === "TKO";

  // Finish time within the ending round: the round timer counts down from
  // roundDuration, so elapsed seconds = roundDuration - roundTimer.
  const koElapsedSeconds = Math.max(0, state.roundDuration - state.roundTimer);
  const koTimeBonusBase = (isKO && isWin && (state.sparringMode || state.careerFightMode))
    ? (koElapsedSeconds <= 25 ? 6 : koElapsedSeconds <= 30 ? 3 : koElapsedSeconds <= 35 ? 2 : koElapsedSeconds <= 40 ? 1 : 0)
    : 0;
  const koTimeBonusDisplay = state.careerFightMode ? koTimeBonusBase * 3 : koTimeBonusBase;

  const judgeTotals = JUDGE_NAMES.map((_, ji) => {
    let pTotal = 0, eTotal = 0;
    state.roundScores.forEach(score => {
      pTotal += score.judges[ji].player;
      eTotal += score.judges[ji].enemy;
    });
    return { player: pTotal, enemy: eTotal };
  });

  let judgePlayerWins = 0, judgeEnemyWins = 0;
  judgeTotals.forEach(j => {
    if (j.player > j.enemy) judgePlayerWins++;
    else if (j.enemy > j.player) judgeEnemyWins++;
  });

  let decisionType = "";
  if (isKO) {
    decisionType = state.fightResult || "";
  } else if (isDraw) {
    decisionType = "DRAW";
  } else if (state.sparringMode) {
    decisionType = "SPARRING RESULT";
  } else if (judgePlayerWins === 3 || judgeEnemyWins === 3) {
    decisionType = "UNANIMOUS DECISION";
  } else if (judgePlayerWins === 2 || judgeEnemyWins === 2) {
    decisionType = "SPLIT DECISION";
  } else {
    decisionType = "MAJORITY DRAW";
  }

  const winnerName = isWin ? (state.player.name || "PLAYER") : (state.enemy.name || "OPPONENT");
  const loserName = isWin ? (state.enemy.name || "OPPONENT") : (state.player.name || "PLAYER");

  if (stage === "victory") {
    return (
      <div className="w-[95%] max-w-[440px] mx-auto select-none" data-testid="overlay-fight-end">
        <div className="bg-[#141414] border border-white/15 rounded-xl overflow-hidden shadow-2xl">
          <div className={`h-1 ${isDraw ? "bg-yellow-500" : isWin ? "bg-blue-500" : "bg-red-500"}`} />
          <div className="px-6 pt-6 pb-4 text-center">
            <div className={`text-[10px] font-bold tracking-[0.3em] uppercase mb-2 ${isDraw ? "text-yellow-400/70" : isWin ? "text-blue-400/70" : "text-red-400/70"}`}>
              {isDraw ? "It's a draw" : isWin ? "Victory" : "Defeat"}
            </div>
            <div className="text-yellow-400 font-black italic uppercase text-2xl leading-tight" style={{ textShadow: "2px 2px 0 rgba(0,0,0,0.7)" }} data-testid="text-fight-result">
              {isDraw ? "DRAW" : winnerName.toUpperCase()}
            </div>
            {!isDraw && (
              <div className="text-white/50 text-[11px] font-mono mt-1">
                defeats <span className="text-white/80">{loserName}</span>
              </div>
            )}
            <div className="inline-block mt-3 bg-black/60 border border-white/10 rounded px-3 py-1">
              <span className="text-white/85 text-[11px] font-bold tracking-widest uppercase" data-testid="text-method">
                {decisionType}{isKO ? ` · R${state.currentRound}` : ""}
              </span>
            </div>
          </div>
          <div className="p-4 border-t border-white/10">
            <Button
              onClick={() => setStage("stats")}
              autoFocus
              className="w-full bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold"
              data-testid="button-continue"
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-[95%] max-w-[700px] mx-auto select-none overflow-y-auto max-h-[90vh]" data-testid="overlay-fight-end-stats">
      <div className="bg-[#141414] border border-white/15 rounded-xl overflow-hidden shadow-2xl">
        <div className="bg-black/60 px-4 py-2.5 text-center border-b border-white/10">
          <h2 className="text-yellow-400 font-black italic uppercase text-sm tracking-widest" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }} data-testid="text-scorecard-title">
            Post-Fight Report
          </h2>
        </div>

        <div className="px-3 py-2">
          {JUDGE_NAMES.map((judgeName, ji) => {
            return (
              <div key={ji} className="mt-1">
                <div className="text-[9px] text-gray-500 px-2 font-medium">{judgeName}</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] border-collapse">
                    <thead>
                      <tr>
                        <th className="w-16 text-left text-gray-500 font-normal px-1"></th>
                        {state.roundScores.map((_, ri) => (
                          <th key={ri} className="text-center text-gray-500 font-normal px-0.5 min-w-[22px]">
                            {ri + 1}
                          </th>
                        ))}
                        <th className="text-center text-gray-400 font-bold px-1 min-w-[32px]">TOT</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="text-blue-400 font-bold px-1 truncate max-w-[60px]" title={state.player.name || "PLAYER"}>
                          {(state.player.name || "PLAYER").substring(0, 8)}
                        </td>
                        {state.roundScores.map((score, ri) => {
                          const j = score.judges[ji];
                          const isWinnerCell = j.player > j.enemy;
                          return (
                            <td key={ri} className={`text-center font-bold px-0.5 py-0.5 ${
                              isWinnerCell ? "bg-blue-500/20 text-blue-300" : "text-gray-500"
                            }`}>
                              {j.player}
                            </td>
                          );
                        })}
                        <td className={`text-center font-black px-1 py-0.5 ${
                          judgeTotals[ji].player >= judgeTotals[ji].enemy ? "text-blue-300" : "text-gray-500"
                        }`}>
                          {judgeTotals[ji].player}
                        </td>
                      </tr>
                      <tr>
                        <td className="text-red-400 font-bold px-1 truncate max-w-[60px]" title={state.enemy.name || "OPPONENT"}>
                          {(state.enemy.name || "OPPONENT").substring(0, 8)}
                        </td>
                        {state.roundScores.map((score, ri) => {
                          const j = score.judges[ji];
                          const isWinnerCell = j.enemy > j.player;
                          return (
                            <td key={ri} className={`text-center font-bold px-0.5 py-0.5 ${
                              isWinnerCell ? "bg-red-500/20 text-red-300" : "text-gray-500"
                            }`}>
                              {j.enemy}
                            </td>
                          );
                        })}
                        <td className={`text-center font-black px-1 py-0.5 ${
                          judgeTotals[ji].enemy >= judgeTotals[ji].player ? "text-red-300" : "text-gray-500"
                        }`}>
                          {judgeTotals[ji].enemy}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>

        <div className={`mx-3 my-2 rounded-lg border px-3 py-2 text-center ${
          isDraw ? "bg-yellow-500/10 border-yellow-500/30" : isWin ? "bg-blue-500/10 border-blue-500/30" : "bg-red-500/10 border-red-500/30"
        }`}>
          <div className="text-yellow-400 font-black italic uppercase text-xs tracking-wider" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }} data-testid="text-fight-result-stats">
            {isDraw ? "DRAW" : winnerName.toUpperCase()}
          </div>
          <div className="text-white/60 text-[10px] font-bold tracking-widest" data-testid="text-method-stats">
            {decisionType}
          </div>
        </div>

        <div className="border-t border-white/10 px-3 py-2">
          <div className="text-[9px] text-white/40 text-center mb-1 font-semibold uppercase tracking-widest">Fight Stats</div>
          <div className="grid grid-cols-3 gap-1 text-[10px] text-center">
            <span className="text-blue-300 font-bold">{state.player.punchesThrown}</span>
            <span className="text-gray-500">Thrown</span>
            <span className="text-red-300 font-bold">{state.enemy.punchesThrown}</span>

            <span className="text-blue-300 font-bold">{state.player.punchesLanded}</span>
            <span className="text-gray-500">Landed</span>
            <span className="text-red-300 font-bold">{state.enemy.punchesLanded}</span>

            <span className="text-blue-300 font-bold">{state.player.punchesThrown > 0 ? Math.round(state.player.punchesLanded / state.player.punchesThrown * 100) : 0}%</span>
            <span className="text-gray-500">Accuracy</span>
            <span className="text-red-300 font-bold">{state.enemy.punchesThrown > 0 ? Math.round(state.enemy.punchesLanded / state.enemy.punchesThrown * 100) : 0}%</span>

            <span className="text-blue-300 font-bold">{Math.round(state.player.damageDealt)}</span>
            <span className="text-gray-500">Damage</span>
            <span className="text-red-300 font-bold">{Math.round(state.enemy.damageDealt)}</span>

            <span className="text-blue-300 font-bold">{state.player.knockdowns}</span>
            <span className="text-gray-500">Knockdowns</span>
            <span className="text-red-300 font-bold">{state.enemy.knockdowns}</span>
          </div>
        </div>

        {!state.isQuickFight && (
          <div className="border-t border-white/10 px-3 py-2">
            {forceEarned > 0 && state.careerFightMode && (
              <div className="flex items-center justify-between mb-1.5 bg-yellow-950/50 border border-yellow-700/40 rounded px-2 py-1" data-testid="text-force-earned">
                <span className="text-[10px] text-yellow-300 font-semibold">⚡ Force Earned</span>
                <span className="text-[10px] font-bold text-yellow-300">+{forceEarned >= 1_000_000 ? (forceEarned / 1_000_000).toFixed(1) + "M" : forceEarned >= 1_000 ? (forceEarned / 1_000).toFixed(0) + "k" : forceEarned}</span>
              </div>
            )}
            {diamondsEarned > 0 && state.careerFightMode && (
              <div className="flex items-center justify-between mb-1.5 bg-sky-950/50 border border-sky-700/40 rounded px-2 py-1" data-testid="text-diamonds-earned">
                <span className="text-[10px] text-sky-300 font-semibold">💎 Diamonds Earned</span>
                <span className="text-[10px] font-bold text-sky-300">+{diamondsEarned}</span>
              </div>
            )}
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-gray-400 font-semibold">XP Earned</span>
              <span className="text-[10px] font-bold text-blue-300" data-testid="text-xp-gained">+{state.xpGained} XP</span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${Math.min(100, (currentXp / xpToNext) * 100)}%` }}
              />
            </div>
            <p className="text-[9px] text-gray-500 text-center mt-0.5">{Math.floor(currentXp)} / {Math.floor(xpToNext)} to next level</p>
            {state.midFightLevelUps > 0 && (
              <div className="mt-1.5 bg-yellow-500/20 border border-yellow-500/50 rounded px-2 py-1 text-center" data-testid="fight-end-level-up-banner">
                <span className="text-yellow-300 text-[10px] font-black tracking-wider uppercase">
                  LEVEL UP!
                </span>
              </div>
            )}
            {koTimeBonusDisplay > 0 && (
              <div className="mt-1.5 bg-orange-500/20 border border-orange-500/50 rounded px-2 py-1 text-center" data-testid="fight-end-ko-time-bonus">
                <span className="text-orange-300 text-[10px] font-black tracking-wider uppercase">
                  ⚡ FAST FINISH BONUS +{koTimeBonusDisplay} STAT {koTimeBonusDisplay === 1 ? "POINT" : "POINTS"}
                </span>
                <div className="text-orange-400/70 text-[9px] mt-0.5">KO in {Math.floor(koElapsedSeconds)}s{state.careerFightMode ? " · 3× fight bonus" : ""}</div>
              </div>
            )}
          </div>
        )}

        <div className="p-3 border-t border-white/10 flex gap-2">
          <Button
            onClick={onContinue}
            autoFocus
            className="flex-1 bg-[#634b3b] hover:bg-[#7a5c4a] text-white font-bold"
            data-testid="button-continue"
          >
            Continue
          </Button>
          {state.recordInputs && state.inputRecording && (
            <Button
              onClick={handleDownloadRecording}
              variant="outline"
              size="icon"
              className="border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/20"
              data-testid="button-download-recording"
              title="Download full fight recording"
            >
              <Download className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
