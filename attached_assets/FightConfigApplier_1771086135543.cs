using UnityEngine;
using UnityEngine.UI;
using System.Collections;
[DefaultExecutionOrder(-5000)]
public class FightConfigApplier:MonoBehaviour
{
    public FighterStats playerStats;
    public FighterStats enemyStats;
    public int slotIndex=0;
    public Text enemyNameText;
    public int maxWaitFrames=300;
    public int enforceFrames=180;
    public bool logOnce=true;
    bool didLog;
    void Awake(){GameConfig.EnsureInstance();StartCoroutine(Bootstrap());}
    void OnEnable(){GameConfig.EnsureInstance();StartCoroutine(Bootstrap());}
    IEnumerator Bootstrap()
    {
        int w=0;
        while(w<maxWaitFrames)
        {
            ResolveStatsRefs();
            if(playerStats!=null&&enemyStats!=null) break;
            w++;
            yield return null;
        }
        for(int i=0;i<enforceFrames;i++)
        {
            ApplyAll();
            yield return null;
        }
        SnapFighterToFull(playerStats);
        SnapFighterToFull(enemyStats);
    }
    void ApplyAll()
    {
        var cfg=GameConfig.EnsureInstance();
        if(cfg==null) return;
        ResolveStatsRefs();
        ApplyCareerConfigToGameConfigIfNeeded(cfg);
        ApplyLevels(cfg);
        ApplyDifficulty(cfg);
        ApplyEnemyNameFromCareerSlot();
        ForceControllersRefresh();
        if(logOnce&&!didLog&&playerStats!=null&&enemyStats!=null)
        {
            didLog=true;
            Debug.Log($"FightConfigApplier Applied P{cfg.playerLevel} E{cfg.enemyLevel} Diff{cfg.enemyDifficulty} Career{IsCareerFightActive()} Slot{slotIndex}");
        }
    }
    bool IsCareerFightActive()
    {
        return (CareerManager.Instance!=null && CareerManager.Instance.IsCareerFightActive() && CareerManager.Instance.HasActiveSlot());
    }
    void ApplyCareerConfigToGameConfigIfNeeded(GameConfig cfg)
    {
        if(!IsCareerFightActive()) return;
        slotIndex=CareerManager.Instance.GetActiveSlot();
        var p=CareerManager.Instance.GetProfile();
        var f=CareerManager.Instance.GetSelectedRosterFighter();
        if(p==null||f==null) return;
        cfg.SetPlayerLevel(Mathf.Clamp(p.playerLevel,1,100));
        cfg.SetEnemyLevel(Mathf.Clamp(f.level,1,100));
        cfg.SetEnemyDifficulty(CareerManager.Instance.GetPendingDifficulty());
        cfg.SetRandomizeEnemyClassEachFight(false);
    }
    void ApplyEnemyNameFromCareerSlot()
    {
        if(enemyNameText==null) return;
        if(IsCareerFightActive()) slotIndex=CareerManager.Instance.GetActiveSlot();
        CareerRosterSystem.EnsureInstance();
        var sys=CareerRosterSystem.Instance;
        if(sys==null){enemyNameText.text="Enemy";return;}
        var slot=sys.LoadOrCreate(slotIndex);
        var f=(slot!=null)?sys.GetSelectedFighter(slot):null;
        enemyNameText.text=(f!=null&&!string.IsNullOrEmpty(f.name))?f.name:"Enemy";
    }
    void ResolveStatsRefs()
    {
        if(playerStats==null)
        {
            GameObject p=GameObject.FindWithTag("Player");
            if(p!=null) playerStats=p.GetComponentInChildren<FighterStats>(true);
        }
        if(enemyStats==null)
        {
            GameObject e=GameObject.FindWithTag("Enemy");
            if(e!=null) enemyStats=e.GetComponentInChildren<FighterStats>(true);
        }
        if(playerStats==null||enemyStats==null)
        {
            FighterController[] fcs=FindObjectsByType<FighterController>(FindObjectsSortMode.None);
            FighterController pc=null;
            FighterController ec=null;
            for(int i=0;i<fcs.Length;i++)
            {
                var fc=fcs[i];
                if(fc==null) continue;
                if(pc==null&&fc.isPlayerControlled) pc=fc;
                else if(ec==null&&!fc.isPlayerControlled) ec=fc;
            }
            if(pc==null||ec==null)
            {
                for(int i=0;i<fcs.Length;i++)
                {
                    var fc=fcs[i];
                    if(fc==null) continue;
                    if(pc==null&&fc.GetComponentInChildren<AiBrain>(true)==null) pc=fc;
                    else if(ec==null&&fc.GetComponentInChildren<AiBrain>(true)!=null) ec=fc;
                }
            }
            if(playerStats==null&&pc!=null) playerStats=pc.GetComponentInChildren<FighterStats>(true);
            if(enemyStats==null&&ec!=null) enemyStats=ec.GetComponentInChildren<FighterStats>(true);
        }
        if(playerStats==null||enemyStats==null)
        {
            FighterStats[] all=FindObjectsByType<FighterStats>(FindObjectsSortMode.None);
            if(all!=null&&all.Length>=2)
            {
                if(playerStats==null) playerStats=all[0];
                if(enemyStats==null)
                {
                    for(int i=0;i<all.Length;i++){if(all[i]!=null&&all[i]!=playerStats){enemyStats=all[i];break;}}
                }
            }
        }
    }
    GameObject GetFighterRootFor(FighterStats s)
    {
        if(s==null) return null;
        FighterController fc=s.GetComponentInParent<FighterController>();
        if(fc!=null) return fc.gameObject;
        AiBrain ab=s.GetComponentInParent<AiBrain>();
        if(ab!=null) return ab.gameObject;
        return s.transform.root!=null?s.transform.root.gameObject:s.gameObject;
    }
    LevelController EnsureLevelControllerOnRoot(FighterStats s)
    {
        if(s==null) return null;
        GameObject root=GetFighterRootFor(s);
        if(root==null) return null;
        LevelController lc=root.GetComponent<LevelController>();
        if(lc==null) lc=root.AddComponent<LevelController>();
        return lc;
    }
    void ApplyLevels(GameConfig cfg)
    {
        if(playerStats!=null)
        {
            LevelController plc=EnsureLevelControllerOnRoot(playerStats);
            if(plc!=null) plc.level=Mathf.Clamp(cfg.playerLevel,1,100);
        }
        if(enemyStats!=null)
        {
            LevelController elc=EnsureLevelControllerOnRoot(enemyStats);
            if(elc!=null) elc.level=Mathf.Clamp(cfg.enemyLevel,1,100);
        }
    }
    void ApplyDifficulty(GameConfig cfg)
    {
        if(enemyStats==null) return;
        AiBrain brain=enemyStats.GetComponentInParent<AiBrain>();
        if(brain==null) brain=enemyStats.GetComponentInChildren<AiBrain>(true);
        if(brain==null) return;
        switch(cfg.enemyDifficulty)
        {
            case GameConfig.DifficultyBand.Easy: brain.difficultyBand=AiBrain.DifficultyBand.Easy; brain.difficultyScore=0.25f; break;
            case GameConfig.DifficultyBand.Normal: brain.difficultyBand=AiBrain.DifficultyBand.Medium; brain.difficultyScore=0.50f; break;
            case GameConfig.DifficultyBand.Hard: brain.difficultyBand=AiBrain.DifficultyBand.Hard; brain.difficultyScore=0.85f; break;
            case GameConfig.DifficultyBand.Hardcore: brain.difficultyBand=AiBrain.DifficultyBand.Hard; brain.difficultyScore=0.98f; break;
        }
    }
    void ForceControllersRefresh()
    {
        if(playerStats!=null){FighterController fc=playerStats.GetComponentInParent<FighterController>();if(fc!=null) fc.ForceRefreshLevelController();}
        if(enemyStats!=null){FighterController fc=enemyStats.GetComponentInParent<FighterController>();if(fc!=null) fc.ForceRefreshLevelController();}
    }
    void SnapFighterToFull(FighterStats stats)
    {
        if(stats==null) return;
        LevelController lc=EnsureLevelControllerOnRoot(stats);
        if(lc!=null) lc.level=Mathf.Clamp(lc.level,1,100);
        stats.ResetStaminaToMax(true);
    }
}
