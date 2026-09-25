using UnityEngine;
using System.Collections;
using System.Collections.Generic;
[RequireComponent(typeof(Rigidbody2D))]
[RequireComponent(typeof(FighterStats))]
public class FighterController : MonoBehaviour
{
    public bool isPlayerControlled=true;
    public float moveSpeed=5f;
    public float ringMinX=-7.5f;
    public float ringMaxX=7.5f;
    [Range(0.01f,1f)] public float clinchMoveSpeedMultiplier=0.2f;
    public FistHitbox leftFist;
    public FistHitbox rightFist;
    public Transform opponent;
    public bool restrictOnePunchAtATime=true;
    public FighterStats stats;
    public RhythmController rhythm;
    public DefenseController defense;
    public ClinchController clinch;
    public bool isFrozenByKD=false;
    public bool enableHitFlash=true;
    public Color normalHitFlashColor=Color.yellow;
    public Color critHitFlashColor=Color.red;
    public float normalHitFlashSeconds=0.3f;
    public float critFlashOnSeconds=0.3f;
    public float critFlashOffSeconds=0.1f;
    private SpriteRenderer[] cachedSpriteRenderers;
    private readonly Dictionary<SpriteRenderer,Color> originalColors=new Dictionary<SpriteRenderer,Color>();
    private Coroutine flashRoutine;
    private Rigidbody2D rb;
    private float moveInput=0f;
    private LevelController levelController;
    private bool punchLocked=false;
    private bool canChainPunch=true;
    private HitstopController hitstop;
    private const float facingDeadzone=0.2f;
    void Awake()
    {
        rb=GetComponent<Rigidbody2D>();
        if(stats==null) stats=GetComponent<FighterStats>();
        if(rhythm==null) rhythm=GetComponent<RhythmController>();
        if(defense==null) defense=GetComponent<DefenseController>();
        if(clinch==null) clinch=GetComponent<ClinchController>();
        levelController=LevelController.GetFor(this);
        hitstop=HitstopController.GetFor(this);
        CacheSpriteRenderers();
    }
    public void ForceRefreshLevelController(){levelController=LevelController.GetFor(this);}
    LevelController GetLC(){if(levelController==null) levelController=LevelController.GetFor(this);return levelController;}
    void CacheSpriteRenderers()
    {
        cachedSpriteRenderers=GetComponentsInChildren<SpriteRenderer>(true);
        originalColors.Clear();
        if(cachedSpriteRenderers!=null)
        {
            foreach(var sr in cachedSpriteRenderers)
            {
                if(sr==null) continue;
                if(!originalColors.ContainsKey(sr)) originalColors.Add(sr,sr.color);
            }
        }
    }
    void OnDisable(){StopAndResetFlash();}
    void StopAndResetFlash()
    {
        if(flashRoutine!=null){StopCoroutine(flashRoutine);flashRoutine=null;}
        if(cachedSpriteRenderers==null||cachedSpriteRenderers.Length==0) return;
        foreach(var sr in cachedSpriteRenderers)
        {
            if(sr==null) continue;
            if(originalColors.TryGetValue(sr,out var c)) sr.color=c;
        }
    }
    void SetAllSpriteColors(Color c)
    {
        if(cachedSpriteRenderers==null||cachedSpriteRenderers.Length==0) CacheSpriteRenderers();
        if(cachedSpriteRenderers==null) return;
        foreach(var sr in cachedSpriteRenderers)
        {
            if(sr==null) continue;
            if(!originalColors.ContainsKey(sr)) originalColors[sr]=sr.color;
            sr.color=c;
        }
    }
    void RestoreAllSpriteColors()
    {
        if(cachedSpriteRenderers==null||cachedSpriteRenderers.Length==0) return;
        foreach(var sr in cachedSpriteRenderers)
        {
            if(sr==null) continue;
            if(originalColors.TryGetValue(sr,out var c)) sr.color=c;
        }
    }
    public void TriggerHitFlash(bool wasCrit)
    {
        if(!enableHitFlash) return;
        if(cachedSpriteRenderers==null||cachedSpriteRenderers.Length==0) CacheSpriteRenderers();
        StopAndResetFlash();
        flashRoutine=StartCoroutine(wasCrit?CritFlashRoutine():NormalFlashRoutine());
    }
    IEnumerator NormalFlashRoutine()
    {
        float on=Mathf.Max(0f,normalHitFlashSeconds);
        SetAllSpriteColors(normalHitFlashColor);
        float t=0f;
        while(t<on){t+=Time.deltaTime;yield return null;}
        RestoreAllSpriteColors();
        flashRoutine=null;
    }
    IEnumerator CritFlashRoutine()
    {
        float on=Mathf.Max(0f,critFlashOnSeconds);
        float off=Mathf.Max(0f,critFlashOffSeconds);
        SetAllSpriteColors(critHitFlashColor);
        float t=0f;
        while(t<on){t+=Time.deltaTime;yield return null;}
        RestoreAllSpriteColors();
        t=0f;
        while(t<off){t+=Time.deltaTime;yield return null;}
        SetAllSpriteColors(critHitFlashColor);
        t=0f;
        while(t<on){t+=Time.deltaTime;yield return null;}
        RestoreAllSpriteColors();
        flashRoutine=null;
    }
    void Update()
    {
        if(!isPlayerControlled) return;
        if(isFrozenByKD||(stats!=null&&stats.IsExhausted)){moveInput=0f;return;}
        if(hitstop!=null&&hitstop.IsInHitstop) return;
        HandleInput();
        HandleFacing();
    }
    void FixedUpdate()
    {
        if(!isPlayerControlled) return;
        if(isFrozenByKD||(stats!=null&&stats.IsExhausted)) return;
        if(hitstop!=null&&hitstop.IsInHitstop) return;
        HandleMovement();
    }
    void HandleInput()
    {
        if(Input.GetKey(KeyCode.LeftArrow)) moveInput=-1f;
        else if(Input.GetKey(KeyCode.RightArrow)) moveInput=1f;
        else moveInput=0f;
        bool feintHeld=Input.GetKey(KeyCode.F);
        if(Input.GetKeyDown(KeyCode.W)&&leftFist!=null){if(CanAttemptNewPunch()){if(feintHeld) leftFist.StartFeint(FistHitbox.PunchType.Jab,KeyCode.W);else leftFist.StartPunch(FistHitbox.PunchType.Jab,KeyCode.W);}}
        if(Input.GetKeyDown(KeyCode.Q)&&leftFist!=null){if(CanAttemptNewPunch()){if(feintHeld) leftFist.StartFeint(FistHitbox.PunchType.LeftHook,KeyCode.Q);else leftFist.StartPunch(FistHitbox.PunchType.LeftHook,KeyCode.Q);}}
        if(Input.GetKeyDown(KeyCode.S)&&leftFist!=null){if(CanAttemptNewPunch()){if(feintHeld) leftFist.StartFeint(FistHitbox.PunchType.LeftUppercut,KeyCode.S);else leftFist.StartPunch(FistHitbox.PunchType.LeftUppercut,KeyCode.S);}}
        if(Input.GetKeyDown(KeyCode.E)&&rightFist!=null){if(CanAttemptNewPunch()){if(feintHeld) rightFist.StartFeint(FistHitbox.PunchType.Cross,KeyCode.E);else rightFist.StartPunch(FistHitbox.PunchType.Cross,KeyCode.E);}}
        if(Input.GetKeyDown(KeyCode.R)&&rightFist!=null){if(CanAttemptNewPunch()){if(feintHeld) rightFist.StartFeint(FistHitbox.PunchType.RightHook,KeyCode.R);else rightFist.StartPunch(FistHitbox.PunchType.RightHook,KeyCode.R);}}
        if(Input.GetKeyDown(KeyCode.D)&&rightFist!=null){if(CanAttemptNewPunch()){if(feintHeld) rightFist.StartFeint(FistHitbox.PunchType.RightUppercut,KeyCode.D);else rightFist.StartPunch(FistHitbox.PunchType.RightUppercut,KeyCode.D);}}
    }
    bool CanAttemptNewPunch(){if(!restrictOnePunchAtATime) return true;return !punchLocked||canChainPunch;}
    public void NotifyPunchStarted(){if(!restrictOnePunchAtATime) return;punchLocked=true;canChainPunch=false;}
    public void NotifyPunchCanChain(){if(!restrictOnePunchAtATime) return;canChainPunch=true;}
    public void NotifyPunchEnded(){if(!restrictOnePunchAtATime) return;punchLocked=false;if(!canChainPunch) canChainPunch=true;}
    void HandleMovement()
    {
        Vector2 pos=rb.position;
        if(defense!=null&&defense.IsWeaveMovementLocked()) moveInput=0f;
        int dirX=0;
        if(moveInput>0f) dirX=1;
        else if(moveInput<0f) dirX=-1;
        float speed=moveSpeed;
        var lc=GetLC();
        if(lc!=null) speed*=lc.MoveSpeedMult;
        if(stats!=null) speed*=stats.GetMoveSlowMultiplier();
        if(rhythm!=null&&dirX!=0)
        {
            float facingSign=Mathf.Sign(transform.localScale.x);
            speed*=rhythm.GetMovementMultiplier(dirX,facingSign);
        }
        if(defense!=null&&defense.IsHandsDownActive()) speed*=(1f+defense.handsDownMoveSpeedBonus);
        if(defense!=null) speed*=defense.GetWeaveMoveSpeedMultiplier();
        bool clinched=(clinch!=null&&clinch.IsClinching)||(defense!=null&&defense.IsClinchActive());
        if(clinched) speed*=Mathf.Clamp(clinchMoveSpeedMultiplier,0.01f,1f);
        pos.x+=moveInput*speed*Time.fixedDeltaTime;
        pos.x=Mathf.Clamp(pos.x,ringMinX,ringMaxX);
        rb.MovePosition(pos);
    }
    void HandleFacing()
    {
        if(opponent==null) TryAutoFindOpponent();
        if(opponent==null) return;
        float dx=opponent.position.x-transform.position.x;
        if(Mathf.Abs(dx)<facingDeadzone) return;
        Vector3 scale=transform.localScale;
        if(dx>0f) scale.x=Mathf.Abs(scale.x);
        else scale.x=-Mathf.Abs(scale.x);
        transform.localScale=scale;
    }
    void TryAutoFindOpponent()
    {
        AiBrain[] brains=Object.FindObjectsByType<AiBrain>(FindObjectsSortMode.None);
        if(brains.Length>0){opponent=brains[0].transform;return;}
        FighterStats myStats=GetComponent<FighterStats>();
        FighterStats[] allStats=Object.FindObjectsByType<FighterStats>(FindObjectsSortMode.None);
        foreach(var fs in allStats){if(fs!=myStats){opponent=fs.transform;break;}}
    }
    public void TriggerChargeBounce(){StartCoroutine(ChargeBounceRoutine());}
    IEnumerator ChargeBounceRoutine()
    {
        Vector3 startPos=transform.localPosition;
        Vector3 upPos=startPos+new Vector3(0f,0.05f,0f);
        Vector3 downPos=startPos-new Vector3(0f,0.05f,0f);
        float t=0f;
        while(t<1f){t+=Time.deltaTime*8f;transform.localPosition=Vector3.Lerp(startPos,upPos,t);yield return null;}
        t=0f;
        while(t<1f){t+=Time.deltaTime*8f;transform.localPosition=Vector3.Lerp(upPos,downPos,t);yield return null;}
        transform.localPosition=startPos;
    }
    public void SetKnockdownFrozen(bool frozen){isFrozenByKD=frozen;if(frozen) moveInput=0f;}
}
