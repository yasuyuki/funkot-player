import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {dirname,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {writeFileSync} from "node:fs";
const require=createRequire(import.meta.url);
const {chromium}=require(process.argv[2] || "playwright");
const axe=require.resolve(process.argv[3] || "axe-core/axe.min.js");
const here=dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {});
const report=[];
try{
  for(const width of [412,1280]){
    const page=await browser.newPage({viewport:{width,height:width===412?915:900},hasTouch:width===412});
    await page.route(/^https?:/,r=>r.abort());
    await page.goto(pathToFileURL(resolve(here,"index.html")).href+"?capture=1&s=a");
    await page.addScriptTag({path:axe});
    for(const stage of ["search","detail","editor"]){
      let region;
      if(stage==="search"){await page.locator("#indexSearchInput").fill("2015");region=["#query","#lens"];}
      if(stage==="detail"){await page.locator("#indexSearchInput").press("Escape");await page.locator(".row-main").first().click();region=[".record-card"];}
      if(stage==="editor"){await page.locator("[data-do=edit]").click();region=[".index-editor"];}
      const result=await page.evaluate(async include=>{
        const {violations}=await axe.run({include:include.map(s=>[s])},{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});
        return violations.map(v=>({rule:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}));
      },region);
      report.push({width,stage,result});
      if(stage==="editor"){
        // Native dialog must keep forward and reverse keyboard navigation inside.
        for (const key of ["Tab","Shift+Tab"]) {
          for(let i=0;i<16;i++){
            await page.keyboard.press(key);
            const inside=await page.evaluate(()=>!!document.activeElement.closest("dialog.index-editor") || document.activeElement===document.body);
            assert(inside);
          }
        }
        await page.keyboard.press("Escape");
        assert(await page.locator(".record-card[open] [data-do=edit]").evaluate(el=>el===document.activeElement));
      }
    }
    await page.close();
  }
  writeFileSync(resolve(here,"evidence/accessibility.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
}finally{await browser.close()}
