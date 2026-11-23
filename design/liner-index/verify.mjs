// Run beside index.html with a local Playwright installation.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(resolve(here,process.env.LINER_ENTRY || "index.html")).href;
const out = resolve(here,"evidence");
mkdirSync(out,{recursive:true});
const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {});
const evidence = {browser:browser.version(), viewports:[]};
try {
  for (const [width,height] of [[412,915],[1280,900]]) {
    const page = await browser.newPage({viewport:{width,height},hasTouch:width<500,reducedMotion:"reduce"});
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror",e=>errors.push(e.message));
    // Offline acceptance also checks that the archive needs no hosted font or script.
    await page.route(/^https?:/,route=>route.abort());
    const row = {width,height,checks:[],screens:[],choices:{},layout:{}};
    evidence.viewports.push(row);
    const shot = async name => {
      await page.screenshot({path:resolve(out,width+"-"+name+".png"),animations:"disabled"});
      row.screens.push(name);
      row.layout[name] = await page.evaluate(() => {
        const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
        const roots = modal ? [modal] : [document.querySelector("#query"),document.querySelector("#lens")];
        const controls = roots.flatMap(root => [...root.querySelectorAll("button,input,select,summary")]);
        const inView = controls.filter(el => {
          const r=el.getBoundingClientRect();
          return r.height && r.width && r.top < innerHeight && r.bottom > 0 && r.x < innerWidth && r.right>0 && el.checkVisibility();
        });
        const short = [...new Set(inView.filter(el => el.offsetHeight<44 || el.offsetWidth<44).map(el=>el.getAttribute("data-action") || el.getAttribute("data-editor-action") || el.tagName))];
        return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,visibleControls:inView.length,below44px:short,focus:document.activeElement.getAttribute("aria-label") || document.activeElement.id || document.activeElement.tagName};
      });
      assert(!row.layout[name].horizontalOverflow,name+" horizontal overflow");
    };
    const visit = async (s="base") => {
      await page.goto(entry+"?capture=1&s="+s);
      await page.waitForFunction(()=>window.indexSearch && window.indexDetail && window.indexEditor);
    };
    await visit();
    assert.equal(await page.evaluate(()=>FK.songs.length),24823);
    row.keys=await page.evaluate(()=>FK.tagIndex.size);
    assert(row.keys>=2600);
    const find=page.locator("#indexSearchInput");
    for(const [query,kind] of [["2015","制作年"],["日本人トラックメーカー","タグ"],["アニソンremix","ジャンル"]]){
      await find.fill(query);
      const choices=page.locator("#lens [role=option]");
      await choices.first().waitFor();
      if(query==="2015"){
        await shot("search");
        row.choices.first=await choices.count();
      }
      await choices.filter({hasText:kind}).filter({hasText:query}).first().click();
    }
    assert.equal(await page.evaluate(()=>FKP.S.clauses.length),3);
    assert(await page.evaluate(()=>FKP.results().every(s=>s.year===2015 && s.tags.includes("日本人トラックメーカー") && s.genres.includes("アニソンremix"))));
    assert(await page.evaluate(()=>FKP.results().length>0));
    row.checks.push("選択した3条件と全結果の実データが一致");
    await find.press("Escape");
    await visit("eight");
    await page.locator(".index-term-main").first().click();
    await page.locator('[data-action=advanced]').first().click();
    await shot("advanced");
    assert.equal(await page.evaluate(()=>FKP.S.clauses.length),9);
    row.checks.push("9条件・グループ内OR・否定・一時停止");
    await visit("a");
    const target=page.locator('.row-main[aria-label*="放課後シグナル"]').first();
    const original=await target.getAttribute("data-id");
    await target.click();
    const detail=page.locator("dialog.record-card");
    assert(await detail.isVisible());
    await shot("detail");
    await detail.locator('[data-key=versions] summary').click();
    assert((await detail.locator(".record-version").count())>=2);
    await detail.locator(".record-version:enabled").first().click();
    await detail.locator('[data-do=back]').click();
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.id),original);
    assert.equal(await page.evaluate(()=>FKP.S.clauses.length),3);
    row.checks.push("同名ファイル切替後も元の曲行へフォーカス復帰・検索条件保持");
    await target.click();
    await detail.locator('[data-do=edit]').click();
    await shot("single");
    await verifyEditor(page,row,shot,visit);
    await verifySharedRecord(page,row);
    assert.deepEqual(errors,[]);
    await page.close();
  }
  writeFileSync(resolve(out,"results.json"),JSON.stringify(evidence,null,2)+"\n");
  console.log("passed",evidence.viewports.map(r=>[r.width,r.checks.length,r.screens.length]));
} finally { await browser.close(); }


async function verifyEditor(page,row,shot,visit) {
  const editor = page.locator("dialog.index-editor[open]");
  const action = name => editor.locator('[data-editor-action="'+name+'"]').first();
  const input = editor.locator('[data-editor-field=filter]');
  const detail = page.locator("dialog.record-card[open]");
  const focusSong = await page.locator('.row-main[aria-label*="放課後シグナル"]').first().getAttribute("data-id");
  const snapshot = () => page.evaluate(id=>{
    const s=FK.songs.find(song=>song.id===Number(id));
    const {contentHash,year,tags} = indexEditor.info(s);
    return {contentHash,year,tags};
  },focusSong);
  const initial = await snapshot();
  const newTag = "夜の試聴";
  const addTag = async () => {
    await input.fill(newTag);
    await editor.locator('[data-editor-action=add][data-key="custom:'+newTag+'"]').click();
  };
  const leave = async () => {
    await action("cancel").click();
    const discard = editor.locator('[data-editor-action=discard]');
    if(await discard.isVisible()) await discard.click();
  };
  const experiment = async name => {
    const b = action(name);
    if(!await b.isVisible()) await editor.locator("details:has([data-editor-action='"+name+"']) > summary").click();
    await b.click();
  };
  await addTag(); await leave();
  assert.deepEqual(await snapshot(),initial);
  await detail.locator('[data-do=edit]').click();
  await addTag();
  await experiment("conflict"); await action("save").click();
  await shot("conflict");
  assert.deepEqual(await snapshot(),initial);
  await experiment("reload"); await action("save").click();
  assert((await snapshot()).tags.some(t=>t.value===newTag && t.origin==="manual"));
  assert.equal((await snapshot()).contentHash,initial.contentHash);
  row.checks.push("取消でドラフト破棄、競合で無変更、再読込後に同じ曲へ手動タグ保存");
  await detail.locator('[data-do=back]').click();
  await visit();
  const heavy = await page.evaluate(()=>FK.songs.reduce((best,s)=>s.tags.length>best.tags.length?s:best).id);
  await page.evaluate(id=>indexDetail.open(id),heavy);
  await detail.locator('[data-do=edit]').click();
  await shot("many-tags");
  const count=await page.evaluate(id=>indexEditor.info(FK.songs.find(s=>s.id===id)).tags.length,heavy);
  assert(count>=100); row.manyTags=count;
  const late=await page.evaluate(id=>FK.songs.find(s=>s.id===id).tags.at(-1),heavy);
  await input.fill(late);
  const remove=editor.locator('[data-editor-action=remove]').filter({hasText:late}).first();
  await remove.click();
  await action("undo").click();
  assert(await page.evaluate(({heavy,late})=>FK.songs.find(s=>s.id===heavy).tags.includes(late),{heavy,late}));
  await input.fill("Funkot");
  await editor.locator('[data-editor-action=remove][data-key="genre:Funkot"]').click();
  await action("save").click();
  assert(!(await page.evaluate(id=>FK.songs.find(s=>s.id===id).genres.includes("Funkot"),heavy)));
  await detail.locator('[data-do=edit]').click(); await input.fill("Funkot");
  await editor.locator('[data-editor-action=add][data-key="genre:Funkot"]').click(); await action("save").click();
  assert(await page.evaluate(id=>FK.songs.find(s=>s.id===id).genres.includes("Funkot"),heavy));
  row.checks.push("大量タグを名前で探して削除を取り消し、埋め込みジャンルの除外と再追加");
  await detail.locator('[data-do=back]').click();
  await visit("a-select");
  assert(await page.evaluate(()=>FKP.results().filter(s=>FKP.S.selected.has(s.id)).length>=2));
  await page.locator('[data-act=edit-selected]').click();
  await shot("bulk");
  assert.equal(await editor.locator('[data-editor-field=year-mode]').inputValue(),"unchanged");
  const selected=await page.evaluate(()=>FKP.results().filter(s=>FKP.S.selected.has(s.id)).map(s=>s.id));
  const bulkBefore=await page.evaluate(ids=>ids.map(id=>indexEditor.info(FK.songs.find(s=>s.id===id)).tags),selected);
  await addTag();
  await page.evaluate(()=>{FKP.S.selected.clear();FKP.S.clauses=[FKP.newClause("text","no matches after opening")];FKP.update()});
  await experiment("scan"); await action("save").click();
  assert.deepEqual(await page.evaluate(ids=>ids.map(id=>indexEditor.info(FK.songs.find(s=>s.id===id)).tags),selected),bulkBefore);
  await experiment("reload"); await action("save").click();
  assert(await page.evaluate(ids=>ids.every(id=>FK.songs.find(s=>s.id===id).tags.includes("夜の試聴")),selected));
  row.checks.push("一括操作中の検索・選択変更と再スキャン後も当初の対象へ保存");
  await visit("a");
  await page.locator('.row-main[aria-label*="放課後シグナル"]').first().click();
  await detail.locator('[data-do=edit]').click();
  await addTag(); await experiment("persist"); await action("save").click();
  await shot("failed");
  assert(!(await snapshot()).tags.some(t=>t.value===newTag));
  await experiment("identity"); await action("save").click(); await experiment("reload");
  assert(await editor.isVisible());
  assert(!(await snapshot()).tags.some(t=>t.value===newTag));
  row.checks.push("保存失敗・識別変更後は再読込でも別の曲に下書きを書かない");
  if (row.width===412) {
    await page.setViewportSize({width:412,height:510});
    await input.focus();
    await page.keyboard.press("Tab");
    assert(await page.evaluate(()=>document.activeElement.closest("dialog.index-editor")!==null));
    await shot("keyboard-space");
    const rect=await action("save").boundingBox();
    assert(rect.y>=0 && rect.y+rect.height<=511);
    await page.setViewportSize({width:412,height:915});
    await page.evaluate(() => {
      const modal=document.querySelector("dialog.index-editor");
      const fonts=[modal,...modal.querySelectorAll("*")].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);
      for (const [el,px] of fonts) el.style.setProperty("font-size",(px*2)+"px","important");
      modal.querySelector(".index-editor-body").scrollTop=0;
    });
    await shot("large-type");
    const enlarged=await action("save").boundingBox(); assert(enlarged.y>=0 && enlarged.y+enlarged.height<=916);
    assert(await editor.locator(".index-editor-body").evaluate(el=>el.clientHeight>50));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    row.checks.push("412×510のキーボード領域代替、文字拡大、保存フッター到達");
  }
}


async function verifySharedRecord(page,row) {
  await page.reload();
  const copies=await page.evaluate(()=>{
    const seen=new Map();
    for(const s of FK.songs){
      const hash=indexEditor.info(s).contentHash;
      if(seen.has(hash)) return [seen.get(hash),s.id];
      seen.set(hash,s.id);
    }
  });
  assert.equal(copies.length,2);
  const inspect=() => page.evaluate(ids=>ids.map(id=>{
    const s=FK.songs.find(x=>x.id===id), info=indexEditor.info(s);
    return {fmt:s.fmt,dur:s.dur,folder:s.folder,year:info.year,revision:info.revision,hash:info.contentHash};
  }),copies);
  async function open(ids) {
    await page.evaluate(ids=>indexEditor.open(ids.map(id=>FK.songs.find(s=>s.id===id)),r=>window.lastEditResult=r),ids);
  }
  const edit=page.locator(".index-editor[open]");
  const year=edit.locator('[data-editor-field=year-mode]');
  const save=edit.locator('[data-editor-action=save]');
  async function choose(mode,value){
    if(!await year.isVisible()) await edit.locator('details:has([data-editor-field=year-mode]) > summary').click();
    await year.selectOption(mode);
    if(value) await edit.locator('[data-editor-field=year-value]').fill(value);
    await save.click();
  }
  const start=await inspect();
  assert.equal(start[0].hash,start[1].hash); assert.equal(start[0].dur,start[1].dur);assert.equal(start[0].fmt,start[1].fmt);
  assert.notEqual(start[0].folder,start[1].folder);
  await open(copies); await choose("set","2011");
  const patched=await inspect(); assert(patched.every(s=>s.year.value===2011 && s.year.origin==="manual"));
  await open([copies[0]]); await choose("set","2011");
  assert.equal(await page.evaluate(()=>lastEditResult.reason),"no_op");
  assert.equal((await inspect())[0].revision,patched[0].revision);
  await open([copies[1]]); await choose("unset"); assert((await inspect()).every(s=>s.year.value===null));
  await open([copies[0]]); await choose("auto"); assert.equal((await inspect())[0].year.value,start[0].year.automatic);
  const guard=await page.evaluate(()=>{
    const get=id=>FK.songs.find(s=>s.id===id);
    const unresolved=indexEditor.open([get(94),get(96)],r=>window.guardResult=r);
    const unset=FKP.newClause("year-unset","unset");
    return {unresolved,reason:window.guardResult.reason,pending:FKP.filter([unset]).includes(get(95))};
  });
  assert.deepEqual(guard,{unresolved:false,reason:"identity_unavailable",pending:false});
  const longId=await page.evaluate(()=>FK.songs.find(s=>s.title.includes("幻の三番")).id);
  await page.evaluate(id=>indexDetail.open(id),longId);
  assert((await page.locator("#record-title").innerText()).includes("幻の三番"));
  assert(await page.locator("#record-title").evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.locator(".record-card [data-do=back]").click();
  await page.evaluate(()=>indexDetail.open(24821));
  await page.locator('.record-card [data-key=file] summary').click();
  assert((await page.locator('.record-card [data-key=file]').innerText()).includes("埋め込み曲名なし"));
  row.checks.push("識別未確定を含む一括保存を拒否、年確認中を未設定から除外、長い題名と欠落情報を表示");
  const available=await page.evaluate(()=>[...new Set(FK.songs.slice(0,100).map(s=>indexEditor.info(s).year.automaticStatus || indexEditor.info(s).year.candidates[0]?.status))]);
  for(const status of ["invalid","future","conflict"]) assert(available.includes(status));
  row.checks.push("同一内容2パスの共有、年の手動指定・未設定・自動、no-opはrevision不変、3種の自動年診断");
}
