// Browser acceptance against the real Svelte application with synthetic IPC.
// Prepare the optional test tool with `npm install --no-save --package-lock=false playwright@1.63.0`.
// This does not install or launch a native player, access music, or test audio.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const output = resolve(process.env.UI_EVIDENCE_DIR ?? ".desktop-data/tag-ui-evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route(`${base}/fixture-bootstrap.js`, async route => route.fulfill({
    contentType: "text/javascript",
    body: await readFile(new URL("fixtures/track-tags-ui.js", import.meta.url), "utf8"),
  }));
  await page.route(`${base}/`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("/src/main.ts", "/fixture-bootstrap.js") });
  });
  await page.goto(base);
  await page.getByText("Synthetic Alpha", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  results.push("Real application boots with synthetic typed IPC");
  await page.screenshot({ path: resolve(output, "library-desktop.png"), fullPage: true });
  await page.getByText("Synthetic Alpha", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("spinbutton").fill("2022");
  await dialog.getByRole("spinbutton").press("Tab");
  await page.evaluate(() => { window.fixture.fail = "persist_failed"; });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.getByRole("spinbutton").inputValue(), "2022");
  await page.screenshot({ path: resolve(output, "editor-save-failure.png"), fullPage: true });
  results.push("Save failure keeps the dialog and year input");
  await page.evaluate(() => { window.fixture.fail = null; window.fixture.delay = 250; });
  await dialog.getByRole("button", { name: "Save", exact: true }).dblclick();
  await dialog.waitFor({ state: "hidden" });
  const updates = await page.evaluate(() => window.fixture.calls.filter(c => c.command === "update_track_tags"));
  assert.equal(updates.length, 2, "Failed save plus exactly one successful submit");
  assert.deepEqual(updates[1].args.request.targets, [{ path: "/synthetic/Alpha.mp3", expected_hash: "a" }]);
  assert.deepEqual(updates[1].args.request.patch.year_change, { mode: "set", value: 2022 });
  results.push("Double click produces one transaction with the captured identity and year patch");
  assert.equal(await page.evaluate(() => window.fixture.store.trackTags.tracks["/synthetic/Duplicate.mp3"].effective.find(t => t.kind === "year").value), "2022");
  results.push("Successful snapshot updates duplicate hash paths");
  assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Synthetic Alpha/);
  results.push("Focus returns to the original library row");
  const open = async title => {
    await page.getByText(`Synthetic ${title}`, { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit tags", exact: true }).click();
    await dialog.waitFor();
  };
  const save = async () => {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const lastRequest = () => page.evaluate(() => window.fixture.calls.filter(c => c.command === "update_track_tags").at(-1).args.request);
  await open("Alpha");
  await dialog.getByText("Year candidates", { exact: true }).click();
  await dialog.getByRole("button", { name: "Use 2024", exact: true }).click();
  await save();
  assert.deepEqual((await lastRequest()).patch.year_change, { mode: "set", value: 2024 });
  for (const [name, mode] of [["Use automatic year", "auto"], ["Keep year unset", "unset"]]) {
    await open("Alpha");
    await dialog.getByRole("radio", { name, exact: true }).check();
    await save();
    assert.deepEqual((await lastRequest()).patch.year_change, { mode });
  }
  results.push("Explicit candidate adoption is manual set; auto and unset send distinct patches");
  await open("Alpha");
  await dialog.getByRole("button", { name: "Remove Genre: Funkot", exact: true }).click();
  await save();
  assert.deepEqual((await lastRequest()).patch.remove, [{kind:"genre",value:"Funkot"}]);
  await open("Alpha");
  await dialog.getByRole("button", { name: "Restore: Genre: Funkot", exact: true }).click();
  await save();
  assert.deepEqual((await lastRequest()).patch.add, [{kind:"genre",value:"Funkot"}]);
  await open("Alpha");
  await dialog.getByLabel("Kind", { exact:true }).selectOption("custom");
  await dialog.getByRole("textbox", { name:"Tag",exact:true }).fill("2024");
  await save();
  assert.deepEqual((await lastRequest()).patch.add,[{kind:"custom",value:"2024"}]);
  assert.equal((await lastRequest()).patch.year_change,undefined);
  results.push("Automatic genre removal/restoration and numeric custom tags use typed patches");
  await open("Alpha");
  const countBeforeCancel = await page.evaluate(() => window.fixture.calls.filter(c=>c.command==="update_track_tags").length);
  await dialog.getByRole("textbox", { name:"Tag",exact:true }).fill("Discarded draft");
  await dialog.getByRole("button", { name:"Add tag",exact:true }).focus();
  await page.keyboard.press("f");
  await page.keyboard.press("j");
  await page.keyboard.press("Space");
  const controls = await dialog.locator("input:enabled,button:enabled,select:enabled,summary").count();
  for(let i=0;i<=controls;i++) {
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c=>c.command==="update_track_tags").length),countBeforeCancel);
  results.push("Cancel changes nothing; Tab stays in modal and F/J/Space do not invoke player actions");
  const library = page.locator("section.library");
  await library.getByRole("button", {name:"Select several tracks",exact:true}).click();
  await library.getByRole("checkbox", {name:"Select Synthetic Alpha",exact:true}).check();
  await library.getByRole("checkbox", {name:"Select Synthetic Beta",exact:true}).check();
  await library.getByRole("searchbox").fill("Alpha");
  await library.getByRole("button", {name:/Edit visible selected/}).click();
  await dialog.getByRole("textbox", {name:"Tag",exact:true}).fill("Visible only");
  // Underlying filter changes while the modal is open cannot change its targets.
  await library.getByRole("searchbox").evaluate(el => { el.value="Beta";el.dispatchEvent(new Event("input",{bubbles:true})); });
  await save();
  assert.deepEqual((await lastRequest()).targets,[{path:"/synthetic/Alpha.mp3",expected_hash:"a"}]);
  assert.equal((await lastRequest()).patch.year_change,undefined);
  results.push("Hidden selection is excluded and targets stay frozen after the filter changes");
  await library.getByRole("searchbox").fill("");
  await library.getByRole("button", {name:/Edit visible selected/}).click();
  await dialog.getByText("Mixed",{exact:true}).first().waitFor();
  await dialog.getByRole("textbox", {name:"Tag",exact:true}).fill("Batch addition");
  await save();
  assert.deepEqual((await lastRequest()).targets.map(t=>t.expected_hash),["a","b"]);
  assert.equal((await lastRequest()).patch.year_change,undefined);
  assert.deepEqual(await page.evaluate(()=>["Alpha","Beta"].map(n=>window.fixture.store.trackTags.tracks[`/synthetic/${n}.mp3`].effective.find(t=>t.kind==="year")?.value??null)),[null,"2023"]);
  results.push("Mixed years stay unchanged during bulk tag addition, including non-Funkot tracks");
  await library.getByRole("checkbox", {name:"Select Synthetic Unresolved",exact:true}).check();
  assert.equal(await library.getByRole("button", {name:/Edit visible selected/}).isDisabled(),true);
  await library.getByRole("checkbox", {name:"Select Synthetic Unresolved",exact:true}).uncheck();
  results.push("Unresolved identity disables the batch with an explanation");
  await open("Beta");
  await dialog.getByRole("spinbutton").fill("2021");
  await dialog.getByRole("spinbutton").press("Tab");
  await page.evaluate(async()=>{window.fixture.snapshot.revision=`fixture:${Number(window.fixture.snapshot.revision.split(':')[1])+1}`;await window.fixture.store.reloadTrackTags();});
  await dialog.getByRole("button",{name:"Save",exact:true}).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.getByRole("spinbutton").inputValue(),"2021");
  await page.evaluate(()=>{window.fixture.failRead=true;});
  await dialog.getByRole("button",{name:"Reload tags",exact:true}).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.getByRole("spinbutton").inputValue(),"2021");
  await page.evaluate(()=>{window.fixture.failRead=false;});
  await dialog.getByRole("button",{name:"Reload tags",exact:true}).click();
  await dialog.getByText("Tags reloaded",{exact:true}).waitFor();
  await save();
  assert.deepEqual((await lastRequest()).targets,[{path:"/synthetic/Beta.mp3",expected_hash:"b"}]);
  assert.deepEqual((await lastRequest()).patch.year_change,{mode:"set",value:2021});
  results.push("Stale revision and failed reload preserve the draft; explicit successful reload keeps the same identity");
  await open("Beta");
  await page.evaluate(async()=>{window.fixture.snapshot.tracks['/synthetic/Beta.mp3'].content_hash='replacement';window.fixture.snapshot.revision=`fixture:${Number(window.fixture.snapshot.revision.split(':')[1])+1}`;await window.fixture.store.reloadTrackTags();});
  await dialog.getByRole("button",{name:"Reload tags",exact:true}).click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.getByRole("alert").innerText(),/changed/i);
  await page.keyboard.press("Escape");
  await page.evaluate(async()=>{window.fixture.snapshot.tracks['/synthetic/Beta.mp3'].content_hash='b';await window.fixture.store.reloadTrackTags();});
  results.push("Reload refuses replacement identity without silently retargeting the dialog");
  await open("Alpha");
  await save();
  await page.getByText("No tag changes",{exact:true}).waitFor();
  results.push("An empty patch reports no-op separately from saved changes");
  await page.setViewportSize({width:375,height:667});
  await page.getByRole("tab",{name:"Library",exact:true}).click();
  await open("Alpha");
  for(const locale of ["ja","id","en"]){
    await page.evaluate(locale=>window.fixture.i18n.setLocale(locale),locale);
    await page.screenshot({path:resolve(output,`editor-narrow-${locale}.png`),fullPage:true});
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  }
  await page.setViewportSize({width:375,height:360});
  await dialog.getByRole("textbox",{name:"Tag",exact:true}).fill("Keyboard viewport");
  await dialog.getByRole("button",{name:"Save",exact:true}).scrollIntoViewIfNeeded();
  const saveRect=await dialog.getByRole("button",{name:"Save",exact:true}).boundingBox();
  assert.ok(saveRect.y>=0&&saveRect.y+saveRect.height<=360);
  await page.screenshot({path:resolve(output,"editor-keyboard-viewport.png"),fullPage:true});
  await page.keyboard.press("Escape");
  results.push("ja/en/id narrow dialog has no horizontal overflow and controls remain reachable in a reduced viewport");
  const mutations=await page.evaluate(()=>window.fixture.calls.filter(c=>!['get_locale','app_dirs','take_pending_import','get_allow_non_funkot','get_labeling_mode','player_state','queue_state','list_new_arrivals','list_play_history','refresh_library','list_track_tags','update_track_tags'].includes(c.command)));
  assert.deepEqual(mutations,[]);
  results.push("Tag operations do not send playback, queue, label, or history mutations");
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "results.json"), JSON.stringify({ browser: browser.version(), results, errors }, null, 2));
  console.log(JSON.stringify({ browser: browser.version(), results, output }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
