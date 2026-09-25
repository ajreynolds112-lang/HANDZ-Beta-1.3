using UnityEngine;
using UnityEngine.UI;
public class StaminaBarUI : MonoBehaviour
{
    [Header("Which fighter does this bar represent?")]
    public FighterStats fighter;
    private Slider slider;
    void Awake()
    {
        slider = GetComponent<Slider>();
        if (slider == null)
        {
            Debug.LogError("StaminaBarUI: No Slider component found on this GameObject.");
        }
    }
    void Start()
    {

        if (fighter != null && slider != null)
        {
            slider.minValue = 0f;
            slider.maxValue = fighter.maxStamina;
            slider.value    = fighter.currentStamina;
        }
    }
    void Update()
    {
        if (fighter == null || slider == null) return;

        slider.minValue = 0f;
        slider.maxValue = fighter.maxStamina;

        slider.value = fighter.currentStamina;
    }
}
