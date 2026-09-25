using UnityEngine;
public class FighterClass : MonoBehaviour
{
    public enum Archetype
    {
        BoxerPuncher,
        OutBoxer,
        Brawler,
        Swarmer
    }
    [Header("Fighter Class")]
    public Archetype archetype = Archetype.BoxerPuncher;
    public float MaxStaminaMult
    {
        get
        {
            switch (archetype)
            {
                case Archetype.Brawler:  return 1.15f;
                case Archetype.Swarmer:  return 0.90f;
                default:                 return 1.00f;
            }
        }
    }
    public float RegenMult
    {
        get
        {
            switch (archetype)
            {
                case Archetype.OutBoxer: return 1.075f;
                case Archetype.Swarmer:  return 1.05f;
                default:                 return 1.00f;
            }
        }
    }
    public float PunchCostMult
    {
        get
        {
            switch (archetype)
            {
                case Archetype.OutBoxer: return 0.85f;
                case Archetype.Brawler:  return 1.22f;
                case Archetype.Swarmer:  return 0.90f;
                default:                 return 1.00f;
            }
        }
    }
    public float DamageDealtMult
    {
        get
        {
            switch (archetype)
            {
                case Archetype.OutBoxer: return 0.95f;
                case Archetype.Brawler:  return 1.15f;
                case Archetype.Swarmer:  return 1.05f;
                default:                 return 1.00f;
            }
        }
    }
}
