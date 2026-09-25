using UnityEngine;
[DefaultExecutionOrder(-10000)]
public class GameConfig:MonoBehaviour
{
public static GameConfig Instance{get;private set;}
public enum GameMode{Classic=0,Career=1}
public enum DifficultyBand{Easy=0,Normal=1,Hard=2,Hardcore=3}
public GameMode gameMode=GameMode.Classic;
[Range(1,100)] public int enemyLevel=5;
[Range(1,100)] public int playerLevel=5;
public DifficultyBand enemyDifficulty=DifficultyBand.Normal;
public FighterClass.Archetype playerArchetype=FighterClass.Archetype.BoxerPuncher;
public FighterClass.Archetype enemyArchetype=FighterClass.Archetype.BoxerPuncher;
public bool randomizeEnemyClassEachFight=true;
const string KEnemyLevelClassic="GC_enemyLevel";
const string KPlayerLevelClassic="GC_playerLevel";
const string KEnemyDiffClassic="GC_enemyDiff";
const string KPlayerArchClassic="GC_playerArch";
const string KEnemyArchClassic="GC_enemyArch";
const string KRandEnemyClassic="GC_randEnemy";
void Awake()
{
if(Instance!=null&&Instance!=this){Destroy(gameObject);return;}
Instance=this;
DontDestroyOnLoad(gameObject);
if(gameMode==GameMode.Classic) LoadFromPrefsIfPresent();
Sanitize();
if(gameMode==GameMode.Classic) SaveToPrefs();
}
void Sanitize(){enemyLevel=Mathf.Clamp(enemyLevel,1,100);playerLevel=Mathf.Clamp(playerLevel,1,100);}
void LoadFromPrefsIfPresent()
{
if(PlayerPrefs.HasKey(KEnemyLevelClassic)) enemyLevel=Mathf.Clamp(PlayerPrefs.GetInt(KEnemyLevelClassic,enemyLevel),1,100);
if(PlayerPrefs.HasKey(KPlayerLevelClassic)) playerLevel=Mathf.Clamp(PlayerPrefs.GetInt(KPlayerLevelClassic,playerLevel),1,100);
if(PlayerPrefs.HasKey(KEnemyDiffClassic)) enemyDifficulty=(DifficultyBand)Mathf.Clamp(PlayerPrefs.GetInt(KEnemyDiffClassic,(int)enemyDifficulty),0,3);
if(PlayerPrefs.HasKey(KPlayerArchClassic)) playerArchetype=(FighterClass.Archetype)Mathf.Max(0,PlayerPrefs.GetInt(KPlayerArchClassic,(int)playerArchetype));
if(PlayerPrefs.HasKey(KEnemyArchClassic)) enemyArchetype=(FighterClass.Archetype)Mathf.Max(0,PlayerPrefs.GetInt(KEnemyArchClassic,(int)enemyArchetype));
if(PlayerPrefs.HasKey(KRandEnemyClassic)) randomizeEnemyClassEachFight=PlayerPrefs.GetInt(KRandEnemyClassic,randomizeEnemyClassEachFight?1:0)==1;
}
void SaveToPrefs()
{
PlayerPrefs.SetInt(KEnemyLevelClassic,enemyLevel);
PlayerPrefs.SetInt(KPlayerLevelClassic,playerLevel);
PlayerPrefs.SetInt(KEnemyDiffClassic,(int)enemyDifficulty);
PlayerPrefs.SetInt(KPlayerArchClassic,(int)playerArchetype);
PlayerPrefs.SetInt(KEnemyArchClassic,(int)enemyArchetype);
PlayerPrefs.SetInt(KRandEnemyClassic,randomizeEnemyClassEachFight?1:0);
PlayerPrefs.Save();
}
public void SetGameMode(GameMode m){gameMode=m;}
public void SetEnemyLevel(int level){enemyLevel=Mathf.Clamp(level,1,100);if(gameMode==GameMode.Classic) SaveToPrefs();}
public void SetPlayerLevel(int level){playerLevel=Mathf.Clamp(level,1,100);if(gameMode==GameMode.Classic) SaveToPrefs();}
public void SetEnemyDifficulty(DifficultyBand band){enemyDifficulty=band;if(gameMode==GameMode.Classic) SaveToPrefs();}
public void SetPlayerArchetype(FighterClass.Archetype archetype){playerArchetype=archetype;if(gameMode==GameMode.Classic) SaveToPrefs();}
public void SetEnemyArchetype(FighterClass.Archetype archetype){enemyArchetype=archetype;if(gameMode==GameMode.Classic) SaveToPrefs();}
public void SetRandomizeEnemyClassEachFight(bool v){randomizeEnemyClassEachFight=v;if(gameMode==GameMode.Classic) SaveToPrefs();}
public void ApplyClassicDefaultsFromPrefs(){gameMode=GameMode.Classic;LoadFromPrefsIfPresent();Sanitize();SaveToPrefs();}
public static GameConfig EnsureInstance()
{
if(Instance!=null) return Instance;
GameObject go=new GameObject("GameConfig_Runtime");
var cfg=go.AddComponent<GameConfig>();
return cfg;
}
}