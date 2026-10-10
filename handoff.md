# Handoff — HANDZ accounts & cloud saves

## 1) Goal
Optional Google/email sign-in, with guest play kept. Signed-in users get one private cloud career with autosync and conflict protection. Requested items:
- Fix the "handz_cloud_guest_backup exceeded the quota" error.
- Remember the signed-in user in the browser.
- Sign-in opens as an in-game panel, not a separate page.
- An account with no save goes straight to the career creator.
- Edit Roster is visible only to the owner's verified email and in the dev build (Replit editor).
- Account access moves to a settings gear in the bottom-right margin. The gear is hidden during fights and minigames.
- Save after every fight or minigame, and after any reward.

## 2) Current state
- Everything above is implemented. The game loads and compiles: tsc shows 77 errors, the same as the pre-existing baseline. Use LSP for real diagnostics.
- Passing: the itemEffects, crateRoll, equipment and cloudSave check scripts.
- A screenshot showed the gear in the bottom-right of the main menu with no overlap. The career hub was not screenshotted.
- The browser E2E (`script/cloudBrowserCheck.ts`) is not fully green. Testing was stopped at the user's request.
- Not tested: the real Google OAuth round-trip.
- Not changeable from code: session lifetime and Clerk's new-device email check. These are Clerk dashboard settings. Clerk already keeps the session per browser, and no app code forces a sign-out.

## 3) Active files
- `client/src/components/CloudAccountPanel.tsx`: the gear, the panel, embedded `<SignIn>`, import with double confirmation, and sign-out.
- `client/src/lib/cloudSaves.tsx`: cloud save provider. Handles autosync, "handz-save-now" coalescing (400ms), conflicts and the guest backup.
- `client/src/lib/cloudBackups.ts`: the guest backup and recovery stash in IndexedDB, plus migration from localStorage.
- `client/src/lib/uiChrome.ts`: screen kind (menu/play/other) and `requestCloudSave()`.
- `client/src/App.tsx`: `useCanEditRoster` and the `autoCreateCareer` prop.
- `client/src/components/Game.tsx`: in setUiMode, sets the screen kind and triggers saves (PLAY_MODES, SAVE_AFTER_MODES, fightEnd). `grantItem` also triggers a save, and the auto-create runs on mount.
- `client/src/components/CareerMode.tsx`: the `startInCreate` prop.
- `client/src/lib/localSaves.ts`: window dispatch is guarded so Node scripts work.
- `script/cloudBrowserCheck.ts`: Playwright E2E. Uses disposable Clerk users and sign-in tokens via `/sign-in?__clerk_ticket=`.

## 4) Changes made
- The guest backup moved from localStorage to IndexedDB, which fixes the quota error. Old copies are migrated and deleted on startup.
- Sign-in is a panel using `routing="hash"` and `panelAppearance` (rootBox/cardBox elements, not `.cl-` CSS). It closes once sign-in completes. The `/sign-in` and `/sign-up` routes remain as a fallback.
- Signed-in users with no fighters open straight into the career creator.
- The Edit Roster button is hidden unless the user is in the dev build or signed in with the owner's verified email.
- The account button was replaced by one bottom-right gear (`aria-label="Open account and cloud saves"`). It hides during play, and the panel closes when play starts.
- Saves are requested when leaving a fight or minigame, on fightEnd, and on item grants.
- E2E script: debug logging removed. The second browser context is now closed before the third account starts.

## 5) Recent failed attempts
- The E2E run passed through "A separate browser restores the account career". It then hung on the empty-account step: `locator('body').innerText` timed out, so the page appeared frozen. The likely cause is three swiftshader WebGL tabs starving the CPU, and the fix above targets that. It is unconfirmed.
- The next run timed out early, waiting for the "Career Mode" button. This looks like flaky load/compile time and has not been diagnosed.
- `npx tsc --noEmit` falls back to an ES5 config and floods false errors. Do not chase them.

## 6) Potential next steps
- Optional: re-run the E2E once with only one or two contexts. If "Career Mode" still times out, raise the `inGame` timeout.
- Screenshot the career hub and other screens to confirm the gear covers no UI.
- Test Google sign-in manually in the browser.
- If longer sessions or no new-device email check are wanted, change those in the Clerk dashboard.
- Add a memory note covering the account/save rules: IndexedDB backups, save-now triggers and screen-kind gating. Leave the email out of it.
