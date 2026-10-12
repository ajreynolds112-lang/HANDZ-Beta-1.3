/**
 * Player-text filter (decals, fighter names, gym name, outfits): masks hardcore swearing, slurs and explicit sexual terms
 * with asterisks. Mild swearing (damn, hell, crap, ass, shit, piss, bitch,
 * bastard, bloody…) is deliberately allowed.
 *
 * Catches leetspeak (f4gg0t), stretched letters (fuuuck), punctuation inside a
 * word (f.u.c.k) and spaced-out letters (f u c k), without matching across
 * normal word gaps, so innocent phrases like "who reads" stay untouched.
 */

/** Matched anywhere inside a word (no common innocent words contain these). */
const ANYWHERE = [
  "fuck", "fuk", "phuck", "cunt", "nigger", "nigga", "faggot", "cocksuck", "blowjob", "jizz", "wetback", "cumshot", "motherfuck",
];
/** Matched only as a whole word, optionally with a plural/verb ending. */
const WHOLE_WORD = [
  "fuq", "fuc", "fck", "fcuk", "fag", "kunt", "retard", "kike", "spic", "chink", "tranny", "dyke", "whore", "slut", "twat",
  "rape", "rapist", "pedo", "paedo", "coon", "gook", "beaner", "raghead", "towelhead", "cum", "cock", "dildo", "nazi",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "9": "g" };

// Each letter may repeat (fuuuck), so a root becomes f+u+c+k+.
const stretch = (w: string) => w.split("").map(c => `${c}+`).join("");
const ANYWHERE_RE = new RegExp(ANYWHERE.map(stretch).join("|"));
const WHOLE_WORD_RE = new RegExp(`^(?:${WHOLE_WORD.map(stretch).join("|")})(?:s|es|ed|ing|in|er|ers|z)?$`);

interface Token { norm: string; at: number[]; single: boolean }

/** Split into words; a run of single letters ("f u c k") is read as one word. */
function tokens(text: string): Token[] {
  const words: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let norm = "";
    const at: number[] = [];
    for (let i = 0; i < m[0].length; i++) {
      const c = m[0][i].toLowerCase();
      const l = LEET[c] ?? c;
      if (l >= "a" && l <= "z") { norm += l; at.push(m.index + i); }
    }
    if (norm) words.push({ norm, at, single: norm.length === 1 });
  }
  const out: Token[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (w.single && prev?.single) { prev.norm += w.norm; prev.at.push(...w.at); continue; }
    out.push(w);
  }
  return out;
}

/** The text with every word containing a hardcore term replaced by asterisks (same length). */
export function filterProfanity(text: string): string {
  if (!text) return text;
  const chars = text.split("");
  let hit = false;
  const mask = (at: number[], from: number, to: number) => {
    for (let i = at[from]; i <= at[to]; i++) if (!/\s/.test(chars[i])) chars[i] = "*";
    hit = true;
  };
  for (const t of tokens(text)) {
    if (WHOLE_WORD_RE.test(t.norm) || ANYWHERE_RE.test(t.norm)) mask(t.at, 0, t.at.length - 1);
  }
  return hit ? chars.join("") : text;
}
