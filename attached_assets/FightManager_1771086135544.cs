using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using System;
using System.Reflection;
public class FightManager:MonoBehaviour
{
    [Header("Round / Fight Settings")]
    [Tooltip("Number of rounds in the fight.")]
    public int totalRounds=3;
    [Tooltip("Round duration in seconds (3:00 = 180).")]
    public float roundDurationSeconds=180f;
    [Tooltip("Ring horizontal limits (fighters can occupy anywhere between -ringHalfWidth and +ringHalfWidth).")]
    public float ringHalfWidth=7.5f;
    [Tooltip("Player starting X position each round (typically -7.5).")]
    public float playerStartX=-7.5f;
    [Tooltip("Enemy starting X position each round (typically +7.5).")]
    public float enemyStartX=7.5f;
    [Tooltip("Center X positions used for final decision pose.")]
    public float playerCenterX=-3.5f;
    public float enemyCenterX=3.5f;
    [Header("KD / KO Settings")]
    [Tooltip("Threshold (as fraction of ENEMY max stamina) where enemy can be instantly KD'ed if hit.")]
    [Range(0f,0.5f)]
    public float enemyInstantKDThreshold=0.03f;
    [Header("Get-Up Stamina Rules (by KD count)")]
    [Range(0f,1f)] public float getupStaminaFractionKD1=0.30f;
    [Range(0f,1f)] public float getupStaminaFractionKD2=0.25f;
    [Range(0f,1f)] public float getupStaminaFractionKD3Plus=0.20f;
    [Header("AI Get-Up Stamina Bonus (Enemy Only)")]
    [Range(0f,0.5f)] public float aiGetupBonusMedium=0.05f;
    [Range(0f,0.5f)] public float aiGetupBonusHard=0.10f;
    [Range(0f,0.5f)] public float aiGetupBonusHardcore=0.20f;
    [Header("AI Get-Up Chance Bonus (Enemy Only)")]
    [Tooltip("Extra get-up CHANCE added (on top of aiGetupEasy/Medium/Hard/Hardcore) for KD1-3. This stacks with the level boost.")]
    [Range(0f,0.5f)] public float aiGetupChanceBonusMedium=0.00f;
    [Range(0f,0.5f)] public float aiGetupChanceBonusHard=0.00f;
    [Range(0f,0.5f)] public float aiGetupChanceBonusHardcore=0.00f;
    [Header("Hardcore Detection")]
    [Tooltip("Enemy is considered Hardcore if difficultyBand is Hard and difficultyScore >= this threshold.")]
    [Range(0.70f,1.00f)]
    public float hardcoreScoreThreshold=0.90f;
    [System.Serializable]
    public class AiGetupChancesPerKD
    {
        [Range(0f,1f)] public float kd1=0.60f;
        [Range(0f,1f)] public float kd2=0.35f;
        [Range(0f,1f)] public float kd3Plus=0.15f;
        public float GetChance(int kdNumber)
        {
            if(kdNumber<=1) return Mathf.Clamp01(kd1);
            if(kdNumber==2) return Mathf.Clamp01(kd2);
            return Mathf.Clamp01(kd3Plus);
        }
    }
    [Header("AI Get-Up Chances (Enemy Only)")]
    [Tooltip("Chance the ENEMY gets up at KD1/KD2/KD3+ for Easy difficulty.")]
    public AiGetupChancesPerKD aiGetupEasy=new AiGetupChancesPerKD{kd1=0.55f,kd2=0.25f,kd3Plus=0.08f};
    [Tooltip("Chance the ENEMY gets up at KD1/KD2/KD3+ for Medium difficulty.")]
    public AiGetupChancesPerKD aiGetupMedium=new AiGetupChancesPerKD{kd1=0.70f,kd2=0.45f,kd3Plus=0.20f};
    [Tooltip("Chance the ENEMY gets up at KD1/KD2/KD3+ for Hard difficulty.")]
    public AiGetupChancesPerKD aiGetupHard=new AiGetupChancesPerKD{kd1=0.85f,kd2=0.65f,kd3Plus=0.35f};
    [Tooltip("Chance the ENEMY gets up at KD1/KD2/KD3+ for Hardcore difficulty.")]
    public AiGetupChancesPerKD aiGetupHardcore=new AiGetupChancesPerKD{kd1=0.95f,kd2=0.80f,kd3Plus=0.55f};
    [Header("Early-KD Rule (Round 1 Only)")]
    public float earlyKDElapsedSeconds=10f;
    [Range(0f,1f)] public float earlyKDMaxGetupChance=0.25f;
    [Header("Fighters")]
    public FighterStats playerStats;
    public FighterStats enemyStats;
    public FighterController playerController;
    public FighterController enemyController;
    [Header("UI - In-fight")]
public Text labelPlayerName;
public Text labelEnemyName;
    public Slider playerStaminaSlider;
    public Slider enemyStaminaSlider;
    public Text roundTimerText;
    [Header("UI - Charge Meters (under stamina)")]
    public Slider playerChargeSlider;
    public Slider enemyChargeSlider;
    [Header("UI - Levels (next to stamina bars)")]
    public Text playerLevelText;
    public Text enemyLevelText;
    [Header("KD UI")]
    public Text kdCountdownText;
    [Header("Between-Round UI")]
    public GameObject betweenRoundPanel;
    public Text betweenRoundTitleText;
    public Text betweenRoundJudgeScoreText;
    public Text betweenRoundPlayerStatsText;
    public Text betweenRoundEnemyStatsText;
    [Header("Between-Round Buttons")]
    public GameObject continueButton;
    [Header("Scorecard UI (Within BetweenRoundPanel)")]
    public Text[] playerScorecardRoundTexts=new Text[12];
    public Text[] enemyScorecardRoundTexts=new Text[12];
    public Text playerScorecardPunchStatsText;
    public Text enemyScorecardPunchStatsText;
    public GameObject scorecardBackButton;
    [Header("Final Decision UI")]
public GameObject decisionPanel;
public Text decisionTitleText;
public Text decisionDetailText;
public GameObject decisionRestartButtonObject;
public Text decisionXPText;
[Header("Pause UI")]
public GameObject pausePanel;
public GameObject pauseRestartButtonObject;
    [Header("Rhythm - Round Start Rules")]
    [Tooltip("Optional. If not assigned, FightManager will FindObjectOfType<TimeBasedRNG>().")]
    public TimeBasedRNG timeBasedRNG;
    private RhythmController playerRhythm;
    private RhythmController enemyRhythm;
    private bool rolledFightRhythmVariance=false;
    [Header("Round Stamina Cap (Round 2+)")]
    [Tooltip("If enabled, Round 2+ max stamina is permanently capped down each round based on last round's workload/damage.")]
    public bool useRoundStaminaCap=true;
    [Tooltip("Flat max-stamina reduction applied at the start of Round 2+ (percent of max stamina). Example: 0.5 = 0.5%.")]
    public float roundCapBasePercent=0.5f;
    [Tooltip("Additional reduction per punch TAKEN last round (blocked or not). Percent per punch.")]
    public float roundCapPerPunchTakenPercent=0.01f;
    [Tooltip("Additional reduction per WHIFF thrown last round. Percent per whiff.")]
    public float roundCapPerWhiffPercent=0.01f;
    [Tooltip("Additional reduction per BLOCKED punch you threw last round (i.e., landed but was blocked). Percent per blocked punch.")]
    public float roundCapPerBlockedThrownPercent=0.01f;
    [Tooltip("Additional reduction per CHARGE punch you threw last round. Percent per charge punch.")]
    public float roundCapPerChargeThrownPercent=0.01f;
    [Tooltip("Additional reduction per second of left/right movement last round (cumulative). Percent per second.")]
    public float roundCapPerMoveSecondPercent=0.01f;
    [Tooltip("Minimum max-stamina fraction allowed after capping (safety clamp). 0.40 = can't drop below 40% of original max.")]
    [Range(0.05f,1f)]
    public float roundCapMinFractionOfOriginal=0.25f;
    [Header("Round Stamina Cap UI (Optional)")]
    [Tooltip("Optional: A thin Image/RectTransform that marks the cap position on the stamina bar. Anchor it on the slider's fill area.")]
    public RectTransform playerStaminaCapMarker;
    public RectTransform enemyStaminaCapMarker;
    private float currentRoundTime;
    private bool fightOver=false;
    private bool roundActive=true;
    private int currentRound=1;
    private bool isPaused=false;
    private bool uiPanelPauseActive=false;
    private bool kdInProgress=false;
    private bool kdDefenderIsPlayer=false;
    private float kdTimerSeconds=0f;
    private int playerKDCount=0;
    private int enemyKDCount=0;
    private bool pendingRoundEndAtBell=false;
    private float prevPlayerStamina;
    private float prevEnemyStamina;
    private int playerMashCount=0;
    private int playerMashTarget=0;
    private bool aiWillGetUp=false;
    private float aiPlannedGetupTime=0f;
    private bool aiGetUpTriggered=false;
    private bool earlyKDActiveThisKnockdown=false;
    private LevelController enemyLevelController;
    private LevelController playerLevelController;
    private int stoppingRound=0;
    private AiBrain enemyBrain;
    private CritController playerCritController;
    private CritController enemyCritController;
    [System.Serializable]
    public class PerRoundStats
    {
        public int punchesThrown;
        public int punchesLanded;
        public int cleanHitsLanded;
        public int blockedHitsLanded;
        public float damageDealt;
        public float damageTaken;
        public int kdsScored;
    }
    private PerRoundStats[] playerRoundStats;
    private PerRoundStats[] enemyRoundStats;
    private int[] playerRoundScores;
    private int[] enemyRoundScores;
    private int unansweredPunchesReceivedByPlayer=0;
    private int unansweredPunchesReceivedByEnemy=0;
    private enum FightResultType{None,KO,TKO,Decision,Draw}
    private enum FightResultWinner{None,Player,Enemy}
    private FightResultType resultType=FightResultType.None;
    private FightResultWinner resultWinner=FightResultWinner.None;
    private float playerOriginalMaxStamina=0f;
    private float enemyOriginalMaxStamina=0f;
    private float playerRoundCapValue=-1f;
    private float enemyRoundCapValue=-1f;
    private int playerPunchesTakenThisRound=0;
    private int enemyPunchesTakenThisRound=0;
    private int playerWhiffsThisRound=0;
    private int enemyWhiffsThisRound=0;
    private int playerChargeThrownThisRound=0;
    private int enemyChargeThrownThisRound=0;
    private float playerMoveSecondsThisRound=0f;
    private float enemyMoveSecondsThisRound=0f;
    private int playerBlockedThrownThisRound=0;
    private int enemyBlockedThrownThisRound=0;
    private int playerSuccessfulBlocksThisFight=0;
    private int enemySuccessfulBlocksThisFight=0;
    private int playerSuccessfulWeavesThisFight=0;
    private int enemySuccessfulWeavesThisFight=0;
    private bool fightEndNotified=false;
    public bool WasDraw(){return resultType==FightResultType.Draw;}
    public bool DidPlayerWin(){return resultWinner==FightResultWinner.Player;}
    private CareerFightResultReceiver careerResultReceiver=null;
private int careerXpGained=-1;
public void SetCareerXPGained(int xp){careerXpGained=Mathf.Max(0,xp);}
    private struct RoundCapData
    {
        public int punchesTaken;
        public int whiffsThrown;
        public int blockedThrown;
        public int chargeThrown;
        public float moveSeconds;
    }
    private RoundCapData[] playerCapData;
    private RoundCapData[] enemyCapData;
    void Start()
    {
        Time.timeScale=1f;
        ApplyCareerConfigIfNeeded();
if(IsCareerMode())
{
    var p=CareerManager.Instance.GetProfile();
    var f=CareerManager.Instance.GetSelectedRosterFighter();
    if(labelPlayerName!=null) labelPlayerName.text=p.playerLastName;
    if(labelEnemyName!=null&&f!=null) labelEnemyName.text=f.name;
}
        careerResultReceiver=GetComponent<CareerFightResultReceiver>();
        isPaused=false;
        uiPanelPauseActive=false;
        currentRoundTime=roundDurationSeconds;
        if(playerController==null&&playerStats!=null) playerController=playerStats.GetComponent<FighterController>();
        if(enemyController==null&&enemyStats!=null) enemyController=enemyStats.GetComponent<FighterController>();
        if(enemyStats!=null) enemyLevelController=LevelController.GetFor(enemyStats);
        if(playerStats!=null) playerLevelController=LevelController.GetFor(playerStats);
        if(enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
        playerCritController=GetCritControllerFor(playerStats);
        enemyCritController=GetCritControllerFor(enemyStats);
        ForceFullStaminaAtFightStart();
        if(playerStats!=null) prevPlayerStamina=playerStats.currentStamina;
        if(enemyStats!=null) prevEnemyStamina=enemyStats.currentStamina;
        if(playerStaminaSlider!=null&&playerStats!=null)
        {
            playerStaminaSlider.minValue=0f;
            playerStaminaSlider.maxValue=playerStats.maxStamina;
            playerStaminaSlider.value=playerStats.currentStamina;
        }
        if(enemyStaminaSlider!=null&&enemyStats!=null)
        {
            enemyStaminaSlider.minValue=0f;
            enemyStaminaSlider.maxValue=enemyStats.maxStamina;
            enemyStaminaSlider.value=enemyStats.currentStamina;
        }
        InitChargeSlider(playerChargeSlider);
        InitChargeSlider(enemyChargeSlider);
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
        if(decisionPanel!=null) decisionPanel.SetActive(false);
        if(scorecardBackButton!=null) scorecardBackButton.SetActive(false);
        if(pausePanel!=null) pausePanel.SetActive(false);
        if(continueButton!=null) continueButton.SetActive(false);
        playerRoundStats=new PerRoundStats[totalRounds];
        enemyRoundStats=new PerRoundStats[totalRounds];
        playerRoundScores=new int[totalRounds];
        enemyRoundScores=new int[totalRounds];
        for(int i=0;i<totalRounds;i++)
        {
            playerRoundStats[i]=new PerRoundStats();
            enemyRoundStats[i]=new PerRoundStats();
            playerRoundScores[i]=0;
            enemyRoundScores[i]=0;
        }
        playerCapData=new RoundCapData[totalRounds];
        enemyCapData=new RoundCapData[totalRounds];
        if(playerStats!=null&&playerOriginalMaxStamina<=0f) playerOriginalMaxStamina=playerStats.maxStamina;
        if(enemyStats!=null&&enemyOriginalMaxStamina<=0f) enemyOriginalMaxStamina=enemyStats.maxStamina;
        playerRoundCapValue=-1f;
        enemyRoundCapValue=-1f;
        ResetRoundCapCounters();
        playerSuccessfulBlocksThisFight=0;
        enemySuccessfulBlocksThisFight=0;
        playerSuccessfulWeavesThisFight=0;
        enemySuccessfulWeavesThisFight=0;
        fightEndNotified=false;
        CacheRhythmControllers();
        EnsureTimeBasedRNG();
        RollFightRhythmVarianceOnce();
        ApplyRoundRhythmSettings(currentRound);
        StartRoundChargeCooldown();
        UpdateTimerUI();
        UpdateStaminaUI();
        UpdateLevelUI();
        UpdateChargeUI();
        UpdateCapMarkerUI();
    }
    void Update()
    {
        if(!fightOver&&!uiPanelPauseActive&&Input.GetKeyDown(KeyCode.Escape))
        {
            if(isPaused) ResumeFromPause();
            else PauseGame();
        }
        if(fightOver||isPaused||uiPanelPauseActive) return;
        if(!roundActive) return;
        TrackMoveSeconds();
        currentRoundTime-=Time.deltaTime;
        if(currentRoundTime<0f) currentRoundTime=0f;
        UpdateTimerUI();
        UpdateStaminaUI();
        UpdateLevelUI();
        UpdateChargeUI();
        if(kdInProgress&&currentRoundTime<=0f) pendingRoundEndAtBell=true;
        if(kdInProgress)
        {
            UpdateKDState();
            UpdateStaminaUI();
            UpdateLevelUI();
            UpdateChargeUI();
            CheckDeferredRoundEndAfterKD();
            return;
        }
        if(currentRoundTime<=0f)
        {
            OnRoundTimeExpired();
            return;
        }
        CheckForKnockdowns();
    }
    void ForceFullStaminaAtFightStart()
    {
        if(playerStats!=null)
        {
            if(playerOriginalMaxStamina<=0f) playerOriginalMaxStamina=playerStats.maxStamina;
            playerStats.currentStamina=playerStats.maxStamina;
        }
        if(enemyStats!=null)
        {
            if(enemyOriginalMaxStamina<=0f) enemyOriginalMaxStamina=enemyStats.maxStamina;
            enemyStats.currentStamina=enemyStats.maxStamina;
        }
    }
    void TrackMoveSeconds()
    {
        const float VEL_THRESH=0.10f;
        if(playerController!=null)
        {
            Rigidbody2D rb=playerController.GetComponent<Rigidbody2D>();
            if(rb==null) rb=playerController.GetComponentInChildren<Rigidbody2D>();
            if(rb!=null&&Mathf.Abs(rb.linearVelocity.x)>VEL_THRESH) playerMoveSecondsThisRound+=Time.deltaTime;
        }
        if(enemyController!=null)
        {
            Rigidbody2D rb=enemyController.GetComponent<Rigidbody2D>();
            if(rb==null) rb=enemyController.GetComponentInChildren<Rigidbody2D>();
            if(rb!=null&&Mathf.Abs(rb.linearVelocity.x)>VEL_THRESH) enemyMoveSecondsThisRound+=Time.deltaTime;
        }
    }
    float ComputeCappedMaxStamina(float currentMax,float originalMax,RoundCapData data)
    {
        if(!useRoundStaminaCap) return currentMax;
        float totalPercent=Mathf.Max(0f,roundCapBasePercent)+Mathf.Max(0f,roundCapPerPunchTakenPercent)*data.punchesTaken+Mathf.Max(0f,roundCapPerWhiffPercent)*data.whiffsThrown+Mathf.Max(0f,roundCapPerBlockedThrownPercent)*data.blockedThrown+Mathf.Max(0f,roundCapPerChargeThrownPercent)*data.chargeThrown+Mathf.Max(0f,roundCapPerMoveSecondPercent)*Mathf.Max(0f,data.moveSeconds);
        float reductionFrac=Mathf.Clamp01(totalPercent/100f);
        float newMax=currentMax*(1f-reductionFrac);
        float minAllowed=Mathf.Max(1f,originalMax*Mathf.Clamp01(roundCapMinFractionOfOriginal));
        if(newMax<minAllowed) newMax=minAllowed;
        return Mathf.Max(1f,newMax);
    }
    void ApplyRoundCapAtRoundStart(FighterStats stats,bool isPlayer,RoundCapData prevRoundData)
    {
        if(stats==null) return;
        float original=isPlayer?playerOriginalMaxStamina:enemyOriginalMaxStamina;
        float newMax=ComputeCappedMaxStamina(stats.maxStamina,original,prevRoundData);
        stats.maxStamina=newMax;
        stats.currentStamina=newMax;
        if(isPlayer) playerRoundCapValue=newMax;
        else enemyRoundCapValue=newMax;
        UpdateCapMarkerUI();
    }
    void ResetRoundCapCounters()
    {
        playerPunchesTakenThisRound=0;
        enemyPunchesTakenThisRound=0;
        playerWhiffsThisRound=0;
        enemyWhiffsThisRound=0;
        playerChargeThrownThisRound=0;
        enemyChargeThrownThisRound=0;
        playerMoveSecondsThisRound=0f;
        enemyMoveSecondsThisRound=0f;
        playerBlockedThrownThisRound=0;
        enemyBlockedThrownThisRound=0;
    }
    void SaveRoundCapDataForRoundIndex(int roundIndex)
    {
        if(roundIndex<0||roundIndex>=totalRounds) return;
        playerCapData[roundIndex]=new RoundCapData{punchesTaken=playerPunchesTakenThisRound,whiffsThrown=playerWhiffsThisRound,blockedThrown=playerBlockedThrownThisRound,chargeThrown=playerChargeThrownThisRound,moveSeconds=playerMoveSecondsThisRound};
        enemyCapData[roundIndex]=new RoundCapData{punchesTaken=enemyPunchesTakenThisRound,whiffsThrown=enemyWhiffsThisRound,blockedThrown=enemyBlockedThrownThisRound,chargeThrown=enemyChargeThrownThisRound,moveSeconds=enemyMoveSecondsThisRound};
    }
    void UpdateCapMarkerUI()
    {
        UpdateCapMarkerFor(playerStaminaSlider,playerStaminaCapMarker,playerStats);
        UpdateCapMarkerFor(enemyStaminaSlider,enemyStaminaCapMarker,enemyStats);
    }
    void UpdateCapMarkerFor(Slider slider,RectTransform marker,FighterStats stats)
    {
        if(slider==null||marker==null||stats==null) return;
        float max=Mathf.Max(0.0001f,slider.maxValue);
        float cap=stats.maxStamina;
        float t=Mathf.Clamp01(cap/max);
        RectTransform parent=marker.parent as RectTransform;
        if(parent==null) return;
        float width=parent.rect.width;
        Vector2 anchored=marker.anchoredPosition;
        anchored.x=(t*width)-(width*0.5f);
        marker.anchoredPosition=anchored;
        marker.gameObject.SetActive(true);
    }
    public void RegisterWhiff(bool attackerIsPlayer)
    {
        if(!roundActive||fightOver) return;
        if(attackerIsPlayer) playerWhiffsThisRound++;
        else enemyWhiffsThisRound++;
    }
    public void RegisterChargePunchThrown(bool attackerIsPlayer)
    {
        if(!roundActive||fightOver) return;
        if(attackerIsPlayer) playerChargeThrownThisRound++;
        else enemyChargeThrownThisRound++;
    }
    public void RegisterSuccessfulWeave(bool defenderIsPlayer)
    {
        if(!roundActive||fightOver) return;
        if(defenderIsPlayer) playerSuccessfulWeavesThisFight++;
        else enemySuccessfulWeavesThisFight++;
    }
    void CacheRhythmControllers()
    {
        playerRhythm=null;
        enemyRhythm=null;
        if(playerStats!=null)
        {
            playerRhythm=playerStats.GetComponentInChildren<RhythmController>();
            if(playerRhythm==null) playerRhythm=playerStats.GetComponentInParent<RhythmController>();
            if(playerRhythm==null) playerRhythm=playerStats.GetComponent<RhythmController>();
        }
        if(enemyStats!=null)
        {
            enemyRhythm=enemyStats.GetComponentInChildren<RhythmController>();
            if(enemyRhythm==null) enemyRhythm=enemyStats.GetComponentInParent<RhythmController>();
            if(enemyRhythm==null) enemyRhythm=enemyStats.GetComponent<RhythmController>();
        }
    }
    void EnsureTimeBasedRNG()
    {
        if(timeBasedRNG!=null) return;
        timeBasedRNG=FindObjectOfType<TimeBasedRNG>();
    }
    float RNG01()
{
    EnsureTimeBasedRNG();
    if(timeBasedRNG!=null) return Mathf.Clamp01(timeBasedRNG.Range(0f,1f));
    return 0.5f;
}
float RNGRange(float minInclusive,float maxInclusive)
{
    EnsureTimeBasedRNG();
    if(timeBasedRNG!=null) return timeBasedRNG.Range(minInclusive,maxInclusive);
    return Mathf.Lerp(minInclusive,maxInclusive,0.5f);
}
    void RollFightRhythmVarianceOnce()
    {
        if(rolledFightRhythmVariance) return;
        rolledFightRhythmVariance=true;
        if(playerRhythm!=null) playerRhythm.RollPerFightAnimSpeed(timeBasedRNG);
        if(enemyRhythm!=null) enemyRhythm.RollPerFightAnimSpeed(timeBasedRNG);
    }
    void ApplyRoundRhythmSettings(int roundNumber)
    {
        if(playerRhythm!=null) playerRhythm.ApplyRoundAnimSpeedFatigue(roundNumber);
        if(enemyRhythm!=null) enemyRhythm.ApplyRoundAnimSpeedFatigue(roundNumber);
        if(playerRhythm!=null) playerRhythm.ForceRhythmSpeed(2,resetPhaseToNeutral:true);
    }
    void UpdateLevelUI()
    {
        if(playerLevelController==null&&playerStats!=null) playerLevelController=LevelController.GetFor(playerStats);
        if(enemyLevelController==null&&enemyStats!=null) enemyLevelController=LevelController.GetFor(enemyStats);
        if(playerLevelText!=null)
        {
            int lv=(playerLevelController!=null)?Mathf.Clamp(playerLevelController.level,1,100):1;
            playerLevelText.text=$"Lv {lv}";
        }
        if(enemyLevelText!=null)
        {
            int lv=(enemyLevelController!=null)?Mathf.Clamp(enemyLevelController.level,1,100):1;
            enemyLevelText.text=$"Lv {lv}";
        }
    }
    void InitChargeSlider(Slider s)
    {
        if(s==null) return;
        s.minValue=0f;
        s.maxValue=1f;
        s.value=0f;
    }
    void UpdateChargeUI()
    {
        if(playerCritController==null) playerCritController=GetCritControllerFor(playerStats);
        if(enemyCritController==null) enemyCritController=GetCritControllerFor(enemyStats);
        UpdateChargeSliderFromCrit(playerChargeSlider,playerCritController);
        UpdateChargeSliderFromCrit(enemyChargeSlider,enemyCritController);
    }
    void UpdateChargeSliderFromCrit(Slider slider,CritController cc)
    {
        if(slider==null) return;
        if(cc==null){slider.value=0f;return;}
        float cdDur=Mathf.Max(0.0001f,cc.chargeCooldownDuration);
        float cdRem=Mathf.Max(0f,cc.chargeCooldownRemaining);
        float rwDur=Mathf.Max(0.0001f,cc.chargeReadyWindowDuration);
        float rwRem=Mathf.Max(0f,cc.chargeReadyWindowRemaining);
        if(cdRem>0f){float t=1f-Mathf.Clamp01(cdRem/cdDur);slider.value=t;}
        else if(rwRem>0f){float t=Mathf.Clamp01(rwRem/rwDur);slider.value=t;}
        else slider.value=1f;
    }
    CritController GetCritControllerFor(FighterStats stats)
    {
        if(stats==null) return null;
        CritController cc=stats.GetComponentInParent<CritController>();
        if(cc==null) cc=stats.GetComponent<CritController>();
        if(cc==null) cc=stats.GetComponentInChildren<CritController>();
        return cc;
    }
void PauseGame()
{
    isPaused=true;
    Time.timeScale=0f;
    if(pausePanel!=null) pausePanel.SetActive(true);
    if(pauseRestartButtonObject!=null) pauseRestartButtonObject.SetActive(!IsCareerMode());
    FreezeFighters(true);
    StopFighterMotion(playerController);
    StopFighterMotion(enemyController);
}
    void ResumeFromPause()
    {
        isPaused=false;
        Time.timeScale=1f;
        if(pausePanel!=null) pausePanel.SetActive(false);
        if(!fightOver&&!kdInProgress&&roundActive) FreezeFighters(false);
    }
    void SetUIPanelPause(bool active)
    {
        uiPanelPauseActive=active;
        if(active)
        {
            Time.timeScale=0f;
            FreezeFighters(true);
            StopFighterMotion(playerController);
            StopFighterMotion(enemyController);
            if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
            if(enemyBrain!=null) enemyBrain.enabled=false;
            if(playerStats!=null)
            {
                AiBrain pb=playerStats.GetComponentInParent<AiBrain>();
                if(pb!=null) pb.enabled=false;
            }
        }
        else
        {
            Time.timeScale=1f;
            if(!fightOver&&roundActive&&!kdInProgress)
            {
                if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
                if(enemyBrain!=null) enemyBrain.enabled=true;
                FreezeFighters(false);
            }
        }
    }
    void OnRoundTimeExpired()
    {
        if(kdInProgress){pendingRoundEndAtBell=true;return;}
        roundActive=false;
        pendingRoundEndAtBell=false;
        if(currentRound<totalRounds) EndRound_ShowBetweenRoundPanel();
        else{ScoreCurrentRoundIfNeeded();EndFightByDecision();}
    }
    void CheckDeferredRoundEndAfterKD()
    {
        if(fightOver) return;
        if(!pendingRoundEndAtBell) return;
        if(kdInProgress) return;
        if(currentRoundTime>0f){pendingRoundEndAtBell=false;return;}
        pendingRoundEndAtBell=false;
        OnRoundTimeExpired();
    }
    void EndRound_ShowBetweenRoundPanel()
    {
        int idx=currentRound-1;
        SaveRoundCapDataForRoundIndex(idx);
        FreezeFighters(true);
        StopFighterMotion(playerController);
        StopFighterMotion(enemyController);
        MoveFightersToStartingPositions();
        ScoreCurrentRoundIfNeeded();
        if(betweenRoundPanel!=null)
        {
            if(betweenRoundTitleText!=null) betweenRoundTitleText.text=$"End of Round {currentRound}";
            if(betweenRoundJudgeScoreText!=null)
            {
                int pScore=playerRoundScores[idx];
                int eScore=enemyRoundScores[idx];
                betweenRoundJudgeScoreText.text=$"Judge: Player {pScore} – {eScore} Enemy";
            }
            if(betweenRoundPlayerStatsText!=null)
            {
                var s=playerRoundStats[idx];
                int landed=s.punchesLanded;
                int thrown=s.punchesThrown;
                float acc=(thrown>0)?(100f*landed/thrown):0f;
                betweenRoundPlayerStatsText.text=$"Player (Round {currentRound})\n"+"Thrown: "+thrown+"  Landed: "+landed+" ("+acc.ToString("F0")+"%)\n"+"Clean: "+s.cleanHitsLanded+"  Blocked: "+s.blockedHitsLanded+"\n"+"Damage Dealt: "+s.damageDealt.ToString("F1")+"\n"+"KDs Scored: "+s.kdsScored;
            }
            if(betweenRoundEnemyStatsText!=null)
            {
                var s=enemyRoundStats[idx];
                int landed=s.punchesLanded;
                int thrown=s.punchesThrown;
                float acc=(thrown>0)?(100f*landed/thrown):0f;
                betweenRoundEnemyStatsText.text=$"Enemy (Round {currentRound})\n"+"Thrown: "+thrown+"  Landed: "+landed+" ("+acc.ToString("F0")+"%)\n"+"Clean: "+s.cleanHitsLanded+"  Blocked: "+s.blockedHitsLanded+"\n"+"Damage Dealt: "+s.damageDealt.ToString("F1")+"\n"+"KDs Scored: "+s.kdsScored;
            }
            UpdateScorecardUI(postFight:false);
            UpdateScorecardPunchStats(postFight:false);
            if(scorecardBackButton!=null) scorecardBackButton.SetActive(false);
            if(continueButton!=null) continueButton.SetActive(true);
            betweenRoundPanel.SetActive(true);
            SetUIPanelPause(true);
        }
    }
    void StartNextRound()
    {
        currentRound++;
        if(currentRound>totalRounds) return;
        if(enemyBrain!=null) enemyBrain.enabled=true;
        if(useRoundStaminaCap&&currentRound>=2)
        {
            int prevIdx=currentRound-2;
            if(prevIdx>=0&&prevIdx<totalRounds)
            {
                ApplyRoundCapAtRoundStart(playerStats,isPlayer:true,prevRoundData:playerCapData[prevIdx]);
                ApplyRoundCapAtRoundStart(enemyStats,isPlayer:false,prevRoundData:enemyCapData[prevIdx]);
            }
            else
            {
                if(playerStats!=null) playerStats.currentStamina=playerStats.maxStamina;
                if(enemyStats!=null) enemyStats.currentStamina=enemyStats.maxStamina;
            }
        }
        else
        {
            if(playerStats!=null) playerStats.currentStamina=playerStats.maxStamina;
            if(enemyStats!=null) enemyStats.currentStamina=enemyStats.maxStamina;
        }
        currentRoundTime=roundDurationSeconds;
        roundActive=true;
        unansweredPunchesReceivedByPlayer=0;
        unansweredPunchesReceivedByEnemy=0;
        kdInProgress=false;
        kdTimerSeconds=0f;
        aiGetUpTriggered=false;
        earlyKDActiveThisKnockdown=false;
        pendingRoundEndAtBell=false;
        if(playerStats!=null) prevPlayerStamina=playerStats.currentStamina;
        if(enemyStats!=null) prevEnemyStamina=enemyStats.currentStamina;
        ResetRoundCapCounters();
        CacheRhythmControllers();
        EnsureTimeBasedRNG();
        RollFightRhythmVarianceOnce();
        ApplyRoundRhythmSettings(currentRound);
        StartRoundChargeCooldown();
        MoveFightersToStartingPositions();
        FreezeFighters(false);
        UpdateTimerUI();
        UpdateStaminaUI();
        UpdateLevelUI();
        UpdateChargeUI();
        UpdateCapMarkerUI();
    }
    void MoveFightersToStartingPositions()
    {
        if(playerController!=null)
        {
            Vector3 p=playerController.transform.position;
            p.x=playerStartX;
            playerController.transform.position=p;
        }
        if(enemyController!=null)
        {
            Vector3 e=enemyController.transform.position;
            e.x=enemyStartX;
            enemyController.transform.position=e;
        }
    }
    void MoveFightersToCenter()
    {
        if(playerController!=null)
        {
            Vector3 p=playerController.transform.position;
            p.x=playerCenterX;
            playerController.transform.position=p;
        }
        if(enemyController!=null)
        {
            Vector3 e=enemyController.transform.position;
            e.x=enemyCenterX;
            enemyController.transform.position=e;
        }
    }
    void FreezeFighters(bool frozen)
    {
        if(playerController!=null) playerController.SetKnockdownFrozen(frozen);
        if(enemyController!=null) enemyController.SetKnockdownFrozen(frozen);
    }
    void StopFighterMotion(FighterController fc)
    {
        if(fc==null) return;
        Rigidbody2D r=fc.GetComponent<Rigidbody2D>();
        if(r==null) r=fc.GetComponentInChildren<Rigidbody2D>();
        if(r==null) return;
        r.linearVelocity=Vector2.zero;
        r.angularVelocity=0f;
    }
    void LockFightersForPostFight()
    {
        FreezeFighters(true);
        StopFighterMotion(playerController);
        StopFighterMotion(enemyController);
        if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
        if(enemyBrain!=null) enemyBrain.enabled=false;
        if(playerStats!=null)
        {
            AiBrain pb=playerStats.GetComponentInParent<AiBrain>();
            if(pb!=null) pb.enabled=false;
        }
    }
    void ScoreCurrentRoundIfNeeded()
    {
        int idx=currentRound-1;
        if(idx<0||idx>=totalRounds) return;
        if(playerRoundScores[idx]!=0||enemyRoundScores[idx]!=0) return;
        var pStats=playerRoundStats[idx];
        var eStats=enemyRoundStats[idx];
        int pScore=10;
        int eScore=10;
        float damageDiff=pStats.damageDealt-eStats.damageDealt;
        if(Mathf.Abs(damageDiff)<0.01f){pScore=10;eScore=10;}
        else if(damageDiff>0f){pScore=10;eScore=9;}
        else{pScore=9;eScore=10;}
        int kdDiff=pStats.kdsScored-eStats.kdsScored;
        if(kdDiff>0) eScore-=kdDiff;
        else if(kdDiff<0) pScore+=kdDiff;
        pScore=Mathf.Clamp(pScore,7,10);
        eScore=Mathf.Clamp(eScore,7,10);
        playerRoundScores[idx]=pScore;
        enemyRoundScores[idx]=eScore;
    }
    void EndFightByDecision()
    {
        if(fightOver) return;
        int originalRound=currentRound;
        for(int r=1;r<=originalRound;r++){currentRound=r;ScoreCurrentRoundIfNeeded();}
        currentRound=originalRound;
        int playerTotal=0;
        int enemyTotal=0;
        for(int i=0;i<totalRounds;i++){playerTotal+=playerRoundScores[i];enemyTotal+=enemyRoundScores[i];}
        if(playerTotal==enemyTotal){resultType=FightResultType.Draw;resultWinner=FightResultWinner.None;}
        else if(playerTotal>enemyTotal){resultType=FightResultType.Decision;resultWinner=FightResultWinner.Player;}
        else{resultType=FightResultType.Decision;resultWinner=FightResultWinner.Enemy;}
        fightOver=true;
        roundActive=false;
        kdInProgress=false;
        pendingRoundEndAtBell=false;
        if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        if(pausePanel!=null) pausePanel.SetActive(false);
        Time.timeScale=1f;
        LockFightersForPostFight();
        MoveFightersToCenter();
     NotifyFightEndedOnce();
ShowDecisionPanel();
        SetUIPanelPause(true);
    }
    void CheckForKnockdowns()
    {
        if(playerStats==null||enemyStats==null) return;
        float pStam=playerStats.currentStamina;
        float eStam=enemyStats.currentStamina;
        bool enemyJustKDByZero=(eStam<=0f);
        bool playerJustKDByZero=(pStam<=0f);
        bool enemyJustInstantKD=false;
        if(eStam<prevEnemyStamina)
        {
            float frac=enemyStats.maxStamina>0f?(eStam/enemyStats.maxStamina):0f;
            if(frac<=enemyInstantKDThreshold) enemyJustInstantKD=true;
        }
        if(playerJustKDByZero) StartKnockdown(defenderIsPlayer:true,instantKD:false);
        else if(enemyJustKDByZero||enemyJustInstantKD) StartKnockdown(defenderIsPlayer:false,instantKD:enemyJustInstantKD);
        prevPlayerStamina=pStam;
        prevEnemyStamina=eStam;
    }
    void StartKnockdown(bool defenderIsPlayer,bool instantKD)
    {
        if(fightOver) return;
        kdInProgress=true;
        kdDefenderIsPlayer=defenderIsPlayer;
        kdTimerSeconds=0f;
        unansweredPunchesReceivedByPlayer=0;
        unansweredPunchesReceivedByEnemy=0;
        earlyKDActiveThisKnockdown=IsEarlyFirstRoundKD();
        FreezeFighters(true);
        StopFighterMotion(playerController);
        StopFighterMotion(enemyController);
        if(defenderIsPlayer)
        {
            if(enemyController!=null&&playerController!=null)
            {
                float defenderX=playerController.transform.position.x;
                Vector3 attackerPos=enemyController.transform.position;
                attackerPos.x=(defenderX>=0f)?-ringHalfWidth:ringHalfWidth;
                enemyController.transform.position=attackerPos;
            }
            playerKDCount++;
            enemyRoundStats[currentRound-1].kdsScored++;
            SetupPlayerKD();
        }
        else
        {
            if(playerController!=null&&enemyController!=null)
            {
                float defenderX=enemyController.transform.position.x;
                Vector3 attackerPos=playerController.transform.position;
                attackerPos.x=(defenderX>=0f)?-ringHalfWidth:ringHalfWidth;
                playerController.transform.position=attackerPos;
            }
            enemyKDCount++;
            playerRoundStats[currentRound-1].kdsScored++;
            SetupEnemyKD(instantKD);
        }
        if(kdCountdownText!=null)
        {
            kdCountdownText.gameObject.SetActive(true);
            kdCountdownText.text="1";
        }
    }
    void SetupPlayerKD()
    {
        if(playerKDCount>=4)
        {
            if(stoppingRound==0) stoppingRound=currentRound;
            EndFightByKO(FightResultWinner.Enemy);
            return;
        }
        switch(playerKDCount)
        {
            case 1: playerMashTarget=20;break;
            case 2: playerMashTarget=40;break;
            default: playerMashTarget=60;break;
        }
        playerMashCount=0;
    }
    enum EnemyDifficultyTier{Easy,Medium,Hard,Hardcore}
    EnemyDifficultyTier GetEnemyDifficultyTier()
    {
        if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
        if(enemyBrain==null) return EnemyDifficultyTier.Easy;
        bool isHardcore=(enemyBrain.difficultyBand==AiBrain.DifficultyBand.Hard&&enemyBrain.difficultyScore>=hardcoreScoreThreshold);
        if(isHardcore) return EnemyDifficultyTier.Hardcore;
        switch(enemyBrain.difficultyBand)
        {
            case AiBrain.DifficultyBand.Medium: return EnemyDifficultyTier.Medium;
            case AiBrain.DifficultyBand.Hard: return EnemyDifficultyTier.Hard;
            default: return EnemyDifficultyTier.Easy;
        }
    }
    float GetAiGetupChanceFromInspector(int kdNumber)
    {
        EnemyDifficultyTier tier=GetEnemyDifficultyTier();
        switch(tier)
        {
            case EnemyDifficultyTier.Medium: return aiGetupMedium.GetChance(kdNumber);
            case EnemyDifficultyTier.Hard: return aiGetupHard.GetChance(kdNumber);
            case EnemyDifficultyTier.Hardcore: return aiGetupHardcore.GetChance(kdNumber);
            default: return aiGetupEasy.GetChance(kdNumber);
        }
    }
    float GetAiGetupChanceDifficultyBonus()
    {
        EnemyDifficultyTier tier=GetEnemyDifficultyTier();
        switch(tier)
        {
            case EnemyDifficultyTier.Medium: return aiGetupChanceBonusMedium;
            case EnemyDifficultyTier.Hard: return aiGetupChanceBonusHard;
            case EnemyDifficultyTier.Hardcore: return aiGetupChanceBonusHardcore;
            default: return 0f;
        }
    }
    int GetEnemyLevel()
    {
        if(enemyLevelController==null&&enemyStats!=null) enemyLevelController=LevelController.GetFor(enemyStats);
        return(enemyLevelController!=null)?Mathf.Clamp(enemyLevelController.level,1,100):1;
    }
    int GetPlayerLevel()
    {
        if(playerLevelController==null&&playerStats!=null) playerLevelController=LevelController.GetFor(playerStats);
        return(playerLevelController!=null)?Mathf.Clamp(playerLevelController.level,1,100):1;
    }
    float GetAiGetupChanceLevelBoostFirst3KDs()
    {
        int eLv=GetEnemyLevel();
        int pLv=GetPlayerLevel();
        int gap=Mathf.Clamp(eLv,1,100)-Mathf.Clamp(pLv,1,100);
        return Mathf.Max(0,gap)*0.00125f;
    }
    void SetupEnemyKD(bool instantKD)
    {
        if(enemyKDCount>=4)
        {
            if(stoppingRound==0) stoppingRound=currentRound;
            EndFightByKO(FightResultWinner.Player);
            return;
        }
        int kdNumber=Mathf.Clamp(enemyKDCount,1,3);
        EnemyDifficultyTier tier=GetEnemyDifficultyTier();
        float minT,maxT;
        GetAiGetupTimeRange(kdNumber,out minT,out maxT);
        if(tier==EnemyDifficultyTier.Hardcore)
        {
            float c=Mathf.Clamp01(aiGetupHardcore.GetChance(kdNumber));
            aiWillGetUp=(enemyKDCount<=3)?(c>=0.999f):false;
            aiPlannedGetupTime=RNGRange(minT,maxT);
            aiGetUpTriggered=false;
            return;
        }
        float getupChance=GetAiGetupChanceFromInspector(kdNumber);
        if(enemyKDCount<=3) getupChance=Mathf.Clamp01(getupChance+GetAiGetupChanceDifficultyBonus()+GetAiGetupChanceLevelBoostFirst3KDs());
        aiWillGetUp=(RNG01()<=Mathf.Clamp01(getupChance));
        if(earlyKDActiveThisKnockdown) aiWillGetUp=(RNG01()<=Mathf.Clamp01(earlyKDMaxGetupChance));
        aiPlannedGetupTime=RNGRange(minT,maxT);
        aiGetUpTriggered=false;
    }
    bool IsEnemyHardcore()
    {
        if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
        if(enemyBrain==null) return false;
        return(enemyBrain.difficultyBand==AiBrain.DifficultyBand.Hard&&enemyBrain.difficultyScore>=hardcoreScoreThreshold);
    }
    void GetAiGetupTimeRange(int kdNumber,out float minTime,out float maxTime)
    {
        switch(kdNumber)
        {
            case 1: minTime=1f;maxTime=6f;break;
            case 2: minTime=4f;maxTime=8f;break;
            default: minTime=5f;maxTime=9f;break;
        }
    }
    void UpdateKDState()
    {
        kdTimerSeconds+=Time.deltaTime;
        if(kdCountdownText!=null)
        {
            int displayCount=Mathf.Clamp(Mathf.FloorToInt(kdTimerSeconds)+1,1,10);
            kdCountdownText.text=displayCount.ToString();
        }
        if(kdDefenderIsPlayer)
        {
            if(playerStats!=null) playerStats.PauseRegen(Time.deltaTime+0.05f);
        }
        else
        {
            if(enemyStats!=null) enemyStats.PauseRegen(Time.deltaTime+0.05f);
        }
        if(kdDefenderIsPlayer) UpdatePlayerKD();
        else UpdateEnemyKD();
    }
    void UpdatePlayerKD()
    {
        if(Input.GetKeyDown(KeyCode.Space)) playerMashCount++;
        if(playerMashCount>=playerMashTarget)
        {
            if(earlyKDActiveThisKnockdown)
            {
                if(RNG01()<=Mathf.Clamp01(earlyKDMaxGetupChance)) StandUpPlayer();
                return;
            }
            StandUpPlayer();
            return;
        }
        if(kdTimerSeconds>=10f)
        {
            if(stoppingRound==0) stoppingRound=currentRound;
            EndFightByKO(FightResultWinner.Enemy);
        }
    }
    float GetBaseGetupFraction(int knockdownCount)
    {
        if(knockdownCount<=1) return getupStaminaFractionKD1;
        if(knockdownCount==2) return getupStaminaFractionKD2;
        return getupStaminaFractionKD3Plus;
    }
    float GetEnemyAIGetupBonusFraction()
    {
        if(IsEnemyHardcore()) return aiGetupBonusHardcore;
        if(enemyBrain==null&&enemyStats!=null) enemyBrain=enemyStats.GetComponentInParent<AiBrain>();
        if(enemyBrain==null) return 0f;
        switch(enemyBrain.difficultyBand)
        {
            case AiBrain.DifficultyBand.Medium: return aiGetupBonusMedium;
            case AiBrain.DifficultyBand.Hard: return aiGetupBonusHard;
            default: return 0f;
        }
    }
    void StandUpPlayer()
    {
        kdInProgress=false;
        if(playerStats!=null)
        {
            float baseFrac=GetBaseGetupFraction(playerKDCount);
            playerStats.ApplyGetupStaminaFraction(baseFrac,0f);
            prevPlayerStamina=playerStats.currentStamina;
        }
        FreezeFighters(false);
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        earlyKDActiveThisKnockdown=false;
        CheckDeferredRoundEndAfterKD();
    }
    void UpdateEnemyKD()
    {
        if(aiGetUpTriggered) return;
        if(kdTimerSeconds>=aiPlannedGetupTime)
        {
            if(aiWillGetUp) StandUpEnemy();
            else
            {
                if(stoppingRound==0) stoppingRound=currentRound;
                EndFightByKO(FightResultWinner.Player);
            }
            aiGetUpTriggered=true;
            return;
        }
        if(kdTimerSeconds>=10f&&!aiGetUpTriggered)
        {
            if(stoppingRound==0) stoppingRound=currentRound;
            EndFightByKO(FightResultWinner.Player);
        }
    }
    void StandUpEnemy()
    {
        kdInProgress=false;
        if(enemyStats!=null)
        {
            float baseFrac=GetBaseGetupFraction(enemyKDCount);
            float bonusFrac=GetEnemyAIGetupBonusFraction();
            enemyStats.ApplyGetupStaminaFraction(baseFrac,bonusFrac);
            prevEnemyStamina=enemyStats.currentStamina;
        }
        FreezeFighters(false);
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        earlyKDActiveThisKnockdown=false;
        CheckDeferredRoundEndAfterKD();
    }
    void EndFightByKO(FightResultWinner winner)
    {
        if(fightOver) return;
        if(stoppingRound==0) stoppingRound=currentRound;
        fightOver=true;
        roundActive=false;
        kdInProgress=false;
        pendingRoundEndAtBell=false;
        resultType=FightResultType.KO;
        resultWinner=winner;
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
        if(pausePanel!=null) pausePanel.SetActive(false);
        Time.timeScale=1f;
        isPaused=false;
        LockFightersForPostFight();
        MoveFightersToCenter();
    NotifyFightEndedOnce();
ShowDecisionPanel();
        SetUIPanelPause(true);
    }
    void EndFightByTKO(FightResultWinner winner)
    {
        if(fightOver) return;
        if(stoppingRound==0) stoppingRound=currentRound;
        fightOver=true;
        roundActive=false;
        kdInProgress=false;
        pendingRoundEndAtBell=false;
        resultType=FightResultType.TKO;
        resultWinner=winner;
        if(kdCountdownText!=null) kdCountdownText.gameObject.SetActive(false);
        if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
        if(pausePanel!=null) pausePanel.SetActive(false);
        Time.timeScale=1f;
        isPaused=false;
        LockFightersForPostFight();
        MoveFightersToCenter();
NotifyFightEndedOnce();
ShowDecisionPanel();
        SetUIPanelPause(true);
    }
    void ShowDecisionPanel()
    {
        if(decisionPanel==null||decisionTitleText==null||decisionDetailText==null){Debug.LogWarning("FightManager: DecisionPanel or its Text references not assigned.");return;}
        string title="";
        switch(resultType)
        {
            case FightResultType.KO: title=(resultWinner==FightResultWinner.Player)?"Win by KO":(resultWinner==FightResultWinner.Enemy)?"Lose by KO":"KO";break;
            case FightResultType.TKO: title=(resultWinner==FightResultWinner.Player)?"Win by TKO":(resultWinner==FightResultWinner.Enemy)?"Lose by TKO":"TKO";break;
            case FightResultType.Decision:
                {
                    int playerTotal=0;int enemyTotal=0;
                    for(int i=0;i<totalRounds;i++){playerTotal+=playerRoundScores[i];enemyTotal+=enemyRoundScores[i];}
                    int margin=Mathf.Abs(playerTotal-enemyTotal);
                    string decType=(margin>=3)?"Unanimous Decision":"Split Decision";
                    if(resultWinner==FightResultWinner.Player) title=$"Win by {decType}";
                    else if(resultWinner==FightResultWinner.Enemy) title=$"Lose by {decType}";
                    else title=decType;
                }
                break;
            case FightResultType.Draw: title="Draw";break;
            default: title="Result";break;
        }
        decisionTitleText.text=title;
string detail="";
if(resultType==FightResultType.KO||resultType==FightResultType.TKO)
{
    int r=Mathf.Max(1,stoppingRound>0?stoppingRound:currentRound);
    detail=$"{(resultType==FightResultType.KO?"KO":"TKO")} in Round {r}";
}
else if(resultType==FightResultType.Decision)
{
    int playerTotal=0;int enemyTotal=0;
    for(int i=0;i<totalRounds;i++){playerTotal+=playerRoundScores[i];enemyTotal+=enemyRoundScores[i];}
    int margin=Mathf.Abs(playerTotal-enemyTotal);
    detail=(margin>=3)?"Unanimous Decision":"Split Decision";
}
else if(resultType==FightResultType.Draw) detail="Draw";
else detail="Result";
decisionDetailText.text=detail;
if(decisionRestartButtonObject!=null) decisionRestartButtonObject.SetActive(!IsCareerMode());
if(decisionXPText!=null)
{
    if(IsCareerMode()&&careerXpGained>=0){decisionXPText.gameObject.SetActive(true);decisionXPText.text=$"XP Gained: {careerXpGained}";}
    else{decisionXPText.gameObject.SetActive(false);decisionXPText.text="";}
}
        decisionPanel.SetActive(true);
    }
    int FindLastScoredRoundIndex()
    {
        if(playerRoundScores==null||enemyRoundScores==null) return -1;
        int last=-1;
        for(int i=0;i<totalRounds;i++)
        {
            int p=playerRoundScores[i];
            int e=enemyRoundScores[i];
            if(p!=0||e!=0) last=i;
        }
        return last;
    }
    void UpdateScorecardUI(bool postFight)
    {
        if(playerScorecardRoundTexts==null||enemyScorecardRoundTexts==null) return;
        for(int i=0;i<12;i++)
        {
            string pCell="";string eCell="";
            int roundNumber=i+1;
            if(roundNumber<=totalRounds)
            {
                int pScore=playerRoundScores[roundNumber-1];
                int eScore=enemyRoundScores[roundNumber-1];
                bool hasScore=(pScore!=0||eScore!=0);
                if(postFight&&resultType!=FightResultType.Decision&&resultType!=FightResultType.Draw&&resultType!=FightResultType.None&&stoppingRound==roundNumber)
                {
                    if(resultWinner==FightResultWinner.Player)
                    {
                        if(resultType==FightResultType.KO){pCell="KO";eCell="KO'd";}
                        else if(resultType==FightResultType.TKO){pCell="TKO";eCell="TKO'd";}
                    }
                    else if(resultWinner==FightResultWinner.Enemy)
                    {
                        if(resultType==FightResultType.KO){pCell="KO'd";eCell="KO";}
                        else if(resultType==FightResultType.TKO){pCell="TKO'd";eCell="TKO";}
                    }
                }
                else if(hasScore){pCell=pScore.ToString();eCell=eScore.ToString();}
            }
            if(i<playerScorecardRoundTexts.Length&&playerScorecardRoundTexts[i]!=null) playerScorecardRoundTexts[i].text=pCell;
            if(i<enemyScorecardRoundTexts.Length&&enemyScorecardRoundTexts[i]!=null) enemyScorecardRoundTexts[i].text=eCell;
        }
    }
    void UpdateScorecardPunchStats(bool postFight)
    {
        int lastRoundIndex=postFight?(totalRounds-1):Mathf.Clamp(currentRound-1,0,totalRounds-1);
        int totalPThrown=0,totalPLanded=0;
        int totalEThrown=0,totalELanded=0;
        for(int i=0;i<=lastRoundIndex;i++)
        {
            totalPThrown+=playerRoundStats[i].punchesThrown;
            totalPLanded+=playerRoundStats[i].punchesLanded;
            totalEThrown+=enemyRoundStats[i].punchesThrown;
            totalELanded+=enemyRoundStats[i].punchesLanded;
        }
        float pAcc=(totalPThrown>0)?(100f*totalPLanded/(float)totalPThrown):0f;
        float eAcc=(totalEThrown>0)?(100f*totalELanded/(float)totalEThrown):0f;
        if(playerScorecardPunchStatsText!=null) playerScorecardPunchStatsText.text=$"Player – Landed {totalPLanded}/{totalPThrown} ({pAcc:F0}%)";
        if(enemyScorecardPunchStatsText!=null) enemyScorecardPunchStatsText.text=$"Enemy – Landed {totalELanded}/{totalEThrown} ({eAcc:F0}%)";
    }
    void UpdateTimerUI()
    {
        if(roundTimerText==null) return;
        int seconds=Mathf.CeilToInt(currentRoundTime);
        int mins=seconds/60;
        int secs=seconds%60;
        roundTimerText.text=$"{mins:0}:{secs:00}";
    }
    void UpdateStaminaUI()
    {
        if(playerStats!=null) playerStats.currentStamina=Mathf.Min(playerStats.currentStamina,playerStats.maxStamina);
        if(enemyStats!=null) enemyStats.currentStamina=Mathf.Min(enemyStats.currentStamina,enemyStats.maxStamina);
        if(playerStats!=null&&playerStaminaSlider!=null)
        {
            playerStaminaSlider.maxValue=playerStats.maxStamina;
            playerStaminaSlider.value=playerStats.currentStamina;
        }
        if(enemyStats!=null&&enemyStaminaSlider!=null)
        {
            enemyStaminaSlider.maxValue=enemyStats.maxStamina;
            enemyStaminaSlider.value=enemyStats.currentStamina;
        }
        UpdateCapMarkerUI();
    }
    public void OnPunchThrown(bool attackerIsPlayer)
    {
        int idx=Mathf.Clamp(currentRound-1,0,totalRounds-1);
        if(attackerIsPlayer){unansweredPunchesReceivedByEnemy=0;playerRoundStats[idx].punchesThrown++;}
        else{unansweredPunchesReceivedByPlayer=0;enemyRoundStats[idx].punchesThrown++;}
    }
    public void RegisterHit(bool attackerIsPlayer,bool isClean,bool isBlocked,float damage)
    {
        int idx=Mathf.Clamp(currentRound-1,0,totalRounds-1);
        if(attackerIsPlayer)
        {
            var atk=playerRoundStats[idx];
            var def=enemyRoundStats[idx];
            atk.punchesLanded++;
            if(isClean) atk.cleanHitsLanded++;
            if(isBlocked){atk.blockedHitsLanded++;playerBlockedThrownThisRound++;enemySuccessfulBlocksThisFight++;}
            atk.damageDealt+=damage;
            def.damageTaken+=damage;
            unansweredPunchesReceivedByEnemy++;
            enemyPunchesTakenThisRound++;
        }
        else
        {
            var atk=enemyRoundStats[idx];
            var def=playerRoundStats[idx];
            atk.punchesLanded++;
            if(isClean) atk.cleanHitsLanded++;
            if(isBlocked){atk.blockedHitsLanded++;enemyBlockedThrownThisRound++;playerSuccessfulBlocksThisFight++;}
            atk.damageDealt+=damage;
            def.damageTaken+=damage;
            unansweredPunchesReceivedByPlayer++;
            playerPunchesTakenThisRound++;
        }
        if(!fightOver&&roundActive&&!kdInProgress)
        {
            const int UNANSWERED_LIMIT=8;
            if(unansweredPunchesReceivedByEnemy>=UNANSWERED_LIMIT) EndFightByTKO(FightResultWinner.Player);
            else if(unansweredPunchesReceivedByPlayer>=UNANSWERED_LIMIT) EndFightByTKO(FightResultWinner.Enemy);
        }
    }
    public void OnContinueButtonClicked()
    {
        if(fightOver) return;
        if(!roundActive&&currentRound<totalRounds)
        {
            if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
            if(continueButton!=null) continueButton.SetActive(false);
            SetUIPanelPause(false);
            StartNextRound();
        }
    }
public void OnRestartButtonClicked()
{
    if(IsCareerMode()) return;
    Time.timeScale=1f;
    Scene current=SceneManager.GetActiveScene();
    SceneManager.LoadScene(current.name);
}
public void OnMainMenuButtonClicked()
{
    Time.timeScale=1f;
    if(IsCareerMode()) SceneManager.LoadScene(CareerManager.Instance!=null?CareerManager.Instance.careerHubSceneName:"CareerHub");
    else SceneManager.LoadScene("MainMenu");
}
    public void OnSeeStatsButtonClicked()
    {
        if(decisionPanel!=null) decisionPanel.SetActive(false);
        if(betweenRoundPanel!=null)
        {
            betweenRoundPanel.SetActive(true);
            if(betweenRoundTitleText!=null) betweenRoundTitleText.text="Scorecard";
            UpdateScorecardUI(postFight:true);
            UpdateScorecardPunchStats(postFight:true);
            if(scorecardBackButton!=null) scorecardBackButton.SetActive(true);
            if(betweenRoundPlayerStatsText!=null) betweenRoundPlayerStatsText.text="";
            if(betweenRoundEnemyStatsText!=null) betweenRoundEnemyStatsText.text="";
            if(betweenRoundJudgeScoreText!=null) betweenRoundJudgeScoreText.text="";
            if(continueButton!=null) continueButton.SetActive(false);
            SetUIPanelPause(true);
        }
    }
    public void OnScorecardBackButtonClicked()
    {
        if(betweenRoundPanel!=null) betweenRoundPanel.SetActive(false);
        if(decisionPanel!=null) decisionPanel.SetActive(true);
        if(scorecardBackButton!=null) scorecardBackButton.SetActive(false);
        SetUIPanelPause(true);
    }
    public void OnPauseResumeButtonClicked()
    {
        if(!fightOver&&!uiPanelPauseActive) ResumeFromPause();
    }
public void OnPauseQuitToMainMenuClicked()
{
    Time.timeScale=1f;
    if(IsCareerMode()) SceneManager.LoadScene(CareerManager.Instance!=null?CareerManager.Instance.careerHubSceneName:"CareerHub");
    else SceneManager.LoadScene("MainMenu");
}
    void StartRoundChargeCooldown()
    {
        PutChargeOnCooldownForFighter(playerStats);
        PutChargeOnCooldownForFighter(enemyStats);
    }
    void PutChargeOnCooldownForFighter(FighterStats stats)
    {
        if(stats==null) return;
        CritController cc=stats.GetComponentInParent<CritController>();
        if(cc==null) cc=stats.GetComponent<CritController>();
        if(cc!=null)
        {
            try{cc.PutChargeOnCooldown();return;}
            catch
            {
                var m=cc.GetType().GetMethod("PutChargeOnCooldown",BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic);
                if(m!=null&&m.GetParameters().Length==0){try{m.Invoke(cc,null);}catch{}}
            }
        }
    }
    public bool IsCareerMode()
    {
        return(CareerManager.Instance!=null&&CareerManager.Instance.IsCareerFightActive());
    }
    void ApplyCareerConfigIfNeeded()
{
    if(CareerManager.Instance==null) return;
    if(!CareerManager.Instance.IsCareerFightActive()) return;
    if(!CareerManager.Instance.HasActiveSlot()) return;
    var cfg=GameConfig.EnsureInstance();
    var p=CareerManager.Instance.GetProfile();
roundDurationSeconds=p.roundDurationSeconds>0?p.roundDurationSeconds:roundDurationSeconds;
    var f=CareerManager.Instance.GetSelectedRosterFighter();
    if(cfg==null||p==null||f==null) return;
    cfg.SetPlayerLevel(Mathf.Clamp(p.playerLevel,1,100));
    cfg.SetEnemyLevel(Mathf.Clamp(f.level,1,100));
    cfg.SetPlayerArchetype(p.playerArchetype);
    FighterClass.Archetype arch;
    if(!Enum.TryParse<FighterClass.Archetype>(f.mainClass,true,out arch)) arch=FighterClass.Archetype.BoxerPuncher;
    cfg.SetEnemyArchetype(arch);
    cfg.SetRandomizeEnemyClassEachFight(false);
    cfg.SetEnemyDifficulty(CareerManager.Instance.GetPendingDifficulty());
}
    public int GetCareerOpponentLevelSafe()
    {
        if(enemyLevelController==null&&enemyStats!=null) enemyLevelController=LevelController.GetFor(enemyStats);
        int lv=(enemyLevelController!=null)?enemyLevelController.level:1;
        return Mathf.Clamp(lv,1,100);
    }
    public void AppendToDecisionDetail(string extra)
    {
        if(decisionDetailText==null) return;
        decisionDetailText.text=(decisionDetailText.text??"")+(extra??"");
    }
    public int GetPlayerBlocksSuccessful()=>Mathf.Max(0,playerSuccessfulBlocksThisFight);
public int GetPlayerTotalPunchesThrown(){if(playerRoundStats==null) return 0;int sum=0;for(int i=0;i<playerRoundStats.Length;i++) sum+=Mathf.Max(0,playerRoundStats[i].punchesThrown);return sum;}
public int GetPlayerTotalPunchesLanded(){if(playerRoundStats==null) return 0;int sum=0;for(int i=0;i<playerRoundStats.Length;i++) sum+=Mathf.Max(0,playerRoundStats[i].punchesLanded);return sum;}
public int GetEnemyTotalPunchesLanded(){if(enemyRoundStats==null) return 0;int sum=0;for(int i=0;i<enemyRoundStats.Length;i++) sum+=Mathf.Max(0,enemyRoundStats[i].punchesLanded);return sum;}
public int GetEnemyKDsScoredTotal(){if(enemyRoundStats==null) return 0;int sum=0;for(int i=0;i<enemyRoundStats.Length;i++) sum+=Mathf.Max(0,enemyRoundStats[i].kdsScored);return sum;}
    public int GetPlayerSuccessfulWeaves()=>Mathf.Max(0,playerSuccessfulWeavesThisFight);
    public int GetPlayerKDsScoredTotal()
    {
        if(playerRoundStats==null) return 0;
        int sum=0;
        for(int i=0;i<playerRoundStats.Length;i++) sum+=Mathf.Max(0,playerRoundStats[i].kdsScored);
        return sum;
    }
    public int GetPlayerLateKDsScored(int lateRoundThreshold)
    {
        if(playerRoundStats==null) return 0;
        int thresh=Mathf.Clamp(lateRoundThreshold,1,12);
        int sum=0;
        for(int r=0;r<playerRoundStats.Length;r++)
        {
            int roundNum=r+1;
            if(roundNum>thresh) sum+=Mathf.Max(0,playerRoundStats[r].kdsScored);
        }
        return sum;
    }
    public int GetPlayerRoundsWon()
    {
        if(playerRoundScores==null||enemyRoundScores==null) return 0;
        int sum=0;
        for(int i=0;i<totalRounds&&i<playerRoundScores.Length&&i<enemyRoundScores.Length;i++)
        {
            int p=playerRoundScores[i];
            int e=enemyRoundScores[i];
            if(p==0&&e==0) continue;
            if(p>e) sum++;
        }
        return sum;
    }
    public bool IsPlayerUnanimousDecisionWin()
    {
        if(resultType!=FightResultType.Decision) return false;
        if(resultWinner!=FightResultWinner.Player) return false;
        int playerTotal=0,enemyTotal=0;
        for(int i=0;i<totalRounds;i++){playerTotal+=playerRoundScores[i];enemyTotal+=enemyRoundScores[i];}
        int margin=Mathf.Abs(playerTotal-enemyTotal);
        return margin>=3;
    }
    void NotifyFightEndedOnce()
    {
        if(fightEndNotified) return;
        fightEndNotified=true;
        if(careerResultReceiver!=null) careerResultReceiver.OnFightEnded(this);
    }
    bool IsEarlyFirstRoundKD()
    {
        if(currentRound!=1) return false;
        float elapsed=roundDurationSeconds-currentRoundTime;
        return elapsed<=Mathf.Max(0f,earlyKDElapsedSeconds);
    }
}

