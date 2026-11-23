// Overprint — interaction prototype. Mock data only; nothing is saved.
(function () {
  const { songs, playlists } = window.FK;
  const $ = (s, r = document) => r.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => n.toLocaleString("ja-JP");
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const INK = { blue: "var(--blue)", teal: "var(--teal)", orange: "var(--orange)", violet: "var(--violet)", pink: "var(--pink-text)" };

  const ICON = {
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6L21 7.4 19.6 6z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13z"/></svg>',
    heartO: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13zm0-2.8 6-5.9a2.8 2.8 0 0 0-4.6-3.3L12 9.8l-1.4-1.5a2.8 2.8 0 0 0-4.6 3.3z"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m7 9.5 5 5 5-5 1.4 1.4-6.4 6.4-6.4-6.4z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m10 5.6 1.4 1.4-4 4H20v2H7.4l4 4L10 18.4 3.6 12z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
    not: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm-5.3 5.1A7 7 0 0 0 15.9 17.3zM8.1 6.7l9.2 9.2A7 7 0 0 0 8.1 6.7z"/></svg>',
    select: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm2 2v3h3V6zm7 0h8v2h-8zm0 9h8v2h-8zM4 13h7v7H4zm1.6 3.4 1.4-1.4 1 1 2.4-2.4 1.4 1.4-3.8 3.8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M6 5.5 15 12l-9 6.5zM16 5h2v14h-2z"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 4h9l9 9-8 8-9-9V4zm4 2.5A1.5 1.5 0 1 0 7 9.5a1.5 1.5 0 0 0 0-3z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm13-2v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>',
  };

  // ---------------------------------------------------------------- state
  let uid = 1;
  const S = {
    clauses: [], mode: "all", input: "", lens: false, focusClause: null, sugIndex: 0,
    dest: "queue", sim: "ok", sort: "added", limit: 60,
    selectMode: false, selected: new Set(), open: null, active: null,
    recent: [], undo: null, dockOpen: false, editTags: null,
  };
  const L = {
    queue: [], fri: [], work: [], anison: [], fav: [],
  };
  const pickIds = (n, off) => Array.from({ length: n }, (_, i) => songs[(off + i * 131) % songs.length].id);
  pickIds(4, 40).forEach((id) => L.queue.push({ id, auto: false }));
  pickIds(3, 900).forEach((id) => L.queue.push({ id, auto: true }));
  pickIds(23, 1200).forEach((id) => L.fri.push({ id }));
  pickIds(61, 5000).forEach((id) => L.work.push({ id }));
  pickIds(11, 7000).forEach((id) => L.anison.push({ id }));
  pickIds(140, 3000).forEach((id) => L.fav.push({ id }));
  const byId = new Map(songs.map((s) => [s.id, s]));
  const nowPlaying = byId.get(songs[3].id);
  const twinKey = (s) => s.title + "\u0000" + s.artist;
  const twinCount = new Map();
  songs.forEach((s) => twinCount.set(twinKey(s), (twinCount.get(twinKey(s)) || 0) + 1));


  // ---------------------------------------------------------------- matching
  const fold = (s) => String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/りみっくす/g, "remix").replace(/anison[g]?/g, "あにそん").replace(/nihonjin/g, "日本人")
    .replace(/[\s・:：\-_/()（）]/g, "");
  const clauseMatch = (c, s) => {
    let hit;
    switch (c.kind) {
      case "year-unset": hit = s.year == null && (s.yearStatus !== "pending" || s.yearMode === "unset"); break;
      case "year": hit = c.values.includes(String(s.year)); break;
      case "genre": hit = c.values.some((v) => s.genres.includes(v)); break;
      case "custom": hit = c.values.some((v) => s.tags.includes(v)); break;
      case "artist": hit = c.values.includes(s.artist); break;
      case "text": { const q = fold(c.values[0]); hit = fold(s.title).includes(q) || fold(s.artist).includes(q); break; }
    }
    return c.not ? !hit : hit;
  };
  const activeClauses = () => S.clauses.filter(c => c.on);
  function filter(clauses, mode = S.mode) {
    const enabled = clauses.filter(c => c.on !== false);
    if (!enabled.length) return songs;
    const guards = enabled.filter(c => c.kind === "year-unset");
    const terms = enabled.filter(c => c.kind !== "year-unset");
    return songs.filter(song => guards.every(c => clauseMatch(c, song)) &&
      (!terms.length || (mode === "all" ? terms.every(c => clauseMatch(c, song)) : terms.some(c => clauseMatch(c, song)))));
  }
  const SORTS = {
    added: ["新しく追加した順", (a, b) => b.added - a.added],
    title: ["曲名順", (a, b) => a.title.localeCompare(b.title, "ja")],
    artist: ["アーティスト順", (a, b) => a.artist.localeCompare(b.artist, "ja")],
    year: ["制作年が新しい順", (a, b) => (b.year || 0) - (a.year || 0)],
    plays: ["よく聴いた順", (a, b) => b.plays - a.plays],
  };
  let result = songs, lastGood = songs;
  function compute() {
    result = filter(activeClauses()).slice().sort(SORTS[S.sort][1]);
    if (S.sim === "ok") lastGood = result;
  }

  // ---------------------------------------------------------------- mutations
  const snapshot = () => JSON.parse(JSON.stringify({ clauses: S.clauses, mode: S.mode }));
  function remember() {
    if (!S.clauses.length) return;
    const key = JSON.stringify([S.mode, S.clauses.map((c) => [c.kind, c.values, c.not, c.on])]);
    S.recent = S.recent.filter((r) => r.key !== key);
    S.recent.unshift({ key, snap: snapshot(), n: result.length });
    S.recent = S.recent.slice(0, 4);
  }
  const clauseText = (c) => c.values.map((v) => (c.kind === "year" ? v + "年" : v)).join(" または ");

  function addTo(destId, ids, from) {
    const d = playlists.find((p) => p.id === destId);
    const list = L[destId];
    ids = ids.filter((id) => !byId.get(id).missing);
    if (!ids.length) return;
    if (d.kind === "fav") {
      const has = new Set(list.map((x) => x.id));
      const fresh = ids.filter((id) => !has.has(id));
      const removed = ids.length === 1 && has.has(ids[0]);
      if (removed) {
        const at = list.findIndex((x) => x.id === ids[0]); const [it] = list.splice(at, 1);
        render(); toast(`「${byId.get(ids[0]).title}」をお気に入りから外しました`, "元に戻す", () => { list.splice(at, 0, it); render(); });
        return;
      }
      fresh.forEach((id) => list.push({ id, fresh: true }));
      fly(from); render();
      toast(fresh.length === 1 ? `「${byId.get(fresh[0]).title}」をお気に入りに登録しました` : `${fresh.length}曲をお気に入りに登録しました${ids.length - fresh.length ? `（${ids.length - fresh.length}曲は登録済み）` : ""}`,
        "元に戻す", () => { fresh.forEach((id) => { const k = list.findIndex((x) => x.id === id); if (k >= 0) list.splice(k, 1); }); render(); });
      return;
    }
    list.forEach((x) => (x.fresh = false));
    let at = list.length;
    if (destId === "queue") { at = list.findIndex((x) => x.auto); if (at < 0) at = list.length; }
    const items = ids.map((id) => ({ id, auto: false, fresh: true }));
    list.splice(at, 0, ...items);
    const pos = at + 1;
    S.lastAdded = ids.length === 1 ? { id: ids[0], dest: destId, pos } : null;
    fly(from); render();
    toast(ids.length === 1 ? `「${byId.get(ids[0]).title}」を${d.name}の${pos}番目に追加しました` : `${ids.length}曲を${d.name}の${pos}番目から追加しました`,
      "取り消す", () => { list.splice(at, items.length); S.lastAdded = null; render(); });
  }

  // ---------------------------------------------------------------- render: rows
  function splitTitle(t) {
    const m = t.match(/^(.*?)(\s*[\(（〜~].*)$/);
    return m && m[1] ? [m[1], m[2]] : [t, ""];
  }
  function rowHTML(s) {
    const d = playlists.find((p) => p.id === S.dest);
    const inDest = L[S.dest].filter((x) => x.id === s.id).length;
    const isFav = d.kind === "fav";
    const playing = s.id === nowPlaying.id;
    const [main, mix] = splitTitle(s.title);
    const terms = new Set(activeClauses().filter((c) => !c.not).flatMap((c) => c.values));
    // With "すべて" every row matches every condition, so repeating the
    // matched tags on each row says nothing. With "どれか" it tells rows apart.
    const hits = S.mode === "any" ? [String(s.year), ...s.genres, ...s.tags].filter((t) => terms.has(t)) : [];
    const twins = twinCount.get(twinKey(s)) || 1;
    const open = false;
    const justAdded = S.lastAdded && S.lastAdded.id === s.id && S.lastAdded.dest === S.dest;
    let state = "";
    if (s.missing) state = '<span class="st bad">ファイルなし</span>';
    else if (justAdded && !isFav) state = `<span class="st in">✓ ${esc(d.name)}の${S.lastAdded.pos}番目</span>`;
    else if (inDest) state = `<span class="st in">${isFav ? "♥ 登録済み" : `✓ ${esc(d.name)}にあり`}</span>`;
    const title = s.untitled ? `<span class="row-title is-untitled">${esc(s.title)}.${s.fmt.toLowerCase()}</span>` : `<span class="row-title">${esc(main)}${mix ? `<span class="mix">${esc(mix)}</span>` : ""}</span>`;
    const addLabel = s.missing ? `「${s.title}」はファイルが見つからないため追加できません` : isFav ? (inDest ? `「${s.title}」をお気に入りから外す` : `「${s.title}」をお気に入りに登録`) : `「${s.title}」を${d.name}に追加`;
    const addIcon = isFav ? (inDest ? ICON.heart : ICON.heartO) : justAdded ? ICON.check : ICON.plus;
    const sel = S.selected.has(s.id);
    const name = (s.untitled ? s.title + "." + s.fmt.toLowerCase() : s.title) + "、" + (s.artist || "アーティスト情報なし") + (playing ? "、再生中" : "");
    return `<li class="row${open ? " is-open" : ""}${S.selectMode ? " is-select" : ""}${S.active === s.id ? " is-active" : ""}${playing ? " is-playing" : ""}" data-id="${s.id}" style="--dest:${INK[d.ink]}">
      ${S.selectMode ? `<button class="row-check" type="button" role="checkbox" aria-checked="${sel}" data-act="sel" data-id="${s.id}" aria-label="「${esc(s.title)}」を選択"><i></i></button>` : ""}
      <span class="row-mark" aria-hidden="true">${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</span>
      <button class="row-main" type="button" data-act="open" data-id="${s.id}" aria-expanded="${open}" aria-label="${esc(name)}。詳細">
        ${title}
        <span class="row-sub">
          <span class="row-artist${s.artist ? "" : " is-missing"}">${esc(s.artist || "アーティスト情報なし")}</span>
          ${twins > 1 ? `<span class="row-twin" title="同じ曲名とアーティストのファイルが${twins}件あります">${s.fmt}・同名${twins}件</span>` : ""}
          <span class="narrow-meta">${s.year || "年なし"}・${fmtDur(s.dur)}</span>
          ${state}
          ${hits.length ? `<span class="row-why">${hits.map((t) => `<span class="hit">${esc(/^\d{4}$/.test(t) ? t + "年" : t)}</span>`).join("")}</span>` : ""}
        </span>
      </button>
      <span class="row-meta">${s.year ? s.year : '<span title="制作年が未設定">—</span>'}<span class="dur">${fmtDur(s.dur)}</span></span>
      <button class="add${inDest && isFav ? " is-done" : ""}${justAdded ? " is-just" : ""}${isFav ? " is-fav" : ""}" type="button" data-act="add" data-id="${s.id}" aria-label="${esc(addLabel)}" ${s.missing ? 'aria-disabled="true"' : ""} title="${esc(addLabel)}"><i>${addIcon}</i></button>

    </li>`;
  }
  function renderResults() {
    const d = playlists.find((p) => p.id === S.dest);
    app.style.setProperty("--dest", INK[d.ink]);
    const bar = $("#resultsBar");
    const list = S.sim === "error" ? lastGood : result;
    const on = S.clauses.filter((c) => c.on);
    const n = S.sim === "loading" ? "…" : fmtN(list.length);
    const what = !on.length ? "すべての曲" : on.length === 1 ? "条件に一致" : S.mode === "all" ? `${on.length}つの条件すべてに一致` : `${on.length}つの条件のどれかに一致`;
    const count = `<span class="rb-count" id="rbCount"><b>${n}</b><span>曲</span><small>${S.sim === "error" ? "前回の結果" : S.sim === "loading" ? "照合中" : what}</small></span>`;
    const destChip = `<button class="dest-chip" type="button" data-act="open-dock" aria-label="追加先: ${esc(d.name)}。押すと変える" style="--dest:${INK[d.ink]}"><i aria-hidden="true"></i><span class="lbl">追加先</span><span class="nm">${esc(d.name)}</span>${ICON.chev}</button>`;
    if (S.selectMode) {
      const visibleSelection = list.filter(s => S.selected.has(s.id)).length;
      bar.innerHTML = `<span class="rb-sel" role="status">${S.selected.size}曲を選択中</span><span class="grow"></span>
        <button class="rb-btn" type="button" data-act="sel-all">表示中を選択</button>
        <button class="rb-btn index-bulk" type="button" data-act="edit-selected" ${visibleSelection ? "" : "disabled"}>${visibleSelection ? visibleSelection+"曲の" : ""}タグを編集</button>
        <button class="rb-btn" type="button" data-act="sel-end">やめる</button>
        <button class="rb-primary" type="button" data-act="add-sel" ${S.selected.size ? "" : "disabled"} style="--dest:${INK[d.ink]}">${ICON.plus}${esc(d.name)}に追加</button>`;
    } else {
      const sortOpts = Object.entries(SORTS).map(([k, [nm]]) => `<option value="${k}"${k === S.sort ? " selected" : ""}>${nm}</option>`).join("");
      bar.innerHTML = `${count}<span class="grow"></span>
        <span class="rb-tools"><label class="vh" for="sortSel">並び順</label><select id="sortSel">${sortOpts}</select><button class="rb-btn" type="button" data-act="sel-start">${ICON.select}まとめて選ぶ</button></span>
        ${destChip}
        <span class="menu-wrap rb-more"><button class="icon-btn" type="button" data-act="rb-menu" aria-haspopup="menu" aria-expanded="${!!S.rbMenu}" aria-label="並び順とまとめて選ぶ" title="並び順とまとめて選ぶ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v2H3zm4 5h10v2H7zm3 5h4v2h-4z"/></svg></button>
          <span class="menu" role="menu" ${S.rbMenu ? "" : "hidden"}>${Object.entries(SORTS).map(([k, [nm]]) => `<button type="button" role="menuitemradio" aria-checked="${k === S.sort}" data-act="sort-to" data-v="${k}">${nm}</button>`).join("")}<button type="button" role="menuitem" data-act="sel-start" class="sep">まとめて選ぶ</button></span></span>`;
    }
    const rows = $("#rows"); const empty = $("#rowsEmpty");
    $("#results").classList.toggle("is-stale", S.sim === "error");
    if (S.sim === "loading") {
      rows.innerHTML = Array.from({ length: 7 }, () => '<li class="skeleton" aria-hidden="true"><span></span><span><i class="t"></i><i class="a"></i></span><span></span></li>').join("");
      empty.hidden = true; return;
    }
    if (!list.length) {
      rows.innerHTML = ""; empty.hidden = false; empty.innerHTML = emptyHTML(); return;
    }
    empty.hidden = true;
    rows.innerHTML = list.slice(0, S.limit).map(rowHTML).join("");
  }
  function relaxations() {
    const act = S.clauses.filter((c) => c.on);
    const relax = act.map((c) => ({ cs: [c], n: filter(activeClauses().filter((x) => x !== c)).length })).sort((a, b) => b.n - a.n);
    // when no single removal helps, offer the pairs that do
    let pairs = [];
    if (relax.length > 2 && relax[0].n === 0) {
      for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++)
        pairs.push({ cs: [act[i], act[j]], n: filter(activeClauses().filter((x) => x !== act[i] && x !== act[j])).length });
      pairs = pairs.filter((p) => p.n).sort((a, b) => b.n - a.n).slice(0, 3);
    }
    return (pairs.length ? pairs : relax).filter(r=>r.n>0).slice(0,3);
  }
  function emptyHTML() {
    const act=activeClauses(), choices=relaxations();
    const opt = ({ cs, n }) => `<button type="button" data-act="rm-clauses" data-ids="${cs.map((c) => c.id).join(",")}"><span class="what">${cs.map((c) => `<s>${esc(clauseText(c))}</s>`).join(" と ")} を外す</span><span class="n">${fmtN(n)}</span>曲</button>`;
    return `<h3>現在の条件に一致する曲はありません</h3>
      <p>${choices[0]?.cs.length>1 ? "一つ外すだけでは見つかりません。二つ外すと次の件数になります。" : "どれか一つを外すと、次の件数になります。"}</p>
      <div class="relax">${choices.map(opt).join("") || '<button data-act="clear-all">条件をすべて外す</button>'}</div>
      ${S.mode === "all" ? `<p style="margin-top:14px"><button class="btn" type="button" data-act="mode">どれかに一致する曲にする（${fmtN(filter(act, "any").length)}曲）</button></p>` : ""}`;
  }

  // ---------------------------------------------------------------- render: dock + now
  function renderDock() {
    const d = playlists.find((p) => p.id === S.dest);
    const list = L[S.dest];
    const dock = $("#dock");
    dock.style.setProperty("--dest", INK[d.ink]);
    const manual = list.filter((x) => !x.auto);
    const auto = list.filter((x) => x.auto);
    const tail = (arr, startPos) => arr.map((x, i) => { const s = byId.get(x.id); return `<li class="${x.fresh ? "is-new" : ""}${x.auto ? " auto" : ""}"><span class="pos">${startPos + i}</span><span><span class="t">${esc(s.title)}</span><span class="a">${esc(s.artist || "アーティスト情報なし")}</span></span></li>`; }).join("");
    let tailHTML;
    if (d.kind === "queue") {
      const shown = manual.slice(-8);
      tailHTML = tail(shown, manual.length - shown.length + 1) + (auto.length ? `<li class="boundary">ここから自動選曲（手動で選んだ曲の後に続きます）</li>` + tail(auto, manual.length + 1) : "");
    } else {
      const shown = list.slice(-10); tailHTML = tail(shown, list.length - shown.length + 1);
    }
    // The list of destinations is a now-and-then choice: folded behind
    // "変える" on desktop, always open in the narrow sheet.
    const listOpen = S.destList || S.dockOpen;
    dock.innerHTML = `
      <button class="icon-btn dock-close" type="button" data-act="close-dock" aria-label="追加先を閉じる">${ICON.x}</button>
      <div class="dock-head">
        <div class="dock-label">追加先 <span>曲の ＋ でここに入ります</span></div>
        <div class="dock-dest"><span class="dock-swatch" aria-hidden="true"></span><span class="dock-name" id="dockName">${esc(d.name)}</span><button class="dock-change" type="button" data-act="dest-list" aria-expanded="${!!listOpen}" aria-controls="dests">変える</button></div>
        <div class="dock-n">${d.kind === "queue" ? `手で選んだ曲 <b>${manual.length}</b>・自動選曲 <b>${auto.length}</b>` : `<b>${list.length}</b>曲`}${S.dest === "queue" ? '<span class="src">再生中のリスト</span>' : ""}</div>
      </div>
      <ul class="dests" id="dests" role="radiogroup" aria-label="追加先を選ぶ" ${listOpen ? "" : "hidden"}>
        ${playlists.map((p) => `<li><button class="dest" type="button" role="radio" aria-checked="${p.id === S.dest}" data-act="dest" data-id="${p.id}" data-kind="${p.kind}" style="--c:${INK[p.ink]}"><i></i><span>${esc(p.name)}${p.id === "queue" ? '<span class="src">再生中</span>' : ""}</span><span class="n">${fmtN(L[p.id].length)}</span></button></li>`).join("")}
      </ul>
      <div class="dock-tail-head"><span>${d.kind === "fav" ? "最近登録した曲" : "末尾の曲"}</span><span>${d.kind === "queue" ? "自動選曲の前に入ります" : ""}</span></div>
      <ol class="tail">${tailHTML}</ol>`;
  }
  function renderNow() {
    const s = nowPlaying;
    const next = byId.get(L.queue[0].id);
    $("#now").innerHTML = `
      <span class="now-eq row-mark" aria-hidden="true"><span class="eq"><i></i><i></i><i></i></span></span>
      <div class="now-main">
        <div class="now-line"><span class="now-title">${esc(s.title)}</span><span class="now-artist">${esc(s.artist)}</span></div>
        <div class="now-line"><div class="now-bar"><i></i></div><span class="now-src">再生元 <b>再生待ち</b>　次 ${esc(next.title)}</span></div>
      </div>
      <div class="now-ctl"><button type="button" aria-label="一時停止" title="一時停止">${ICON.pause}</button><button type="button" aria-label="次の曲へ" title="次の曲へ">${ICON.next}</button></div>`;
  }

  function render() {
    app.classList.toggle("lens-open", S.lens);
    window.indexSearch?.refresh(); renderResults(); renderDock();
    app.classList.toggle("dock-open", S.dockOpen);
    $("#scrim").hidden = !S.dockOpen;
  }
  function update() { compute(); render(); }

  // ---------------------------------------------------------------- feedback
  let toastT;
  function toast(msg, actLabel, act) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${actLabel ? `<button type="button">${actLabel}</button>` : ""}`;
    t.hidden = false;
    if (act) t.querySelector("button").onclick = () => { act(); t.hidden = true; };
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 6000);
  }
  function fly(from) {
    if (!from || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = innerWidth < 1100 ? $(".dest-chip") : $("#dockName");
    if (!to) return;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const f = $("#flyer");
    f.animate([
      { opacity: 1, transform: `translate(${a.left + a.width / 2 - 7}px, ${a.top + a.height / 2 - 7}px) scale(1)` },
      { opacity: 1, transform: `translate(${(a.left + b.left) / 2}px, ${Math.min(a.top, b.top) - 60}px) scale(1.3)`, offset: .45 },
      { opacity: 0, transform: `translate(${b.left + 10}px, ${b.top + b.height / 2 - 7}px) scale(.6)` },
    ], { duration: 520, easing: "cubic-bezier(.3,.7,.4,1)" });
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT") return;
    const id = Number(t.dataset.id);
    switch (t.dataset.act) {
      case "rm-clauses": { const prev = snapshot(); const ids = t.dataset.ids.split(",").map(Number); S.clauses = S.clauses.filter((c) => !ids.includes(c.id)); update();
        toast(`条件を${ids.length}つ外しました`, "元に戻す", () => { S.clauses = prev.clauses; update(); }); break; }
      case "mode": S.mode = S.mode === "all" ? "any" : "all"; update(); break;
      case "set-mode": S.mode = t.dataset.v; update(); break;
      case "dest-list": S.destList = !S.destList; renderDock(); if (S.destList) setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "rb-menu": S.rbMenu = !S.rbMenu; renderResults(); if (S.rbMenu) setTimeout(() => $(".rb-more .menu button")?.focus()); break;
      case "sort-to": S.sort = t.dataset.v; S.rbMenu = false; update(); break;
      case "clear-all": { const prev = snapshot(); S.clauses = []; update(); toast("条件をすべて外しました", "元に戻す", () => { S.clauses = prev.clauses; S.mode = prev.mode; update(); }); break; }
      case "retry": S.sim = "ok"; update(); toast("検索を更新しました"); break;
      case "open": window.indexDetail.open(id); break;
      case "edit-selected": window.indexDetail.bulk(); break;
      case "add": {
        if (t.getAttribute("aria-disabled") === "true") { toast("ファイルが見つからないため追加できません"); break; }
        addTo(S.dest, [id], t); break;
      }
      case "fav": addTo("fav", [id], t); break;
      case "dest": S.dest = t.dataset.id; S.dockOpen = false; S.destList = false; S.lastAdded = null; render(); toast(`追加先を${playlists.find((p) => p.id === S.dest).name}に変えました`); break;
      case "open-dock": S.dockOpen = true; render(); setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "close-dock": S.dockOpen = false; render(); break;
      case "sel-start": S.selectMode = true; S.rbMenu = false; S.selected.clear(); renderResults(); break;
      case "sel-end": S.selectMode = false; S.selected.clear(); renderResults(); break;
      case "sel": S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderResults(); break;
      case "sel-all": (S.sim === "error" ? lastGood : result).slice(0, S.limit).forEach((s) => S.selected.add(s.id)); renderResults(); break;
      case "add-sel": { const ids = [...S.selected]; addTo(S.dest, ids, t); S.selected.clear(); S.selectMode = false; renderResults(); break; }
    }
  });
  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  moreBtn.addEventListener("click", () => { moreMenu.hidden = !moreMenu.hidden; moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden)); if (!moreMenu.hidden) moreMenu.querySelector("button").focus(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#moreBtn") && !e.target.closest("#moreMenu")) { moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
    if (S.rbMenu && !e.target.closest(".rb-more")) { S.rbMenu = false; renderResults(); }
  });
  $("#scrim").addEventListener("click", () => { S.dockOpen = false; render(); });
  document.addEventListener("change", (e) => { if (e.target.id === "sortSel") { S.sort = e.target.value; update(); } });
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]") || (window.indexSearch && (e.key === "/" || e.target.closest("#query,#lens")))) return;
    const inField = e.target.matches("input");
    if (e.key === "Escape") {
      if (!moreMenu.hidden) { moreMenu.hidden = true; moreBtn.focus(); }
      else if (S.rbMenu) { S.rbMenu = false; renderResults(); $('[data-act="rb-menu"]')?.focus(); }
      else if (S.dockOpen) { S.dockOpen = false; render(); $(".dest-chip")?.focus(); }
      else if (S.destList) { S.destList = false; renderDock(); $(".dock-change")?.focus(); }

      return;
    }
    const row = e.target.closest && e.target.closest(".row");
    if (row && !inField) {
      const id = Number(row.dataset.id);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const sib = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        sib?.querySelector(".row-main")?.focus(); S.active = sib ? Number(sib.dataset.id) : S.active;
      } else if (e.key === "a" || e.key === "+") { e.preventDefault(); addTo(S.dest, [id], row.querySelector(".add")); setTimeout(() => document.querySelector(`.row[data-id="${id}"] .row-main`)?.focus()); }
      else if (e.key === " " && S.selectMode) { e.preventDefault(); S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderResults(); document.querySelector(`.row[data-id="${id}"] .row-main`)?.focus(); }
    }
  });
  // infinite list
  new IntersectionObserver((en) => { if (en[0].isIntersecting && result.length > S.limit && S.sim !== "loading") { S.limit += 60; renderResults(); } }, { root: $("#results") }).observe($("#sentinel"));

  $("#themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  });

  // ---------------------------------------------------------------- scenarios (demo only)
  const C = (kind, values, extra = {}) => Object.assign({ id: uid++, kind, values: [].concat(values), on: true, not: false }, extra);
  const SCN = {
    base() {},
    a() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix")]; },
    "a-edit"() { SCN.a(); S.clauses.pop(); S.lens = true; S.input = "アニソン"; },
    "a-browse"() { S.clauses = [C("year", "2015")]; S.lens = true; },
    "a-detail"() { SCN.a(); S.open = songs[5].id; S.active = songs[5].id; },
    "a-select"() { SCN.a(); S.selectMode = true; [1, 2, 4].forEach((k) => S.selected.add(songs[k].id)); },
    "a-dest"() { SCN.a(); S.dockOpen = true; },
    eight() {
      S.clauses = [C("year", ["2015", "2016"]), C("custom", "日本人トラックメーカー"), C("genre", ["アニソンremix", "アニソンRemix", "anison remix"]),
        C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", { on: false }), C("genre", "Funkot"), C("custom", "コール入り", { not: true }),
        C("custom", "多幸感", { on: false }), C("text", "シグナル"), C("custom", "2015夏頒布", { on: false })];
    },
    "eight-edit"() { SCN.eight(); S.lens = true; },
    zero() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix"), C("custom", "2009冬頒布"), C("custom", "サイレン")]; },
    loading() { SCN.a(); S.sim = "loading"; },
    error() { SCN.a(); compute(); lastGood = result; S.clauses.push(C("custom", "ネタ曲")); S.sim = "error"; },
    long() { S.clauses = [C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ"), C("year", "2015")]; S.open = songs[4].id; },
    fav() { SCN.a(); S.dest = "fav"; },
    "a-or"() { SCN.a(); S.mode = "any"; },
    added() { SCN.a(); S.after = () => { const s = result.find((x) => !x.missing && x.id !== nowPlaying.id); addTo("queue", [s.id], null); }; },
    "eight-dest"() { SCN.eight(); S.destList = true; },
  };
  function scenario(name) {
    Object.assign(S, { clauses: [], mode: "all", input: "", lens: false, focusClause: null, sim: "ok", open: null, active: null, selectMode: false, dockOpen: false, limit: 60, editTags: null, dest: "queue", lastAdded: null, destList: false, rbMenu: false, after: null });
    S.selected = new Set();
    (SCN[name] || SCN.base)();
    compute(); if (S.sim === "ok") lastGood = result;
    if (name === "a" || name === "eight") remember();
    render();
    if (S.open != null && window.indexDetail) window.indexDetail.open(S.open);
    if (S.after) { const f = S.after; S.after = null; f(); }
    document.querySelectorAll(".demo button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === name)));
  }
  $("#demo").addEventListener("click", (e) => { const b = e.target.closest("[data-scn]"); if (b) { scenario(b.dataset.scn); history.replaceState(null, "", "#" + b.dataset.scn); } });
  const params = new URLSearchParams(location.search);
  if (params.has("capture")) document.body.classList.add("capture");
  if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");
  renderNow();
  document.fonts && document.fonts.ready.then(() => window.indexSearch?.refresh());
  scenario(params.get("s") || location.hash.slice(1) || "base");
  window.FKP = { S, scenario, update, render, filter, fold, clauseMatch, results: () => result, displayed: () => S.sim === "loading" ? [] : S.sim === "error" ? lastGood : result, newClause: C, relaxations, remember, lists: L, nowPlaying, addTo, toast };
})();
