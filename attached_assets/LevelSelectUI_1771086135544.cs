using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using System.Collections.Generic;
using System.Reflection;
public class LevelSelectManager:MonoBehaviour
{
[Header("UI References - Enemy")]
public Slider enemyLevelSlider;
public Text enemyLevelValueText;
[Header("UI References - Player")]
public Slider playerLevelSlider;
public Text playerLevelValueText;
[Header("UI References - Difficulty")]
public Dropdown difficultyDropdown;
[Header("UI References - Player Class")]
public Dropdown playerClassDropdown;
[Header("Scene Names")]
public string mainMenuSceneName="MainMenu";
public string fightSceneName="FightScene";
private static readonly string[] DifficultyLabels={"Journeyman","Contender","Elite","Champion"};
private static readonly string[] PlayerClassLabels={"Boxer-Puncher","Out-Boxer","Brawler","Swarmer"};
private void Awake()
{
if(enemyLevelSlider!=null)
{
enemyLevelSlider.minValue=1f;
enemyLevelSlider.maxValue=100f;
enemyLevelSlider.wholeNumbers=true;
enemyLevelSlider.onValueChanged.AddListener(OnEnemySliderChanged_Internal);
}
if(playerLevelSlider!=null)
{
playerLevelSlider.minValue=1f;
playerLevelSlider.maxValue=100f;
playerLevelSlider.wholeNumbers=true;
playerLevelSlider.onValueChanged.AddListener(OnPlayerSliderChanged_Internal);
}
}
private void Start()
{
TryDisableCareerModeNonDestructive();
var cfg=GameConfig.EnsureInstance();
cfg.SetGameMode(GameConfig.GameMode.Classic);
cfg.ApplyClassicDefaultsFromPrefs();
int enemyStartLevel=5;
int playerStartLevel=5;
int diffIndex=(int)GameConfig.DifficultyBand.Normal;
int playerClassIndex=0;
if(GameConfig.Instance!=null)
{
enemyStartLevel=Mathf.Clamp(GameConfig.Instance.enemyLevel,1,100);
playerStartLevel=Mathf.Clamp(GameConfig.Instance.playerLevel,1,100);
diffIndex=Mathf.Clamp((int)GameConfig.Instance.enemyDifficulty,0,DifficultyLabels.Length-1);
playerClassIndex=Mathf.Clamp((int)GameConfig.Instance.playerArchetype,0,PlayerClassLabels.Length-1);
}
if(enemyLevelSlider!=null) enemyLevelSlider.value=enemyStartLevel;
if(playerLevelSlider!=null) playerLevelSlider.value=playerStartLevel;
if(difficultyDropdown!=null)
{
ForceDifficultyOptions();
difficultyDropdown.value=diffIndex;
difficultyDropdown.RefreshShownValue();
}
if(playerClassDropdown!=null)
{
ForcePlayerClassOptions();
playerClassDropdown.value=playerClassIndex;
playerClassDropdown.RefreshShownValue();
}
UpdateEnemyLevelValueText(enemyStartLevel);
UpdatePlayerLevelValueText(playerStartLevel);
if(GameConfig.Instance!=null)
{
GameConfig.Instance.SetEnemyLevel(enemyStartLevel);
GameConfig.Instance.SetPlayerLevel(playerStartLevel);
GameConfig.Instance.SetEnemyDifficulty(IndexToBand(diffIndex));
GameConfig.Instance.SetPlayerArchetype(IndexToArchetype(playerClassIndex));
}
}
private void OnDestroy()
{
if(enemyLevelSlider!=null) enemyLevelSlider.onValueChanged.RemoveListener(OnEnemySliderChanged_Internal);
if(playerLevelSlider!=null) playerLevelSlider.onValueChanged.RemoveListener(OnPlayerSliderChanged_Internal);
}
public void OnBackButtonPressed(){SceneManager.LoadScene(mainMenuSceneName);}
public void OnStartFightPressed()
{
TryDisableCareerModeNonDestructive();
int enemyChosen=(enemyLevelSlider!=null)?Mathf.RoundToInt(enemyLevelSlider.value):5;
int playerChosen=(playerLevelSlider!=null)?Mathf.RoundToInt(playerLevelSlider.value):5;
int diffIndex=(difficultyDropdown!=null)?difficultyDropdown.value:(int)GameConfig.DifficultyBand.Normal;
int playerClassIndex=(playerClassDropdown!=null)?playerClassDropdown.value:0;
if(GameConfig.Instance!=null)
{
GameConfig.Instance.SetEnemyLevel(enemyChosen);
GameConfig.Instance.SetPlayerLevel(playerChosen);
GameConfig.Instance.SetEnemyDifficulty(IndexToBand(diffIndex));
GameConfig.Instance.SetPlayerArchetype(IndexToArchetype(playerClassIndex));
}
SceneManager.LoadScene(fightSceneName);
}
private void OnEnemySliderChanged_Internal(float raw)
{
int level=Mathf.Clamp(Mathf.RoundToInt(raw),1,100);
UpdateEnemyLevelValueText(level);
if(GameConfig.Instance!=null) GameConfig.Instance.SetEnemyLevel(level);
}
private void OnPlayerSliderChanged_Internal(float raw)
{
int level=Mathf.Clamp(Mathf.RoundToInt(raw),1,100);
UpdatePlayerLevelValueText(level);
if(GameConfig.Instance!=null) GameConfig.Instance.SetPlayerLevel(level);
}
public void OnDifficultyDropdownChanged(int dropdownIndex){if(GameConfig.Instance!=null) GameConfig.Instance.SetEnemyDifficulty(IndexToBand(dropdownIndex));}
public void OnPlayerClassDropdownChanged(int dropdownIndex){if(GameConfig.Instance!=null) GameConfig.Instance.SetPlayerArchetype(IndexToArchetype(dropdownIndex));}
private void ForceDifficultyOptions()
{
if(difficultyDropdown==null) return;
difficultyDropdown.ClearOptions();
List<string> opts=new List<string>();
for(int i=0;i<DifficultyLabels.Length;i++) opts.Add(DifficultyLabels[i]);
difficultyDropdown.AddOptions(opts);
}
private void ForcePlayerClassOptions()
{
if(playerClassDropdown==null) return;
playerClassDropdown.ClearOptions();
List<string> opts=new List<string>();
for(int i=0;i<PlayerClassLabels.Length;i++) opts.Add(PlayerClassLabels[i]);
playerClassDropdown.AddOptions(opts);
}
private GameConfig.DifficultyBand IndexToBand(int index)
{
index=Mathf.Clamp(index,0,3);
return (GameConfig.DifficultyBand)index;
}
private FighterClass.Archetype IndexToArchetype(int index)
{
index=Mathf.Clamp(index,0,PlayerClassLabels.Length-1);
if(index==1) return FighterClass.Archetype.OutBoxer;
if(index==2) return FighterClass.Archetype.Brawler;
if(index==3) return FighterClass.Archetype.Swarmer;
return FighterClass.Archetype.BoxerPuncher;
}
private void UpdateEnemyLevelValueText(int level){if(enemyLevelValueText!=null) enemyLevelValueText.text=level.ToString();}
private void UpdatePlayerLevelValueText(int level){if(playerLevelValueText!=null) playerLevelValueText.text=level.ToString();}
static void TryDisableCareerModeNonDestructive()
{
if(CareerManager.Instance==null) return;
object cm=CareerManager.Instance;
TryInvoke(cm,"ClearCareerFightActive");
TryInvoke(cm,"EndCareerFight");
TryInvoke(cm,"DeactivateCareerFight");
TryInvoke(cm,"SetCareerFightActive",false);
TryInvoke(cm,"SetCareerMode",false);
TryInvoke(cm,"SetIsCareerFightActive",false);
}
static void TryInvoke(object target,string method,params object[] args)
{
if(target==null) return;
var t=target.GetType();
var m=t.GetMethod(method,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic);
if(m==null) return;
var ps=m.GetParameters();
if(ps.Length==0){m.Invoke(target,null);return;}
if(args!=null&&ps.Length==args.Length){m.Invoke(target,args);return;}
}
}