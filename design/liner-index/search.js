// Liner Index search. It owns #query and #lens; app.js remains the library renderer.
(function () {
  const api = () => window.FKP || {};
  const state = () => api().S;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const label = { year: "制作年", "year-unset": "制作年 未設定", genre: "ジャンル", custom: "タグ", artist: "アーティスト", text: "文字" };
  const kindClass = { year: "year", "year-unset": "year", genre: "genre", custom: "custom", artist: "artist", text: "text" };
  let panel = false;
  let advanced = false;
  let separateYears = false;
  let selected = 0;
  let composing = false;
  const undo = [];
  let query;
  let lens;

  function allSongs() { return window.FK ? window.FK.songs : []; }
  function fold(value) { return api().fold ? api().fold(value) : String(value).normalize("NFKC").toLocaleLowerCase(); }
  function matches(clause, song) { return api().clauseMatch ? api().clauseMatch(clause, song) : false; }
  function active() { return state().clauses.filter((clause) => clause.on); }
  let joinValues = false;
  function projection(kind,value) {
    const S=state();
    const next=S.clauses.map(c=>({...c,values:[...c.values]}));
    const focus=next.find(c=>c.id===S.focusClause);
    const separate=separateYears && kind==="year";
    if (focus && !separate && focus.kind===kind) {
      focus.values=joinValues ? [...new Set([...focus.values,value])] : [value];
    } else {
      const years=kind==="year" && !separate && next.find(c=>c.kind==="year" && c.on && !c.not);
      if(years) years.values=[...new Set([...years.values,value])];
      else next.push({id:null,kind,values:[value],on:true,not:false});
    }
    return next;
  }
  function predicted(kind,value) {return api().filter(projection(kind,value),state().mode).length;}
  function fmt(number) { return Number(number).toLocaleString("ja-JP"); }
  function clauseText(clause) {
    return clause.values.map((value) => clause.kind === "year" ? `${value}年` : clause.kind==="year-unset" ? "制作年 未設定" : value).join(" または ");
  }
  function snapshot() { return JSON.parse(JSON.stringify({ clauses: state().clauses, mode: state().mode })); }
  function commit(previous) {
    state().input = "";
    state().focusClause = null;
    selected = 0;
    if (previous) undo.unshift(previous);
    api().update();
    api().remember();

  }
  function add(kind, value) {
    const S = state();
    const previous = snapshot();
    S.clauses=projection(kind,value).map(c=>c.id==null ? api().newClause(c.kind,c.values) : c);
    joinValues=false; separateYears=false; advanced=false;
    commit(previous);
  }
  function remove(id) {
    const S = state();
    const previous = snapshot();
    S.clauses = S.clauses.filter((clause) => clause.id !== id);
    if (S.focusClause === id) S.focusClause = null;
    commit(previous);
  }
  function restore(recent) {
    const S = state();
    const previous = snapshot();
    S.clauses = JSON.parse(JSON.stringify(recent.snap.clauses));
    S.mode = recent.snap.mode;
    commit(previous);
  }
  function suggestions() {
    const S = state();
    const raw = S.input.trim();
    if (!raw) return [];
    const q = fold(raw);
    const focus = S.clauses.find((clause) => clause.id === S.focusClause);
    const candidates = [];
    for (const tag of window.FK.tagIndex.values()) {
      if (focus && focus.kind !== tag.kind) continue;
      if (focus && joinValues && focus.values.includes(tag.value)) continue;
      const value = fold(tag.value);
      const at = value.indexOf(q);
      if (at < 0) continue;
      candidates.push({ kind: tag.kind, value: tag.value, total: tag.count, folded: value, score: (at === 0 ? 4 : 0) + (value === q ? 8 : 0) });
    }
    candidates.sort((a, b) => b.score - a.score || b.total - a.total || a.value.localeCompare(b.value, "ja"));
    const text = { kind: "text", value: raw, total: predicted("text", raw), score: 2 };
    const artists = new Map();
    allSongs().forEach((song) => {
      if (song.artist && fold(song.artist).includes(q)) artists.set(song.artist, (artists.get(song.artist) || 0) + 1);
    });
    const artistItems = [...artists].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value, total]) => ({ kind: "artist", value, total, score: 3 }));
    const exactTags = candidates.filter((candidate) => candidate.score >= 8);
    const items = text.total || !exactTags.length ? [text, ...artistItems, ...candidates.slice(0, 8)] : [...exactTags.slice(0, 3), text, ...artistItems, ...candidates.slice(0, 5).filter((candidate) => !exactTags.includes(candidate))];
    const identities = new Map();
    candidates.forEach((candidate) => identities.set(`${candidate.kind}\u0000${candidate.folded}`, (identities.get(`${candidate.kind}\u0000${candidate.folded}`) || 0) + 1));
    return items.filter(item=>!focus || item.kind===focus.kind).map((item) => Object.assign(item, { count: item.kind === "text" ? item.total : predicted(item.kind, item.value), variants: identities.get(`${item.kind}\u0000${item.folded}`) || 1 }));
  }
  function terms() {
    const S = state();
    if (!S.clauses.length) return "";
    return `<div class="index-terms" aria-label="検索条件">${S.clauses.map((clause, index) => `
      ${index ? `<span class="index-join">${clause.kind==="year-unset" || S.mode === "all" ? "かつ" : "または"}</span>` : ""}
      <span class="index-term ${clause.on ? "" : "is-paused"}" data-kind="${kindClass[clause.kind]}">
        <button type="button" class="index-term-main" data-action="edit" data-id="${clause.id}" aria-label="${esc(label[clause.kind])} ${esc(clauseText(clause))} を編集">${clause.not ? "除外 " : ""}${esc(clauseText(clause))}${clause.on ? "" : "（休止）"}</button>
        <button type="button" class="index-term-remove" data-action="remove" data-id="${clause.id}" aria-label="${esc(clauseText(clause))} を外す">×</button>
      </span>`).join("")}</div>`;
  }
  function suggestionMarkup(items) {
    const S = state();
    if (!S.input.trim()) return "";
    if (!items.length) return `<p class="index-empty">一致する条件はありません。文字検索として追加できます。</p>`;
    return `<div class="index-suggestions" role="listbox" aria-label="候補" id="indexSuggestions">${items.map((item, index) => `
      <button class="index-suggestion" id="indexSuggestion-${index}" type="button" role="option" aria-selected="${index === selected}" data-action="pick" data-index="${index}">
        <span class="index-kind index-kind-${kindClass[item.kind]}">${label[item.kind]}</span>
        <span class="index-value">${esc(item.kind === "text" ? `「${item.value}」を文字検索` : item.value)}${item.variants > 1 ? `<small>類似表記 ${item.variants}</small>` : ""}</span>
        <span class="index-count">${fmt(item.count)}曲</span>
      </button>`).join("")}</div>`;
  }
  function browse() {
    const S = state();
    const focus = S.clauses.find((clause) => clause.id === S.focusClause);
    const filters = active();
    const base = api().filter ? api().filter(filters, S.mode) : allSongs();
    const perKind = { year: new Map(), genre: new Map(), custom: new Map() };
    base.forEach((song) => {
      if (song.year) perKind.year.set(String(song.year), (perKind.year.get(String(song.year)) || 0) + 1);
      song.genres.forEach((value) => perKind.genre.set(value, (perKind.genre.get(value) || 0) + 1));
      song.tags.forEach((value) => perKind.custom.set(value, (perKind.custom.get(value) || 0) + 1));
    });
    const group = (kind, title, limit) => {
      const list = [...perKind[kind]].sort((a, b) => b[1] - a[1]).slice(0, limit);
      return `<section class="index-browse-group"><h3>${title}</h3><div>${list.map(([value, count]) => `<button type="button" data-action="add" data-kind="${kind}" data-value="${esc(value)}"><span>${esc(kind === "year" ? `${value}年` : value)}</span><small>${fmt(predicted(kind,value))}</small></button>`).join("")}</div></section>`;
    };
    const unset = predicted("year-unset","unset");
    const only = focus?.kind;
    const unsetButton = `<button class="index-unset" type="button" data-action="add" data-kind="year-unset" data-value="unset">制作年 未設定 <small>${fmt(unset)}</small></button>`;
    return `${(!only || only === "year") ? group("year", "制作年", focus ? 6 : 2) + unsetButton : ""}${(!only || only === "genre") ? group("genre", "ジャンル", focus ? 6 : 2) : ""}${(!only || only === "custom") ? group("custom", "タグ", focus ? 6 : 2) : ""}`;
  }
  function advancedMarkup() {
    const S = state();
    if (!advanced && !S.clauses.length) return "";
    if (!advanced) return `<button type="button" class="index-advanced-open" data-action="advanced">条件の合わせ方を調整</button>`;
    const focused = S.clauses.find((clause) => clause.id === S.focusClause);
    return `<div class="index-advanced" aria-label="検索条件の詳細">
      <div class="index-advanced-mode"><span>一致する曲</span><button type="button" data-action="mode" aria-pressed="${S.mode === "any"}">${S.mode === "all" ? "すべての条件" : "どれかの条件"}</button></div>
      <div class="index-clause-list" role="group" aria-label="すべての検索条件">${S.clauses.map((clause, index) => `<button type="button"  class="${focused === clause ? "is-selected" : ""}${clause.on ? "" : " is-paused"}" data-action="edit" data-id="${clause.id}"><small>${index ? (S.mode === "all" ? "かつ" : "または") : "条件"} · ${label[clause.kind]}</small><span>${esc(clauseText(clause))}</span><em>${clause.not ? "除外" : clause.on ? "含める" : "一時停止"}</em></button>`).join("")}</div>
      ${focused ? `<div class="index-clause-controls"><strong>${label[focused.kind]}: ${esc(clauseText(focused))}</strong><span><button type="button" data-action="negate" data-id="${focused.id}" aria-pressed="${focused.not}">${focused.not ? "含める" : "除外する"}</button><button type="button" data-action="pause" data-id="${focused.id}" aria-pressed="${!focused.on}">${focused.on ? "一時停止" : "再開"}</button>${focused.kind === "year" ? `<button type="button" data-action="separate-year" aria-pressed="${separateYears}">年を別条件として追加</button>` : ""}</span></div>` : `<p>条件を選ぶと、除外や一時停止もここで行えます。</p>`}
    </div>`;
  }
  function relaxation(total) {
    const S = state();
    if (total || S.input || !S.clauses.length || advanced) return "";
    const choices=api().relaxations();
    return `<section class="index-relaxation"><strong>条件をゆるめる</strong>${choices.map(({cs,n})=>`<button type="button" data-action="relax" data-ids="${cs.map(c=>c.id).join(",")}">${cs.map(c=>esc(clauseText(c))).join(" と ")} を外す <small>${fmt(n)}曲</small></button>`).join("") || '<button data-act="clear-all">条件をすべて外す</button>'}</section>`;
  }
  function history() {
    const recent = state().recent || [];
    if (!recent.length) return "";
    return `<section class="index-history"><h3>最近の検索</h3>${recent.map((entry, index) => `<button type="button" data-action="history" data-index="${index}"><span>${esc(entry.snap.clauses.map(clauseText).join(" · "))}</span><small>${fmt(entry.n)}曲</small></button>`).join("")}</section>`;
  }
  function render() {
    if (!query || !lens || !window.FK || !state()) return;
    const S = state();
    const items = suggestions();
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    const total = api().results ? api().results().length : (api().filter ? api().filter(active(), S.mode).length : allSongs().length);
    if(!query.querySelector("input")) query.innerHTML = `<div class="index-search-line"><label class="index-search-field"><span class="index-search-icon" aria-hidden="true">⌕</span><input id="indexSearchInput" type="search" role="combobox" autocomplete="off" spellcheck="false" placeholder="曲名、アーティスト、タグ、制作年" aria-label="ライブラリを検索" aria-autocomplete="list"><kbd aria-hidden="true">/</kbd></label></div><div class="index-summary"></div>`;
    const field=$("#indexSearchInput");
    if(field.value!==S.input && !composing) field.value=S.input;
    const choosing=panel && items.length>0;
    field.setAttribute("aria-expanded",String(choosing));
    if(choosing){field.setAttribute("aria-controls","indexSuggestions");field.setAttribute("aria-activedescendant","indexSuggestion-"+selected);}
    else {field.removeAttribute("aria-controls");field.removeAttribute("aria-activedescendant");}
    $(".index-summary",query).innerHTML=terms();
    query.querySelector(":scope > [role=alert],:scope > [role=status]")?.remove();
    if(S.sim!=="ok") query.insertAdjacentHTML("beforeend",S.sim==="error" ? '<div role="alert">検索を更新できませんでした。前回の結果を表示しています。 <button data-act="retry">再試行</button></div>' : '<div role="status">検索中…</div>');
    lens.hidden = !panel;
    lens.style.top = `${query.offsetHeight}px`;
    const focus = S.clauses.find(c=>c.id===S.focusClause);
    const editOptions = focus && focus.kind!=="year-unset" ? `<div class="index-edit-options"><strong>${esc(clauseText(focus))}</strong><span>${joinValues?"候補を選ぶと、どちらかに一致":"候補を選ぶと、この条件を置き換え"}</span>${focus.kind!=="text" ? `<button data-action="join" aria-pressed="${joinValues}">${joinValues?"置き換えに戻す":"または、で候補を足す"}</button>`:""}${focus.values.length>1 ? focus.values.map((v,i)=>`<button data-action="remove-value" data-at="${i}">${esc(v)} を外す</button>`).join(""):""}</div>` : "";
    const body = advanced ? `${advancedMarkup()}${!S.focusClause ? `<button class="index-unset" data-action="add" data-kind="year-unset" data-value="unset">制作年が未設定の曲に限定</button>` : ""}${S.focusClause ? (suggestionMarkup(items) || `<div class="index-browse">${browse()}</div>`) : ""}` : `${suggestionMarkup(items) || `<div class="index-browse">${browse()}</div>`}${relaxation(total)}${history()}${undo.length ? `<button class="index-undo" type="button" data-action="undo">直前の変更を元に戻す</button>` : ""}${advancedMarkup()}`;
    lens.innerHTML = panel ? `<div class="index-panel"><div class="index-panel-intro"><span>${S.focusClause ? `${label[S.clauses.find((clause) => clause.id === S.focusClause)?.kind]}を追加・変更` : "条件を追加"} <small>${fmt(total)}曲</small></span><button type="button" data-action="close" aria-label="条件入力を閉じる">閉じる</button></div>${editOptions}${body}</div>` : "";
    bind();
  }
  function focusInput() {
    panel = true;
    render();
    requestAnimationFrame(() => $("#indexSearchInput")?.focus());
  }
  function bind() {
    const input = $("#indexSearchInput");
    if (input && !input.dataset.bound) { input.dataset.bound="true";
      input.addEventListener("compositionstart", () => { composing = true; });
      input.addEventListener("compositionend", (event) => { composing = false; state().input = event.target.value; selected = 0; panel = true; render(); focusInput(); });
      input.addEventListener("input", (event) => { state().input = event.target.value; selected = 0; panel = true; if (composing || event.isComposing) return; render(); focusInput(); });
      input.addEventListener("focus", () => { if (!panel) { panel = true; render(); focusInput(); } });
      input.addEventListener("keydown", onKeydown);
    }
    lens.onclick = onClick;
    query.onclick = onClick;
  }
  function onKeydown(event) {
    if (composing || event.isComposing || event.keyCode===229) return;
    const items = suggestions();
    if (event.key === "ArrowDown" && items.length) { event.preventDefault(); selected = Math.min(items.length - 1, selected + 1); render(); focusInput(); }
    else if (event.key === "ArrowUp" && items.length) { event.preventDefault(); selected = Math.max(0, selected - 1); render(); focusInput(); }
    else if (event.key === "Enter" && items[selected]) { event.preventDefault(); add(items[selected].kind, items[selected].value); focusInput(); }
    else if (event.key === "Enter" && state().input.trim()) { event.preventDefault(); add("text", state().input.trim()); focusInput(); }
    else if (event.key === "Backspace" && !state().input && state().clauses.length) { event.preventDefault(); remove(state().clauses.at(-1).id); focusInput(); }
    else if (event.key === "Escape") { event.preventDefault(); if (panel) { panel = false; advanced=false; state().focusClause=null; state().input = ""; render(); } else event.target.blur(); }
  }
  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const S = state();
    const action = target.dataset.action;
    if(action==="join"){joinValues=!joinValues;render();focusInput();}
    if(action==="remove-value"){const c=S.clauses.find(c=>c.id===S.focusClause);if(c){const old=snapshot();c.values.splice(Number(target.dataset.at),1);commit(old);focusInput();}}
    if (action === "pick") { const item = suggestions()[Number(target.dataset.index)]; if (item) add(item.kind, item.value); focusInput(); }
    if (action === "add") { add(target.dataset.kind, target.dataset.value); focusInput(); }
    if (action === "remove") { remove(Number(target.dataset.id)); focusInput(); }
    if (action === "edit") { separateYears=false;joinValues=false;S.focusClause = Number(target.dataset.id); panel = true; render(); focusInput(); }
    if (action === "history") { restore(S.recent[Number(target.dataset.index)]); panel = false; render(); query.focus(); }
    if (action === "advanced") { advanced = true; render(); requestAnimationFrame(() => $(".index-clause-list button, .index-advanced-mode button")?.focus()); }
    if (action === "mode") { const previous = snapshot(); S.mode = S.mode === "all" ? "any" : "all"; commit(previous); render(); requestAnimationFrame(() => $("[data-action=mode]")?.focus()); }
    if (action === "negate") { const previous = snapshot(); const clause = S.clauses.find((item) => item.id === Number(target.dataset.id)); if (clause) { clause.not = !clause.not; commit(previous); S.focusClause=clause.id; render(); requestAnimationFrame(() => $(`[data-action=negate][data-id='${target.dataset.id}']`)?.focus()); } }
    if (action === "pause") { const previous = snapshot(); const clause = S.clauses.find((item) => item.id === Number(target.dataset.id)); if (clause) { clause.on = !clause.on; commit(previous); S.focusClause=clause.id; render(); requestAnimationFrame(() => $(`[data-action=pause][data-id='${target.dataset.id}']`)?.focus()); } }
    if (action === "separate-year") { separateYears = !separateYears; render(); requestAnimationFrame(() => $("[data-action=separate-year]")?.focus()); }
    if (action === "undo") { const previous = undo.shift(); if (previous) { S.clauses = previous.clauses; S.mode = previous.mode; commit(); render(); } }
    if (action === "relax") { const previous=snapshot(), ids=target.dataset.ids.split(",").map(Number); S.clauses=S.clauses.filter(c=>!ids.includes(c.id));commit(previous);focusInput(); }
    if (action === "close") { panel = false; advanced=false; S.focusClause=null; S.input = ""; render(); query.focus(); }
  }
  function replaceNodes() {
    const oldQuery = $("#query");
    const oldLens = $("#lens");
    if (!oldQuery || !oldLens) return false;
    query = document.createElement("div"); query.id = "query"; query.className = "index-query"; query.tabIndex = -1;
    lens = document.createElement("section"); lens.id = "lens"; lens.className = "index-lens"; lens.setAttribute("aria-label", "検索条件"); lens.hidden = true;
    oldQuery.replaceWith(query); oldLens.replaceWith(lens);
    return true;
  }
  function install() {
    if (!replaceNodes()) return;
    document.addEventListener("click", (event) => {
      if (panel && event.target.closest("#results .row")) { panel = false; state().input = ""; render(); }
    });
    document.addEventListener("keydown", (event) => {
      const modal = document.querySelector("dialog[open], .sheet:not([hidden]), [role=dialog]:not([hidden])");
      if (event.key === "/" && !modal && !event.target.matches("input, textarea, [contenteditable=true]") && !event.target.closest(".detail, .menu, .dock")) { event.preventDefault(); focusInput(); }
    });
    window.indexSearch = { refresh: render, focus: focusInput };
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();
