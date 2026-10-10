/**
 * Opt-in development E2E check. Uses disposable Clerk test users and an isolated
 * browser; never reads or changes the creator's browser career.
 * Run: npx tsx script/cloudBrowserCheck.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "@playwright/test";
import { clerkClient } from "@clerk/express";
import { pool } from "../server/db";

if (process.env.NODE_ENV === "production") throw new Error("Development-only check.");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const browser = await chromium.launch({
  executablePath: "/repl/tools/bin/chromium", headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ids: string[] = [];
const errors: string[] = [];
const testing = await clerkClient.testingTokens.createTestingToken();
const password = `Handz!${randomUUID()}aA9`;

async function prepare(page: Page) {
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.hostname.includes("clerk.accounts") || url.hostname.includes("clerk.dev")) {
      url.searchParams.set("__clerk_testing_token", testing.token);
      await route.continue({ url: url.href });
    } else await route.continue();
  });
}
async function signIn(page: Page, email: string) {
  const user = (await clerkClient.users.getUserList({ emailAddress: [email] })).data[0];
  const ticket = await clerkClient.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 300 });
  await page.goto(`${origin}/sign-in?__clerk_ticket=${ticket.token}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/play", { timeout: 60_000, waitUntil: "domcontentloaded" });
  // This direct-domain-only development banner is not part of the game.
  await page.addStyleTag({ content: "#replit-dev-banner{display:none!important;pointer-events:none!important}" });
}
async function inGame(page: Page) {
  await page.getByRole("button", { name: "Career Mode", exact: true }).waitFor({ timeout: 60_000 });
}
async function cloud(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/cloud-save");
    return { status: response.status, ...(await response.json()) };
  });
}
async function account(page: Page) {
  await page.getByRole("button", { name: "Open account and cloud saves" }).click();
}
async function newUser() {
  const email = `handz+clerk_test_${randomUUID()}@example.com`;
  const user = await clerkClient.users.createUser({ emailAddress: [email], password, skipPasswordChecks: true });
  ids.push(user.id);
  return email;
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepare(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await inGame(page);
  await page.addStyleTag({ content: "#replit-dev-banner{display:none!important;pointer-events:none!important}" });
  assert.equal((await cloud(page)).status, 401);
  await account(page);
  await page.getByRole("button", { name: /Continue with Google/ }).waitFor({ timeout: 60_000 });
  assert(await page.locator("section[aria-label='Account and cloud saves'] input[name='identifier']").isVisible());
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByRole("button", { name: "Close account panel" }).click();
  console.log("Guest sign-in is an in-game panel with Google and email.");
  const guest = await page.evaluate(async () => {
    const local = await import("/src/lib/localSaves.ts");
    const fighter = local.createFighter({ name: "Guest Check", firstName: "Guest", lastName: "Check", archetype: "BoxerPuncher" });
    return local.exportSaveFile(fighter);
  });
  assert(!Object.keys(guest.browserState).some(key => key.startsWith("handz_cloud_")));
  const email = await newUser();
  await signIn(page, email);
  await inGame(page);
  assert(!(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("handz_cloud_guest") || key.startsWith("handz_cloud_recovery")))));
  console.log("Guest backup kept out of localStorage.");
  await account(page);
  await page.getByText("Career synced", { exact: true }).waitFor({ timeout: 30_000 });
  let saved = await cloud(page);
  assert.equal(saved.status, 200);
  assert.equal(saved.save.fighter.name, "Guest Check");
  console.log("Guest career adopted by a new account; private cloud save authenticated.");

  const incoming = { ...guest, fighter: { ...guest.fighter, name: "Imported Check" } };
  const input = page.getByLabel("Choose career save file");
  await input.setInputFiles({ name: "handz-career.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)) });
  await page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal((await cloud(page)).save.fighter.name, "Guest Check");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await cloud(page)).save.fighter.name, "Guest Check");
  await input.setInputFiles({ name: "handz-career.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)) });
  await page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Permanently replace", exact: true }).click();
  await page.getByRole("button", { name: "Career Mode", exact: true }).waitFor({ timeout: 30_000 });
  saved = await cloud(page);
  assert.equal(saved.save.fighter.name, "Imported Check");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("handz_saves")!)[0].name), "Imported Check");
  console.log("First confirmation and cancellation leave cloud untouched; second confirmation replaces it.");

  const checks = await page.evaluate(async ({ revision, save }) => {
    const headers = { "Content-Type": "application/json" };
    const missing = await fetch("/api/cloud-save", { method: "PUT", headers, body: JSON.stringify({ revision, save, reason: "import" }) });
    const stale = await fetch("/api/cloud-save", { method: "PUT", headers, body: JSON.stringify({ revision: 0, save, reason: "autosave" }) });
    return { missingConfirmations: missing.status, staleRevision: stale.status };
  }, saved);
  assert.equal(checks.missingConfirmations, 400);
  assert.equal(checks.staleRevision, 409);
  console.log("Server rejects missing confirmations and stale revisions.");

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await prepare(secondPage);
  await signIn(secondPage, email);
  await inGame(secondPage);
  assert.equal(await secondPage.evaluate(() => JSON.parse(localStorage.getItem("handz_saves")!)[0].name), "Imported Check");
  console.log("A separate browser restores the account career.");
  // Software WebGL is CPU-heavy; keep at most two game tabs alive.
  await secondContext.close();
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await prepare(otherPage);
  await signIn(otherPage, await newUser());
  await otherPage.getByTestId("input-first-name").waitFor({ timeout: 90_000 });
  assert.equal((await cloud(otherPage)).save, null);
  console.log("A different account cannot see the first account's career; an empty account opens the career creator.");
  await otherPage.reload({ waitUntil: "domcontentloaded" });
  await otherPage.waitForURL("**/play", { timeout: 60_000, waitUntil: "domcontentloaded" });
  await otherPage.getByTestId("input-first-name").waitFor({ timeout: 90_000 });
  await otherContext.close();
  console.log("The browser remembers the signed-in account after a reload.");

  await account(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(origin + "/", { timeout: 30_000 });
  await inGame(page);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("handz_saves")!)[0].name), "Guest Check");
  assert.equal((await cloud(page)).status, 401);
  console.log("Sign-out restores the original guest career.");
  assert.deepEqual(errors, []);
  console.log("Cloud career E2E checks passed without page errors.");
} finally {
  await browser.close();
  for (const id of ids) {
    await pool.query("DELETE FROM career_cloud_saves WHERE user_id = $1", [id]);
    await clerkClient.users.deleteUser(id);
  }
  await pool.end();
}
