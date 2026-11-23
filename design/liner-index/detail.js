(() => {
  const { songs, playlists } = FK;
  const { S, lists, displayed, nowPlaying } = FKP;
  const byId = new Map(songs.map(song => [song.id, song]));
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const duration = song => Math.floor(song.dur / 60) + ":" + String(song.dur % 60).padStart(2, "0");
  const path = song => song.folder + "/" + song.title + "." + song.fmt.toLowerCase();
  const dialog = document.createElement("dialog");
  dialog.className = "record-card";
  dialog.setAttribute("aria-labelledby", "record-title");
  document.body.append(dialog);
  let current, originId, expanded = new Set(), scrollTop = 0, savedNote = "";
  const mainRow = id => document.querySelector(`.row[data-id="${id}"] .row-main`);
  function focusRow(id) {
    const row = mainRow(id) || document.querySelector(".row-main");
    if (row) row.focus({preventScroll:true}); else window.indexSearch?.focus();
  }
  function section(key, label, body) {
    return `<details class="record-fold" data-key="${key}" ${expanded.has(key) ? "open" : ""}><summary>${label}</summary><div>${body}</div></details>`;
  }
  function draw() {
    const s = current;
    const twins = songs.filter(x => x.title === s.title && x.artist === s.artist);
    const dest = playlists.find(d => d.id === S.dest);
    const inDest = lists[S.dest].some(x => x.id === s.id);
    const tags = [...s.genres, ...s.tags];
    const info = indexEditor.info(s);
    const lead = s.title.match(/^(.*)\s+(\([^()]+\))$/);
    const artist = s.artist || "アーティスト情報なし";
    const year = s.year ? s.year + "年" : s.yearStatus==="pending" ? "確認中" : "未設定";
    const tagLine = (kind, values) => `<dt>${kind}</dt><dd>${values.length ? values.map(value => `<button class="record-key" data-key-kind="${kind === "ジャンル" ? "genre" : "custom"}" data-value="${esc(value)}" aria-label="${esc(kind+" "+value+" で絞り込む")}">${esc(value)}</button>`).join(" ") : "なし"}</dd>`;
    const destinations = playlists.filter(d => lists[d.id].some(x => x.id === s.id)).map(d => d.name);
    const versions = twins.length > 1 ? section("versions", `同名のファイル <small>${twins.length}件</small>`, twins.map(t =>
      `<button class="record-version" data-version="${t.id}" ${t.id === s.id ? "disabled" : ""}><b>${esc(t.fmt)}　${duration(t)}</b><span>${esc(t.folder)}</span><small>${t.id === s.id ? "表示中" : "詳細を見る"}</small></button>`).join("")) : "";
    dialog.innerHTML = `<header class="record-bar"><span>曲の詳細</span><button data-do="back" autofocus>一覧へ戻る <span aria-hidden="true">↗</span></button></header>
      <div class="record-scroll"><article class="record-face"><div class="record-credit">${esc(artist)}</div><h2 id="record-title">${esc(lead ? lead[1] : s.title)}${lead ? ` <span>${esc(lead[2])}</span>` : ""}</h2>
      <div class="record-spec"><div><small>再生時間</small><b>${duration(s)}</b></div><div><small>形式</small><b>${esc(s.fmt)}</b></div><div><small>制作年</small><b>${year}</b></div></div>
      <p class="record-state">${s.missing ? "ファイルが見つかりません" : s.id === nowPlaying.id ? "● 再生中" : "現在再生していません"}　／　${esc(dest.name)}に${inDest ? "登録済み" : "未追加"}</p></article>
      <section class="record-notes"><div class="record-tag-head"><h3>タグ <small>${tags.length}</small></h3><button data-do="edit" ${info.editable?"":"disabled"}>${info.editable?"タグを編集":"ファイルの識別を確認中"}</button></div>
      ${savedNote ? `<p class="record-receipt" role="status">${esc(savedNote)}</p>` : ""}<p class="record-tags">${tags.slice(0,4).map(esc).join("　·　") || "タグなし"}</p>
      ${section("tags", tags.length > 4 ? `すべてのタグ・分類を見る（${tags.length}件）` : "分類を見る", `<dl>${tagLine("ジャンル",s.genres)}${tagLine("カスタムタグ",s.tags)}</dl>`)}
      ${versions}
      ${section("file","ファイルとメタデータ",`<dl><dt>ファイル</dt><dd>${esc(path(s))}</dd><dt>曲名情報</dt><dd>${s.untitled ? "埋め込み曲名なし。ファイル名を表示" : esc(s.title)}</dd><dt>再生回数</dt><dd>${s.plays}回</dd><dt>登録先</dt><dd>${destinations.map(esc).join("、") || "なし"}</dd>${metadata(info)}</dl>`)}
      ${section("actions","追加先の操作",`<div class="record-actions"><button data-do="add" ${s.missing ? "disabled" : ""}>${esc(dest.name)}に${dest.kind==="fav" && inDest ? "登録解除" : "追加"}</button><button data-do="fav" ${s.missing ? "disabled" : ""}>${lists.fav.some(x=>x.id===s.id) ? "お気に入りから外す" : "お気に入りに登録"}</button><button data-do="dock">ほかの追加先へ</button></div>`)}
      </section></div>`;
  }
  function metadata(info) {
    const year = info.year || {};
    const names = {embedded:"埋め込み",manual:"手動",both:"埋め込み・手動",none:"なし",valid:"有効",invalid:"無効な値",future:"未来年",conflict:"同順位の値が競合",missing:"候補なし",suppressed:"手動で未設定"};
    const describe = text => names[text] || text || "情報なし";
    const candidates = (year.candidates || []).map(c => esc(c.source+" · "+c.value+"（"+describe(c.status)+(Number.isInteger(c.rank)?"、優先順位 "+(c.rank+1):"")+"）")).join("<br>");
    const sources = (info.tags || []).reduce((totals,t) => { totals[t.origin] = (totals[t.origin] || 0) + 1; return totals; },{});
    return `<dt>制作年の由来</dt><dd>${esc(describe(year.origin))}（${esc(describe(year.status))}）</dd>
      <dt>候補値</dt><dd>${candidates || "なし"}</dd><dt>タグの由来</dt><dd>${Object.entries(sources).map(([k,n]) => esc(describe(k))+" "+n+"件").join("、") || "なし"}</dd>`;
  }
  function open(id) {
    const song = byId.get(id);
    if (!song) return;
    originId = id; current = song; savedNote = ""; expanded = new Set();
    scrollTop = document.querySelector("#results").scrollTop;
    draw(); dialog.showModal();
  }
  dialog.addEventListener("toggle",event => {
    const key = event.target.dataset.key;
    if (key) event.target.open ? expanded.add(key) : expanded.delete(key);
  },true);
  dialog.addEventListener("close",() => {
    document.querySelector("#results").scrollTop = scrollTop;
    focusRow(originId);
  });
  dialog.addEventListener("click",event => {
    const b = event.target.closest("button"); if (!b) return;
    if (b.dataset.keyKind) {
      const {keyKind:kind, value} = b.dataset;
      if (!S.clauses.some(c=>c.kind===kind && c.on && !c.not && c.values.length===1 && c.values[0]===value)) {
        S.clauses.push(FKP.newClause(kind,value)); FKP.update(); FKP.remember();
      }
      dialog.close(); return;
    }
    if (b.dataset.version) {
      current = byId.get(Number(b.dataset.version)); draw(); dialog.querySelector("[data-do=back]").focus();
      return;
    }
    switch (b.dataset.do) {
      case "back": dialog.close(); break;
      case "edit": {
        const top = dialog.querySelector(".record-scroll").scrollTop;
        indexEditor.open([current], outcome => {
          savedNote = receipt(outcome);
          FKP.update(); draw(); dialog.querySelector(".record-scroll").scrollTop = top;
          dialog.querySelector("[data-do=edit]").focus({preventScroll:true});
        }); break;
      }
      case "add": case "fav":
        FKP.addTo(b.dataset.do === "fav" ? "fav" : S.dest,[current.id],null); draw();
        dialog.querySelector(`[data-do="${b.dataset.do}"]`).focus(); break;
      case "dock": dialog.close(); S.dockOpen = true; FKP.render(); requestAnimationFrame(()=>document.querySelector("#dock button")?.focus()); break;
    }
  });
  function receipt(outcome) {
    if(outcome.reason==="identity_unavailable") return "選択に識別を確認中の曲が含まれます。対象を確認してください";
    if (outcome.reason === "saved") return "タグ情報を保存しました";
    if (outcome.reason === "no_op") return "変更はありませんでした";
    return "";
  }
  function bulk() {
    const targets = displayed().filter(song => S.selected.has(song.id));
    if (!targets.length) return;
    indexEditor.open(targets, outcome => {
      if (receipt(outcome)) FKP.toast(receipt(outcome));
      FKP.update();
      const opener = document.querySelector("[data-act=edit-selected]:enabled, [data-act=sel-end]");
      opener?.focus();
    });
  }
  window.indexDetail = { open, bulk };
  if (S.open != null) open(S.open);
  document.querySelector("#examples").addEventListener("change",e=>{
    const choice=e.target.value;
    e.target.value="";
    if (choice==="bulk") {
      FKP.scenario("base");
      S.selectMode=true;
      S.selected=new Set([3,79]);
      FKP.update(); bulk();
    } else {
      const example = {many:24821,conflict:92,invalid:90,future:91}[choice];
      if (example != null) open(example);
    }
  });
})();
