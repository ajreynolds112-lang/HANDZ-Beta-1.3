using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using System.Reflection;
public class CareerSaveSelectUI:MonoBehaviour
{
public string mainMenuSceneName="MainMenu";
public string careerHubSceneName="CareerHub";
public string careerConfiguratorSceneName="CareerConfigurator";
public Text slot0Text;
public Text slot1Text;
public Text slot0LastNameText;
public Text slot0RecordText;
public Text slot0LevelText;
public Text slot1LastNameText;
public Text slot1RecordText;
public Text slot1LevelText;
public Button slot0DeleteButton;
public Button slot1DeleteButton;
public Button slot0PlayButton;
public Button slot1PlayButton;
public Button backButton;
public GameObject confirmPanel;
public Text confirmText;
int pendingDeleteSlot=-1;

void Awake()
{
Time.timeScale=1f;
SceneManager.sceneLoaded-=OnSceneLoaded;
SceneManager.sceneLoaded+=OnSceneLoaded;
}
void OnDestroy(){SceneManager.sceneLoaded-=OnSceneLoaded;}
void OnEnable()
{
Time.timeScale=1f;
ResolvePersistentInstanceConflicts();
EnsureUsableEventSystem();
WireButtons();
pendingDeleteSlot=-1;
if(confirmPanel!=null) confirmPanel.SetActive(false);
CareerManager.EnsureInstance();
CareerRosterSystem.EnsureInstance();
Refresh();
ForceInteractable();
}
void OnSceneLoaded(Scene s,LoadSceneMode mode)
{
Time.timeScale=1f;
ResolvePersistentInstanceConflicts();
if(this==null) return;
if(!isActiveAndEnabled) return;
if(s.name!=SceneManager.GetActiveScene().name) return;
if(SceneManager.GetActiveScene().name!=gameObject.scene.name&&gameObject.scene.name!="DontDestroyOnLoad") return;
if(SceneManager.GetActiveScene().name==GetActiveSceneNameSafe())
{
EnsureUsableEventSystem();
WireButtons();
if(confirmPanel!=null) confirmPanel.SetActive(false);
pendingDeleteSlot=-1;
Refresh();
ForceInteractable();
}
}
string GetActiveSceneNameSafe(){var sc=SceneManager.GetActiveScene();return sc.IsValid()?sc.name:"";}
void ResolvePersistentInstanceConflicts()
{
string active=GetActiveSceneNameSafe();
bool persistent=(gameObject.scene.name=="DontDestroyOnLoad");
if(persistent&&active!="CareerSaveSelect"){Destroy(gameObject);return;}
if(active=="CareerSaveSelect")
{
var all=Object.FindObjectsOfType<CareerSaveSelectUI>(true);
CareerSaveSelectUI sceneOne=null;
for(int i=0;i<all.Length;i++){var ui=all[i];if(ui==null) continue;if(ui.gameObject.scene.name=="CareerSaveSelect"){sceneOne=ui;break;}}
if(sceneOne!=null&&sceneOne!=this&&persistent){Destroy(gameObject);return;}
}
}
void EnsureUsableEventSystem()
{
EventSystem es=EventSystem.current;
if(es==null){var all=Object.FindObjectsOfType<EventSystem>(true);if(all!=null&&all.Length>0) es=all[0];}
if(es==null){GameObject go=new GameObject("EventSystem");es=go.AddComponent<EventSystem>();go.AddComponent<StandaloneInputModule>();}
es.enabled=true;
var sim=es.GetComponent<StandaloneInputModule>();
if(sim!=null) sim.enabled=true;
if(EventSystem.current==null) EventSystem.current=es;
}
void WireButtons()
{
if(slot0PlayButton!=null){slot0PlayButton.onClick.RemoveAllListeners();slot0PlayButton.onClick.AddListener(OnPlaySlot0);}
if(slot1PlayButton!=null){slot1PlayButton.onClick.RemoveAllListeners();slot1PlayButton.onClick.AddListener(OnPlaySlot1);}
if(slot0DeleteButton!=null){slot0DeleteButton.onClick.RemoveAllListeners();slot0DeleteButton.onClick.AddListener(OnDeleteSlot0);}
if(slot1DeleteButton!=null){slot1DeleteButton.onClick.RemoveAllListeners();slot1DeleteButton.onClick.AddListener(OnDeleteSlot1);}
if(backButton!=null){backButton.onClick.RemoveAllListeners();backButton.onClick.AddListener(OnBackButtonClicked);}
}
void ForceInteractable()
{
if(slot0PlayButton!=null) slot0PlayButton.interactable=true;
if(slot1PlayButton!=null) slot1PlayButton.interactable=true;
if(backButton!=null) backButton.interactable=true;
if(slot0DeleteButton!=null) slot0DeleteButton.interactable=SlotHasValidSave(0);
if(slot1DeleteButton!=null) slot1DeleteButton.interactable=SlotHasValidSave(1);
}
bool SlotHasValidSave(int slot)
{
CareerManager.EnsureInstance();
var cm=CareerManager.Instance;
if(cm==null) return false;
var p=cm.PeekSlot(slot);
return p!=null&&p.exists;
}
void Refresh()
{
SetSlotLegacyText(0,slot0Text);
SetSlotLegacyText(1,slot1Text);
SetSlotDetailUI(0,slot0LastNameText,slot0RecordText,slot0LevelText);
SetSlotDetailUI(1,slot1LastNameText,slot1RecordText,slot1LevelText);
ForceInteractable();
}
void SetSlotLegacyText(int slot,Text t){if(t!=null) t.text="";}
static void SetTextVisible(Text t,bool visible,string s)
{
if(t==null) return;
t.text=visible?s:"";
t.enabled=visible;
if(t.gameObject!=null) t.gameObject.SetActive(visible);
}
static int GetDrawsSafe(object profile)
{
if(profile==null) return 0;
var f=profile.GetType().GetField("draws",BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance);
if(f==null) return 0;
if(f.FieldType!=typeof(int)) return 0;
return Mathf.Max(0,(int)f.GetValue(profile));
}
void SetSlotDetailUI(int slot,Text lastNameT,Text recordT,Text levelT)
{
CareerManager.EnsureInstance();
var cm=CareerManager.Instance;
if(cm==null){SetTextVisible(lastNameT,false,"");SetTextVisible(recordT,false,"");SetTextVisible(levelT,false,"");return;}
var p=cm.PeekSlot(slot);
if(p==null||!p.exists){SetTextVisible(lastNameT,false,"");SetTextVisible(recordT,false,"");SetTextVisible(levelT,false,"");return;}
string last=string.IsNullOrEmpty(p.playerLastName)?"":p.playerLastName;
int draws=GetDrawsSafe(p);
string rec=$"{Mathf.Max(0,p.wins)}-{Mathf.Max(0,p.losses)}-{draws}";
string lv=$"LV {Mathf.Max(1,p.playerLevel)}";
SetTextVisible(lastNameT,true,last);
SetTextVisible(recordT,true,rec);
SetTextVisible(levelT,true,lv);
}
public void OnPlaySlot0(){PlaySlot(0);}
public void OnPlaySlot1(){PlaySlot(1);}
void PlaySlot(int slot)
{
Time.timeScale=1f;
EnsureUsableEventSystem();
CareerManager.EnsureInstance();
var cm=CareerManager.Instance;
if(cm==null) return;
cm.SelectOrCreateSlot(slot);
cm.SaveNow();
CareerRosterSystem.EnsureInstance();
var rs=CareerRosterSystem.Instance;
if(rs!=null){var rslot=rs.LoadOrCreate(slot);rs.Save(rslot);}
bool configured=(cm!=null&&cm.IsActiveSlotConfigured());
if(!configured)
{
if(!Application.CanStreamedLevelBeLoaded(careerConfiguratorSceneName)){Debug.LogError("Missing scene in Build Profiles: "+careerConfiguratorSceneName);return;}
SceneManager.LoadScene(careerConfiguratorSceneName);
return;
}
if(!Application.CanStreamedLevelBeLoaded(careerHubSceneName)){Debug.LogError("Missing scene in Build Profiles: "+careerHubSceneName);return;}
SceneManager.LoadScene(careerHubSceneName);
}
public void OnDeleteSlot0(){AskDelete(0);}
public void OnDeleteSlot1(){AskDelete(1);}
void AskDelete(int slot)
{
if(!SlotHasValidSave(slot)) return;
pendingDeleteSlot=slot;
if(confirmText!=null) confirmText.text=$"Delete Save {slot+1}? This cannot be undone.";
if(confirmPanel!=null) confirmPanel.SetActive(true);
}
public void OnConfirmDeleteYes()
{
if(pendingDeleteSlot<0) return;
CareerManager.EnsureInstance();
if(CareerManager.Instance!=null) CareerManager.Instance.DeleteSlot(pendingDeleteSlot);
CareerRosterSystem.EnsureInstance();
if(CareerRosterSystem.Instance!=null) CareerRosterSystem.Instance.DeleteSlot(pendingDeleteSlot);
pendingDeleteSlot=-1;
if(confirmPanel!=null) confirmPanel.SetActive(false);
Refresh();
}
public void OnConfirmDeleteNo(){pendingDeleteSlot=-1;if(confirmPanel!=null) confirmPanel.SetActive(false);Refresh();}
public void OnBackButtonClicked()
{
Time.timeScale=1f;
if(confirmPanel!=null&&confirmPanel.activeSelf){OnConfirmDeleteNo();return;}
SceneManager.LoadScene(mainMenuSceneName);
}
}