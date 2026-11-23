(() => {
  const {tagIndex,playlists}=FK;
  const songs=FK.songs.slice().sort((a,b)=>b.added-a.added);
  const byId=new Map(songs.map(s=>[s.id,s]));
  const $=id=>document.getElementById(id);
  const escape=s=>String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const format=n=>n.toLocaleString("ja-JP");
  const names={year:"制作年",genre:"ジャンル",custom:"タグ",artist:"アーティスト",text:"曲名・アーティスト"};
  const fold=s=>String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96))
    .replace(/りみっくす/g,"remix").replace(/anison[g]?/g,"あにそん").replace(/nihonjin/g,"日本人")
    .replace(/[\s・:：_()/（）-]/g,"");
  const clause=(kind,value,paused=false,not=false)=>({kind,values:[].concat(value),paused,not});
  const three=()=>[clause("year","2015"),clause("custom","日本人トラックメーカー"),clause("genre","アニソンremix")];
  const many=()=>[clause("year",["2015","2016"]),clause("custom","日本人トラックメーカー"),
    clause("genre",["アニソンremix","アニソンRemix","anison remix"]),
    clause("custom","原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ",true),
    clause("genre","Funkot"),clause("custom","コール入り",false,true),clause("custom","多幸感",true),
    clause("text","シグナル"),clause("custom","2015夏頒布",true)];
  const twinCounts=new Map();
  for(const song of songs) {
    const key=JSON.stringify([song.title,song.artist]);
    twinCounts.set(key,(twinCounts.get(key)||0)+1);
  }
  const searchable=new Map(songs.map(s=>[s.id,fold(s.title)+"\n"+fold(s.artist)]));
  const artists=[...new Set(songs.map(s=>s.artist).filter(Boolean))];
  let clauses=[],mode="AND",editing=false,group=null,pageSize=60,filtered=songs;
  let destination="queue",sim="ok",savedResults=[],playing=true,origin=null,noticeTimer;
  const library=Object.fromEntries(playlists.map(p=>[p.id,[]]));
  const undoStack=[],history=[];
  const snap=()=>({clauses:structuredClone(clauses),mode});
  const label=c=>(c.not?"除外 ":"")+c.values.map(v=>c.kind==="year"?v+"年":v).join(" または ");
  const snapshotLabel=s=>s.clauses.map(label).join(s.mode==="AND"?" かつ ":" または ") || "すべての曲";
  function match(c,s) {
    const hit=c.values.some(v=>{
      if(c.kind==="year")return String(s.year)===v;
      if(c.kind==="artist")return s.artist===v;
      if(c.kind==="text")return searchable.get(s.id).includes(fold(v));
      return (c.kind==="genre"?s.genres:s.tags).includes(v);
    });
    return c.not?!hit:hit;
  }
  function run(conditions,op=mode) {
    const active=conditions.filter(c=>!c.paused);
    if(!active.length)return songs;
    return songs.filter(s=>op==="AND"?active.every(c=>match(c,s)):active.some(c=>match(c,s)));
  }
  function remember(s) {
    if(!s.clauses.length)return;
    const key=JSON.stringify(s);
    const index=history.findIndex(x=>JSON.stringify(x)===key);
    if(index>=0)history.splice(index,1);
    history.unshift(structuredClone(s));
  }
  function change(fn) {
    const before=snap();
    fn();
    undoStack.push(before);remember(before);remember(snap());
    sim="ok";pageSize=60;render();
  }
  function applySnapshot(s) {clauses=structuredClone(s.clauses);mode=s.mode;group=null;}
  function propose(kind,values) {
    const next=structuredClone(clauses);
    let index=group;
    if(index===null&&kind==="year") {
      const existing=next.findIndex(c=>c.kind==="year"&&!c.not&&!c.paused);
      if(existing>=0)index=existing;
    }
    if(index!==null&&next[index]?.kind===kind) {
      next[index].values=[...new Set([...next[index].values,...values])];
    } else if(!next.some(c=>c.kind===kind&&!c.not&&!c.paused&&values.every(v=>c.values.includes(v)))) {
      next.push(clause(kind,values));
    }
    return next;
  }
  function choose(kind,values) {
    change(()=>{clauses=propose(kind,values);group=null;$("conditionInput").value="";$("finderInput").value="";});
    $("conditionInput").focus();
  }
  function candidates() {
    const holder=$("candidates");holder.replaceChildren();
    if(!editing)return;
    const q=$("conditionInput").value.trim();
    const f=fold(q.normalize("NFKC").replace(/^(\d{4})年$/,"$1"));
    const kind=group===null?null:clauses[group]?.kind;
    const source=[...tagIndex.values()];
    const matches=source.filter(t=>(!kind||kind===t.kind)&&fold(t.value).includes(f));
    function score(t) {const v=fold(t.value);return (f&&v===f?4:0)+(f&&v.startsWith(f)?2:0);}
    matches.sort((a,b)=>score(b)-score(a)||b.count-a.count);
    const families=new Map();
    for(const t of matches) {
      const key=t.kind+"|"+fold(t.value);
      if(!families.has(key))families.set(key,[]);
      families.get(key).push(t);
    }
    function option(k,values,caption,type) {
      const button=document.createElement("button");
      button.type="button";button.className="candidate";button.setAttribute("role","option");
      const anticipated=run(propose(k,values)).length;
      button.innerHTML="<span>"+escape(caption)+" <small>"+escape(type)+"</small></span><small>追加後 "+format(anticipated)+" 曲</small>";
      button.onclick=()=>choose(k,values);holder.append(button);
    }
    for(const family of [...families.values()].slice(0,8)) {
      const t=family[0];option(t.kind,[t.value],t.value,names[t.kind]);
      if(family.length>1&&f) {
        option(t.kind,family.map(i=>i.value),t.value+"（表記揺れ "+family.length+" 種を含む）",names[t.kind]);
        for(const other of family.slice(1))option(other.kind,[other.value],other.value,names[other.kind]);
      }
    }
    if(q&&(!kind||kind==="artist")) {
      for(const artist of artists.filter(a=>fold(a).includes(f)).slice(0,3))option("artist",[artist],artist,names.artist);
    }
    if(q&&(!kind||kind==="text"))option("text",[q],"「"+q+"」を含む",names.text);
    if(!holder.children.length)holder.textContent="候補がありません";
  }
  function editor() {
    const paused=clauses.filter(c=>c.paused).length;
    $("activeNumber").textContent=String(clauses.length-paused);
    $("activeNumber").hidden=!clauses.length;
    const summary=$("summary");summary.replaceChildren();
    if(clauses.length) {
      const text=document.createElement("span");text.className="summary-label";
      const join=mode==="AND"?"すべてに一致":"いずれかに一致";
      text.textContent=clauses.length+"条件"+(paused?"（"+paused+"件休止）":"")+"・"+join+"　"+clauses.filter(c=>!c.paused).slice(0,3).map(label).join(" / ");
      text.title=snapshotLabel(snap());summary.append(text);
    }
    $("lens").hidden=!editing;
    $("filterBtn").setAttribute("aria-expanded",String(editing));
    $("finderInput").setAttribute("aria-expanded",String(editing));
    $("closeLens").textContent="結果を見る";
    $("joiner").textContent=mode;
    $("toggleJoiner").textContent=mode==="AND"?"いずれかに一致（OR）にする":"すべてに一致（AND）にする";
    $("undoCondition").disabled=!undoStack.length;$("clearConditions").disabled=!clauses.length;
    const panel=$("editorConditions");panel.replaceChildren();
    clauses.forEach((c,i)=>{
      const div=document.createElement("div");div.className="editor-condition";
      const title=document.createElement("strong");title.textContent=label(c)+(c.paused?"（休止中）":"");div.append(title);
      function tool(text,css,fn) {
        const b=document.createElement("button");b.type="button";b.className=css;b.textContent=text;
        b.setAttribute("aria-label",label(c)+"・"+text);b.onclick=()=>{fn();if(!b.isConnected&&document.activeElement===document.body){const peers=panel.children;const target=peers[Math.min(i,peers.length-1)]?.querySelector("."+css);(target||$("conditionInput")).focus();}};div.append(b);
      }
      tool(c.paused?"再開":"休止","pause",()=>change(()=>{c.paused=!c.paused;}));
      tool(c.not?"含める":"除外","negate",()=>change(()=>{c.not=!c.not;}));
      tool("別の値","alternative",()=>{group=i;$("conditionInput").value="";editor();$("conditionInput").focus();});
      tool("解除","remove",()=>change(()=>{clauses.splice(i,1);group=null;}));
      if(c.values.length>1)for(const v of c.values)tool(v+" ×","value-remove",()=>change(()=>{c.values=c.values.filter(x=>x!==v);}));
      panel.append(div);
    });
    $("conditionInput").placeholder=group===null?"曲名・タグ・制作年など":label(clauses[group])+" の別候補";
    $("groupBack").hidden=group===null;
    $("conditionHistory").replaceChildren();
    if(history.length) {
      const details=document.createElement("details"), heading=document.createElement("summary");
      heading.textContent="検索履歴";details.append(heading);
      for(const s of history){const b=document.createElement("button");b.type="button";b.textContent=snapshotLabel(s);b.onclick=()=>change(()=>applySnapshot(s));details.append(b);}
      $("conditionHistory").append(details);
    }
    candidates();
  }
  function openEditor(from,word="") {
    origin=from;editing=true;group=null;$("conditionInput").value=word;editor();$("conditionInput").focus();
  }
  function closeEditor() {
    editing=false;group=null;$("finderInput").value="";editor();(origin||$("filterBtn")).focus();
  }
  $("filterBtn").onclick=()=>editing?closeEditor():openEditor($("filterBtn"));
  $("closeLens").onclick=closeEditor;
  $("finderInput").oninput=e=>{if(e.target.value&&!e.isComposing)openEditor(e.target,e.target.value);};
  $("finderInput").oncompositionend=e=>{if(!editing&&e.target.value)openEditor(e.target,e.target.value);};
  $("conditionInput").oninput=candidates;
  $("groupBack").onclick=()=>{group=null;editor();$("conditionInput").focus();};
  $("clearConditions").onclick=()=>change(()=>{clauses=[];group=null;});
  $("toggleJoiner").onclick=()=>change(()=>{mode=mode==="AND"?"OR":"AND";});
  $("undoCondition").onclick=()=>{const s=undoStack.pop();if(s){applySnapshot(s);sim="ok";render();}};
  $("lens").onkeydown=e=>{
    const buttons=[...$("candidates").querySelectorAll("button")];
    const i=buttons.indexOf(document.activeElement);
    if(e.key==="Escape"){e.preventDefault();closeEditor();}
    else if((i>=0||e.target===$("conditionInput"))&&buttons.length) {
      if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();buttons[(i+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length].focus();}
      else if(e.key==="Enter"&&e.target===$("conditionInput")){e.preventDefault();buttons[0].click();}
    }
    if(e.key==="Tab"&&matchMedia("(max-width:760px)").matches) {
      const targets=[...$("lens").querySelectorAll("button:not(:disabled),input,summary")].filter(b=>b.checkVisibility());
      if(e.shiftKey&&e.target===targets[0]){e.preventDefault();targets.at(-1).focus();}
      else if(!e.shiftKey&&e.target===targets.at(-1)){e.preventDefault();targets[0].focus();}
    }
  };
  const destinationName=()=>playlists.find(p=>p.id===destination).name;
  function toast(message,undo) {
    clearTimeout(noticeTimer);const box=$("toast");box.replaceChildren(message);box.hidden=false;
    if(undo) {const btn=document.createElement("button");btn.type="button";btn.textContent="元に戻す";btn.onclick=()=>{undo();box.hidden=true;};box.append(" ",btn);}
    noticeTimer=setTimeout(()=>box.hidden=true,6500);
  }
  function destinationView() {
    $("destinationName").textContent=destinationName();
    $("queueCount").textContent=format(library[destination].length)+" 曲";
    $("destinationMenu").replaceChildren();
    for(const p of playlists) {
      const b=document.createElement("button");b.type="button";b.textContent=p.name+"　"+format(library[p.id].length)+" 曲";
      b.setAttribute("aria-pressed",String(p.id===destination));b.onclick=()=>{
        destination=p.id;menu(false);render();$("destinationBtn").focus();
      };$("destinationMenu").append(b);
    }
    $("now").querySelector(".playing-copy span").textContent=playing?"再生中":"一時停止中";
    $("nowPause").textContent=playing?"Ⅱ":"▶";$("nowPause").setAttribute("aria-label",playing?"再生を一時停止":"再生を再開");
  }
  function menu(open) {
    $("destinationMenu").hidden=!open;$("destinationBtn").setAttribute("aria-expanded",String(open));
    if(open)$("destinationMenu").querySelector("button[aria-pressed=true]")?.focus();
  }
  $("destinationBtn").onclick=()=>menu($("destinationMenu").hidden);
  $("nowPause").onclick=()=>{playing=!playing;destinationView();};
  function addMany(ids) {
    const id=destination, list=library[id], before=[...list];
    let inserted=0,removed=false;
    for(const songId of ids) {
      if(!byId.has(songId)||byId.get(songId).missing)continue;
      if(id==="fav"&&list.includes(songId)){
        if(ids.length===1){list.splice(list.indexOf(songId),1);removed=true;}
        continue;
      }
      list.push(songId);inserted++;
    }
    destinationView();
    const subject=ids.length===1?"「"+byId.get(ids[0]).title+"」":inserted+" 曲";
    toast(removed?subject+"をお気に入りから外しました":subject+"を"+destinationName()+"に追加しました",()=>{
      library[id]=before;destinationView();if(id==="fav")rows();
    });
    if(id==="fav")rows();
    return inserted;
  }
  function detail(song) {
    if(!song)return;
    showSleeveDetail(song,()=>{
      const track=document.querySelector('[data-song-id="'+song.id+'"] .track');
      (track||$("filterBtn")).focus();
    },render);
  }
  function rows() {
    const list=window.sleeveTools?.order(filtered)??filtered;
    const shown=list.slice(0,pageSize);
    $("rows").innerHTML=shown.map((s,i)=>{
      const dup=twinCounts.get(JSON.stringify([s.title,s.artist]))>1;
      const sub=[s.artist||"アーティスト未登録"];
      if(dup)sub.push(s.fmt,Math.floor(s.dur/60)+":"+String(s.dur%60).padStart(2,"0"));
      if(s.missing)sub.push("ファイルが見つかりません");
      const identity=s.title+(dup?"、"+sub.join("、"):"");
      const text=s.missing?identity+" は追加できません":identity+(destination==="fav"&&library.fav.includes(s.id)?" をお気に入りから外す":" を "+destinationName()+" に追加");
      return '<li class="row" data-song-id="'+s.id+'"><span class="index" aria-hidden="true">'+String(i+1).padStart(2,"0")+'</span><button type="button" class="track" aria-label="'+escape(s.title+"、"+sub.join("、")+" の詳細")+'"><span class="track-title">'+escape(s.title)+'</span><span class="track-sub">'+escape(sub.join(" · "))+'</span></button><button type="button" class="add" title="'+escape(text)+'" aria-label="'+escape(text)+'" '+(s.missing?"disabled":"")+'>'+(s.missing?"!":"＋")+'</button></li>';
    }).join("");
    $("moreRows").hidden=list.length<=pageSize;
    window.sleeveTools?.rowsRendered();
  }
  $("rows").onclick=e=>{
    const b=e.target.closest("button");if(!b)return;
    const id=Number(b.closest("li").dataset.songId);
    if(b.classList.contains("add"))addMany([id]);else detail(byId.get(id));
  };
  $("moreRows").onclick=()=>{const old=pageSize;pageSize+=60;rows();$("rows").children[old]?.querySelector("button").focus();};
  function render() {
    const matches=run(clauses);
    filtered=sim==="loading"?[]:sim==="error"?savedResults:matches;
    $("count").textContent=sim==="loading"?"検索中…":sim==="error"?"読み込みに失敗":format(filtered.length)+" 曲";
    $("listTitle").textContent=clauses.length?"検索結果":"ライブラリの曲";
    const status=$("status");status.replaceChildren();status.hidden=sim==="ok";
    if(sim==="loading")status.textContent="条件に一致する曲を探しています…";
    if(sim==="error"){
      status.append("検索に失敗しました。直前の結果を表示しています。");
      const b=document.createElement("button");b.type="button";b.textContent="再試行";b.onclick=()=>{sim="ok";render();};status.append(b);
    }
    $("rowsEmpty").hidden=!!filtered.length||sim!=="ok";
    $("rowsEmpty").textContent="一致する曲がありません。条件を編集して範囲を広げられます。";
    editor();rows();destinationView();
  }
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&!$("destinationMenu").hidden){menu(false);$("destinationBtn").focus();}
    if(e.key==="/"&&!e.ctrlKey&&!e.metaKey&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&!document.querySelector("dialog[open]")){
      e.preventDefault();if(editing)$("conditionInput").focus();else $("finderInput").focus();
    }
  });
  document.addEventListener("click",e=>{if(!e.target.closest("#dock")&&!$("destinationMenu").hidden)menu(false);});
  const scenario=new URLSearchParams(location.search).get("s")||"base";
  clauses=scenario==="eight"?many():scenario==="base"?[]:three();
  if(scenario==="a-edit") {clauses.pop();editing=true;$("conditionInput").value="アニソン";}
  if(scenario==="a-browse") {clauses=[clause("year","2015")];editing=true;}
  if(scenario==="zero")clauses.push(clause("custom","2009冬頒布"),clause("custom","サイレン"));
  if(scenario==="loading")sim="loading";
  if(scenario==="error"){savedResults=run(clauses);clauses.push(clause("custom","ネタ曲"));sim="error";}
  const now=songs[3];$("nowTitle").textContent=now.title;$("nowArtist").textContent=now.artist;
  window.FKS={
    getFilteredSongIds:()=>filtered.map(s=>s.id),
    getVisibleSongIds:()=>[...$("rows").children].map(e=>Number(e.dataset.songId)),
    getDestinationId:()=>destination,getCollectionIds:id=>[...(library[id]||[])],
    addMany,showDetail:id=>detail(byId.get(id)),render,
  };
  remember(snap());render();
  if(scenario==="a-detail")detail(songs[5]);
  if(sim==="loading")setTimeout(()=>{if(sim==="loading"){sim="ok";render();}},2200);
})();
