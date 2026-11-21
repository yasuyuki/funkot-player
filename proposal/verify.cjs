const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch();
 try{
 for(const [device,width,height,touch] of [['desktop',1280,900,false],['touch',412,915,true]]){
 const page=await browser.newPage({viewport:{width,height},hasTouch:touch,isMobile:touch,locale:'ja-JP'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const by=id=>page.locator('#'+id);
 const press=async loc=>touch?loc.tap():loc.click();
 const capture=async name=>{await page.waitForTimeout(220);fs.mkdirSync(path.join(__dirname,'captures'),{recursive:true});await page.screenshot({path:path.join(__dirname,'captures',device+'-'+name+'.png')})};
 await page.goto(pathToFileURL(path.join(__dirname,'index.html')).href);
 assert.match(await by('total').innerText(),/24,640/);
 await capture('library');await press(by('filter'));
 for(const [q,id] of [['2015',0],['日本人',1],['アニメ',2]]){
 await by('tagq').fill(q);await press(page.locator('[data-tag="'+id+'"]'))}
 await capture('conditions');await press(by('apply'));
 const count=await by('total').innerText();assert.notEqual(count,'0 曲');assert.match(await by('formula').innerText(),/3条件/);
 await capture('results');
 await by('words').fill('Neon');assert.ok((await by('songs').innerText()).includes('Neon Angkot'));await by('words').fill('');
 await press(by('formula'));await press(by('chosen').locator('summary'));await press(by('used').getByText('アニソンremix'));await press(by('apply'));assert.notEqual(await by('total').innerText(),count);
 await press(by('formula'));await press(by('undo'));assert.equal(await by('total').innerText(),count);
 await press(by('formula'));await press(by('logic').getByText('いずれか'));await press(by('apply'));assert.notEqual(await by('total').innerText(),count);await press(by('filter'));await press(by('undo'));
 await press(page.locator('.info').nth(1));await capture('track');await press(by('where'));await capture('destination');await press(by('places').getByText('夜行便'));await press(by('one'));assert.match(await by('notice').innerText(),/夜行便/);
 const row=page.locator('.song').first();await press(row.locator('.add'));assert.match(await row.innerText(),/追加済み/);await capture('added');
 await press(by('multi'));await press(page.locator('.pick input').first());await press(page.locator('.pick input').nth(1));await press(by('bulk').locator('button'));assert.match(await by('notice').innerText(),/2曲.*夜行便/);
 await press(by('multi'));await press(page.locator('.demo summary'));const sample=t=>by('examples').getByText(t);
 await press(sample('9条件'));assert.match(await by('formula').innerText(),/9条件/);await by('filter').scrollIntoViewIfNeeded();await press(by('filter'));await press(by('chosen').locator('summary'));assert.equal(await by('used').locator('button').count(),9);await capture('many');await press(by('close'));
 await press(sample('0件'));assert.match(await by('songs').innerText(),/一致する曲がありません/);
 await press(sample('検索失敗'));await by('retry').waitFor();await press(by('retry'));await by('sheet').waitFor({state:'hidden'});
 await press(by('filter'));await press(by('undo'));await press(sample('文字サイズ'));await page.evaluate(()=>scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await capture('large-type');
 await press(by('filter'));await press(by('chosen').locator('summary'));await press(by('apply'));assert.ok(await by('sheet').isHidden());
 await page.reload();await by('filter').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'filter');
 assert.deepEqual(errors,[]);console.log(device,width,height,count,'flow, exceptions, 200%, keyboard passed');await page.close()
 }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
