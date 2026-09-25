import apolloUrl from "@assets/APOLLO.mp3";
import ashUrl from "@assets/ASH.mp3";
import egoPurgatoryUrl from "@assets/EGO PURGATORY.mp3";
import elevenTwelveUrl from "@assets/ELEVEN TWELVE.mp3";
import falseSwipeUrl from "@assets/FALSE SWIPE.mp3";
import fighghtUrl from "@assets/FIGHGHT.mp3";
import instinctUrl from "@assets/INSTINCT.mp3";
import kingUrl from "@assets/KING.mp3";
import metaphysicsUrl from "@assets/METAPHYSICS.mp3";
import newsbreakUrl from "@assets/NEWSBREAK.mp3";
import piecesUrl from "@assets/PIECES.mp3";
import streetfightUrl from "@assets/STREETFIGHT.mp3";
import timeIsMidUrl from "@assets/TIME IS MID.mp3";
import whyDoYouUrl from "@assets/WHY DO YOU.mp3";

export const MUSIC_TRACK_URLS: string[] = [
  apolloUrl,
  ashUrl,
  egoPurgatoryUrl,
  elevenTwelveUrl,
  falseSwipeUrl,
  fighghtUrl,
  instinctUrl,
  kingUrl,
  metaphysicsUrl,
  newsbreakUrl,
  piecesUrl,
  streetfightUrl,
  timeIsMidUrl,
  whyDoYouUrl,
];

// Display names for each track, parallel to MUSIC_TRACK_URLS. Used by the
// career fight-music song picker.
export const MUSIC_TRACK_NAMES: string[] = [
  "APOLLO",
  "ASH",
  "EGO PURGATORY",
  "ELEVEN TWELVE",
  "FALSE SWIPE",
  "FIGHGHT",
  "INSTINCT",
  "KING",
  "METAPHYSICS",
  "NEWSBREAK",
  "PIECES",
  "STREETFIGHT",
  "TIME IS MID",
  "WHY DO YOU",
];

// Guard against the parallel name/url arrays drifting out of sync.
if (MUSIC_TRACK_NAMES.length !== MUSIC_TRACK_URLS.length) {
  console.error(
    `musicTracks: MUSIC_TRACK_NAMES (${MUSIC_TRACK_NAMES.length}) and MUSIC_TRACK_URLS (${MUSIC_TRACK_URLS.length}) lengths must match.`,
  );
}

// Index of the "FIGHGHT" track within MUSIC_TRACK_URLS. Used for career sparring
// (which plays only this song) and the default dynamic career fight-round music.
export const FIGHGHT_TRACK_INDEX = MUSIC_TRACK_URLS.indexOf(fighghtUrl);
