// Overprint — interaction prototype. Mock data only; nothing is saved.
(function () {
  const { songs, tagIndex, playlists } = window.FK;
  const $ = (s, r = document) => r.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => n.toLocaleString("ja-JP");
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const INK = { blue: "var(--blue)", teal: "var(--teal)", orange: "var(--orange)", violet: "var(--violet)", pink: "var(--pink-text)" };
  const KIND_NAME = { year: "制作年", genre: "ジャンル", custom: "タグ", text: "曲名・アーティスト", artist: "アーティスト" };
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
  const tagsArr = [...tagIndex.values()];

  // ---------------------------------------------------------------- matching
  const fold = (s) => String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/りみっくす/g, "remix").replace(/anison[g]?/g, "あにそん").replace(/nihonjin/g, "日本人")
    .replace(/[\s・:：\-_/()（）]/g, "");
  const clauseMatch = (c, s) => {
    let hit;
    switch (c.kind) {
      case "year": hit = c.values.includes(String(s.year)); break;
      case "genre": hit = c.values.some((v) => s.genres.includes(v)); break;
      case "custom": hit = c.values.some((v) => s.tags.includes(v)); break;
      case "artist": hit = c.values.includes(s.artist); break;
      case "text": { const q = fold(c.values[0]); hit = fold(s.title).includes(q) || fold(s.artist).includes(q); break; }
    }
    return c.not ? !hit : hit;
  };
  // While typing, the results preview the highlighted suggestion, never the
  // raw text: typing a tag's name must not empty the list on the way there.
  let sugg = { out: [], base: songs };
  const pendingClause = () => {
    if (!S.input.trim() || !S.lens || S.focusClause) return null;
    const o = sugg.out[S.sugIndex];
    return o ? { kind: o.kind, values: [o.value], on: true, pending: true } : null;
  };
  const activeClauses = (extra) => {
    const a = S.clauses.filter((c) => c.on);
    const p = pendingClause(); if (p) a.push(p);
    if (extra) a.push(extra);
    return a;
  };
  function filter(clauses, mode = S.mode) {
    if (!clauses.length) return songs;
    return mode === "all" ? songs.filter((s) => clauses.every((c) => clauseMatch(c, s)))
      : songs.filter((s) => clauses.some((c) => clauseMatch(c, s)));
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
    sugg = S.lens && S.input.trim() ? suggestions() : { out: [], base: songs };
    if (S.sugIndex >= sugg.out.length) S.sugIndex = 0;
    result = filter(activeClauses()).slice().sort(SORTS[S.sort][1]);
    if (S.sim === "ok") lastGood = result;
  }

  // ---------------------------------------------------------------- suggestions
  function suggestions() {
    const q = S.input.trim();
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const base = filter(S.clauses.filter((c) => c.on && c !== focus));
    const out = [];
    if (!q) return { out, base };
    const fq = fold(q);
    const tags = [];
    for (const t of tagsArr) {
      if (focus && focus.kind !== t.kind) continue;
      if (focus && focus.values.includes(t.value)) continue;
      const f = fold(t.value);
      const at = f.indexOf(fq);
      if (at < 0) continue;
      tags.push({ t, f, score: (at === 0 ? 2 : 0) + (f === fq ? 3 : 0) });
    }
    const total = tags.length;
    // count within the current result (what would remain if this were added)
    const baseSet = base;
    const countFor = (kind, value) => {
      const c = { kind, values: [value], on: true };
      let n = 0; for (const s of baseSet) if (clauseMatch(c, s)) n++;
      return n;
    };
    tags.sort((a, b) => b.score - a.score || b.t.count - a.t.count);
    // group spelling variants: same folded form
    const groups = new Map();
    for (const x of tags) {
      const k = x.t.kind + "|" + x.f;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x.t);
    }
    let shown = 0;
    for (const [, g] of groups) {
      if (shown >= 9) break;
      g.sort((a, b) => b.count - a.count);
      const head = g[0];
      out.push({ kind: head.kind, value: head.value, n: countFor(head.kind, head.value), total: head.count,
        variants: g.slice(1).map((v) => ({ value: v.value, total: v.count })) });
      shown++;
    }
    // the plain-text option leads unless a tag name starts with what was typed
    const lead = tags.length && tags[0].score >= 2 ? 1 : 0;
    const extra = [];
    if (!focus) {
      let n = 0; const tc = { kind: "text", values: [q], on: true };
      for (const s of base) if (clauseMatch(tc, s)) n++;
      extra.push({ kind: "text", value: q, label: `「${q}」を曲名・アーティストに含む`, n });
    }
    if (!focus || focus.kind === "artist") {
      const arts = new Map();
      for (const s of base) { if (s.artist && fold(s.artist).includes(fq)) arts.set(s.artist, (arts.get(s.artist) || 0) + 1); if (arts.size > 40) break; }
      [...arts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([a, n]) => extra.push({ kind: "artist", value: a, n }));
    }
    out.splice(Math.min(lead, out.length), 0, ...extra);
    const more = Math.max(0, groups.size - shown);
    return { out, base, more, total };
  }

  // ---------------------------------------------------------------- mutations
  const snapshot = () => JSON.parse(JSON.stringify({ clauses: S.clauses, mode: S.mode }));
  function remember() {
    if (!S.clauses.length) return;
    const key = JSON.stringify(S.clauses.map((c) => [c.kind, c.values, c.not, c.on]));
    S.recent = S.recent.filter((r) => r.key !== key);
    S.recent.unshift({ key, snap: snapshot(), n: result.length });
    S.recent = S.recent.slice(0, 4);
  }
  function addValue(kind, value, opts = {}) {
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    if (focus && focus.kind === kind && kind !== "text") {
      if (!focus.values.includes(value)) focus.values.push(value);
    } else if (kind === "year" && S.clauses.some((c) => c.kind === "year" && c.on && !c.not)) {
      // a song has a single year, so years always combine as alternatives
      const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
      if (yc.values.includes(value)) yc.values = yc.values.filter((v) => v !== value);
      else yc.values.push(value);
      if (!yc.values.length) S.clauses = S.clauses.filter((c) => c !== yc);
    } else {
      S.clauses.push({ id: uid++, kind, values: Array.isArray(value) ? value : [value], on: true, not: !!opts.not });
    }
    S.input = ""; S.sugIndex = 0; S.focusClause = null; S.open = null;
    update(); remember();
  }
  function removeClause(id, silent) {
    const i = S.clauses.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [c] = S.clauses.splice(i, 1);
    if (S.focusClause === id) S.focusClause = null;
    update();
    if (!silent) toast(`条件「${clauseText(c)}」を外しました`, "元に戻す", () => { S.clauses.splice(i, 0, c); update(); });
  }
  function removeValue(id, v) {
    const c = S.clauses.find((x) => x.id === id); if (!c) return;
    if (c.values.length === 1) return removeClause(id);
    const i = c.values.indexOf(v); c.values.splice(i, 1); update();
    toast(`「${v}」を外しました`, "元に戻す", () => { c.values.splice(i, 0, v); update(); });
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

  // ---------------------------------------------------------------- render: query
  // One printed line: each condition is an underlined phrase with a small
  // ink mark for its kind. The line never wraps; what does not fit folds
  // into "ほかN". Editing happens in the lens, never in this line.
  function termHTML(c) {
    const vals = c.values.map((v, i) => `${i ? '<span class="t-or">または</span>' : ""}<span class="t-label">${esc(c.kind === "year" ? v + "年" : v)}</span>`).join("");
    const st = c.on ? (c.not ? "（これ以外）" : "") : "（一時停止中）";
    return `<button class="term${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}" type="button" data-kind="${c.kind}" data-act="edit-clause" data-id="${c.id}" aria-label="${esc(KIND_NAME[c.kind] + " " + clauseText(c) + st)}。押すと条件を編集"><i class="t-mark" aria-hidden="true"></i>${vals}</button>`;
  }
  function renderQuery() {
    const st = $("#status");
    st.className = "status";
    if (S.sim === "loading") st.innerHTML = `<span>${fmtN(songs.length)}曲を照合しています…</span>`;
    else if (S.sim === "error") { st.className = "status is-error"; st.innerHTML = `<span>検索を更新できませんでした。タグを読み込めません。下は前回の結果です</span><button type="button" data-act="retry">再試行</button>`; }
    else st.innerHTML = "";
    st.hidden = !st.innerHTML;

    const box = $("#summary");
    const p = pendingClause();
    if (!S.clauses.length && !p) { box.hidden = true; box.innerHTML = ""; }
    else {
      box.hidden = false;
      const join = S.mode === "all" ? "かつ" : "または";
      let h = S.clauses.map((c, i) => (i ? `<span class="t-join" aria-hidden="true">${join}</span>` : "") + termHTML(c)).join("");
      if (p) h += `${S.clauses.length ? `<span class="t-join" aria-hidden="true">${join}</span>` : ""}<span class="term is-ghost" data-kind="${p.kind === "artist" ? "text" : p.kind}"><i class="t-mark" aria-hidden="true"></i><span class="t-label">${esc(p.kind === "year" ? p.values[0] + "年" : p.values[0])}</span><span class="ghost-note">選択中</span></span>`;
      const paused = S.clauses.filter((c) => !c.on).length;
      box.innerHTML = `<div class="terms" id="terms">${h}</div>${S.clauses.length ? `<button class="sum-edit" type="button" data-act="open-lens" aria-label="条件を編集（${S.clauses.length}つ${paused ? `、うち${paused}つ一時停止中` : ""}）">編集</button><button class="sum-clear icon-btn" type="button" data-act="clear-all" aria-label="条件をすべて外す" title="条件をすべて外す">${ICON.x}</button>` : ""}`;
      fitTerms($("#terms"));
    }
    $("#finderInput").value = S.input;
    $("#finderInput").setAttribute("aria-expanded", String(S.lens));
  }
  function fitTerms(box) {
    if (box.scrollWidth <= box.clientWidth + 1) return;
    const items = [...box.children];
    let hidden = 0;
    const more = document.createElement("button");
    more.type = "button"; more.className = "t-more"; more.dataset.act = "open-lens";
    box.appendChild(more);
    while (box.scrollWidth > box.clientWidth + 1 && items.length > 1) {
      const e = items.pop(); e.hidden = true; if (e.classList.contains("term")) hidden++;
      more.textContent = `ほか${hidden}つ`;
      more.setAttribute("aria-label", `ほか${hidden}つの条件を表示して編集`);
    }
    const vis = items.filter((e) => !e.hidden);
    if (vis.length && vis[vis.length - 1].classList.contains("t-join")) vis[vis.length - 1].hidden = true;
  }

  // ---------------------------------------------------------------- render: lens
  function renderLens() {
    const el = $("#lens");
    el.hidden = !S.lens;
    if (!S.lens) return;
    const { out, more, total, base } = sugg.out.length || S.input.trim() ? sugg : suggestions();
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const join = S.mode === "all" ? "かつ" : "または";
    const clauses = S.clauses.map((c, i) => `
      <div class="clause${c.on ? "" : " is-off"}${focus === c ? " is-focus" : ""}" data-id="${c.id}">
        <div class="clause-join">${i ? join : ""}</div>
        <div class="clause-vals">
          <span class="clause-kind"><span>${KIND_NAME[c.kind]}${c.not ? "　これ以外" : ""}${c.values.length > 1 ? "　どれか" : ""}</span><span class="clause-tools"><button class="icon-btn" type="button" data-act="not" data-id="${c.id}" aria-pressed="${c.not}" title="${c.not ? "これを含む曲に戻す" : "これ以外の曲にする"}" aria-label="${c.not ? "これを含む曲に戻す" : "これ以外の曲にする"}">${ICON.not}</button>
          <button class="switch" type="button" role="switch" data-act="toggle" data-id="${c.id}" aria-checked="${c.on}" aria-label="条件「${esc(clauseText(c))}」を使う"><i></i></button>
          <button class="icon-btn" type="button" data-act="rm-clause" data-id="${c.id}" aria-label="条件「${esc(clauseText(c))}」を外す">${ICON.trash}</button></span></span>
          ${c.values.map((v, k) => `${k ? '<span class="val-or">または</span>' : ""}<span class="val"><span>${esc(c.kind === "year" ? v + "年" : v)}</span><button type="button" data-act="rm-val" data-id="${c.id}" data-v="${esc(v)}" aria-label="「${esc(v)}」を外す">${ICON.x}</button></span>`).join("")}
          ${c.kind !== "text" ? `<button class="add-alt" type="button" data-act="alt" data-id="${c.id}" aria-pressed="${focus === c}">${focus === c ? "言い換えを選んでいます" : "＋または…"}</button>` : ""}
        </div>

      </div>`).join("");
    const modeSeg = S.clauses.length > 1 ? `<span class="seg" role="radiogroup" aria-label="一致のしかた"><button type="button" role="radio" data-act="set-mode" data-v="all" aria-checked="${S.mode === "all"}">すべてに一致</button><button type="button" role="radio" data-act="set-mode" data-v="any" aria-checked="${S.mode === "any"}">どれかに一致</button></span>` : "";
    const left = `
      <section>
        <h2 class="lens-h">いまの条件 ${modeSeg}</h2>
        ${clauses || '<p class="lens-empty">まだ条件はありません。右の候補を選ぶか、上の欄に入力してください。</p>'}
      </section>
      ${S.recent.length ? `<section><h2>最近の条件</h2><div class="recent">${S.recent.map((r, i) => `<button type="button" data-act="recent" data-i="${i}"><span class="r-terms">${esc(r.snap.clauses.map(clauseText).join(" ＋ "))}</span><span class="r-n">${fmtN(r.n)}曲</span></button>`).join("")}</div></section>` : ""}`;

    let right;
    if (S.sim === "error") {
      right = `<section><h2>候補を読み込めませんでした</h2><p class="lens-empty">タグの一覧を読めないため、候補と件数を出せません。曲名とアーティストの検索は使えます。</p><button class="btn" type="button" data-act="retry">再試行</button></section>`;
    } else if (S.input.trim()) {
      right = `<section><h2>${focus ? `「${esc(clauseText(focus))}」の言い換え（どれか一つに一致）` : "候補"} <span class="aside">${total ? `一致するタグ ${fmtN(total)}件` : ""}</span></h2>
        <ul class="sugg-list" role="listbox" id="suggList" aria-label="候補">${out.map((o, i) => suggHTML(o, i)).join("")}</ul>
        ${more ? `<p class="lens-empty">ほかに${fmtN(more)}件の候補があります。続けて入力すると絞り込めます。</p>` : ""}
        ${!out.length ? `<p class="lens-empty">「${esc(S.input)}」に一致するタグはありません。</p>` : ""}</section>`;
    } else {
      right = browseHTML(base, focus);
    }
    const head = `<div class="lens-head"><button class="icon-btn" type="button" data-act="close-lens" aria-label="条件の編集を閉じる">${ICON.back}</button>
      <label class="finder-field"><input id="lensInput" type="search" autocomplete="off" value="${esc(S.input)}" placeholder="タグ・年・曲名を入力" aria-label="タグ・年・曲名を入力" aria-controls="suggList"></label></div>`;
    const foot = `<div class="lens-foot"><span class="lens-foot-note">条件を編集中・Esc で閉じる</span><button class="btn" type="button" data-act="clear-all" ${S.clauses.length ? "" : "disabled"}>すべて外す</button><button class="btn primary" type="button" data-act="close-lens">${S.sim === "loading" ? "照合中…" : fmtN(result.length) + "曲を表示"}</button></div>`;
    el.innerHTML = head + `<div class="lens-col clauses">${left}</div><div class="lens-col">${right}</div>` + foot;
  }
  function hl(text) {
    const q = S.input.trim(); if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function suggHTML(o, i) {
    const dead = o.n === 0;
    const sub = o.kind === "text" ? "入力した文字で絞り込む" : o.kind === "artist" ? "アーティスト" : `${KIND_NAME[o.kind]}　ライブラリ全体で${fmtN(o.total)}曲`;
    const n = o.n === undefined ? "" : dead ? "加えると0曲" : `加えると <b>${fmtN(o.n)}</b>曲`;
    const glyph = { year: "年", genre: "ジ", custom: "", artist: "人", text: "文" }[o.kind];
    let h = `<li class="sugg${dead ? " is-dead" : ""}" role="option" id="sg${i}" aria-selected="${i === S.sugIndex}" data-act="pick" data-kind="${o.kind}" data-v="${esc(o.value)}">
      <span class="sugg-ico" data-kind="${o.kind}" aria-hidden="true">${glyph}</span>
      <span class="sugg-main"><span class="sugg-name">${o.kind === "text" ? esc(o.label) : hl(o.value)}</span><span class="sugg-sub">${sub}</span></span>
      <span class="sugg-n">${n}</span></li>`;
    if (o.variants && o.variants.length) {
      h += `<li class="sugg-variants" role="presentation">似た表記: ${o.variants.map((v) => `${esc(v.value)}（${fmtN(v.total)}曲）`).join("、")}
        <button type="button" data-act="pick-group" data-kind="${o.kind}" data-vs="${esc(JSON.stringify([o.value, ...o.variants.map((v) => v.value)]))}">表記揺れをまとめて「どれか」で加える</button></li>`;
    }
    return h;
  }
  function browseHTML(base, focus) {
    const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
    const yBase = filter(S.clauses.filter((c) => c.on && c !== yc));
    const yc2 = new Map(); yBase.forEach((s) => s.year && yc2.set(s.year, (yc2.get(s.year) || 0) + 1));
    const max = Math.max(1, ...yc2.values());
    let years = "";
    for (let y = 2008; y <= 2026; y++) {
      const n = yc2.get(y) || 0; const on = yc && yc.values.includes(String(y));
      years += `<button class="year-bar" type="button" data-act="year" data-v="${y}" aria-pressed="${!!on}" aria-label="${y}年 ${fmtN(n)}曲"><i style="height:${Math.max(2, (n / max) * 70)}px"></i><span>${String(y).slice(2)}</span></button>`;
    }
    const gc = new Map(), tc = new Map();
    base.forEach((s) => { s.genres.forEach((g) => gc.set(g, (gc.get(g) || 0) + 1)); s.tags.forEach((t) => tc.set(t, (tc.get(t) || 0) + 1)); });
    const used = new Set(S.clauses.flatMap((c) => c.values));
    const top = (m, k) => [...m.entries()].filter(([v]) => !used.has(v)).sort((a, b) => b[1] - a[1]).slice(0, k);
    const chip = (kind) => ([v, n]) => `<button class="chip" type="button" data-kind="${kind}" data-act="pick" data-v="${esc(v)}"><span>${esc(v)}</span><span class="n">${fmtN(n)}</span></button>`;
    const onlyKind = focus ? focus.kind : null;
    return `
      ${!onlyKind || onlyKind === "year" ? `<section><h2>制作年 <span class="aside">棒は${S.clauses.length ? "いまの条件での" : ""}曲数。複数の年は「どれか」で加わります</span></h2><div class="years">${years}</div><p class="years-note">${fmtN([...yBase].filter((s) => !s.year).length)}曲は制作年が未設定です</p></section>` : ""}
      ${!onlyKind || onlyKind === "genre" ? `<section><h2>ジャンル <span class="aside">いまの結果に多い順</span></h2><div class="chips">${top(gc, 10).map(chip("genre")).join("")}</div></section>` : ""}
      ${!onlyKind || onlyKind === "custom" ? `<section><h2>タグ <span class="aside">いまの結果に多い順。全${fmtN(tagsArr.filter((t) => t.kind === "custom").length)}件は入力で探せます</span></h2><div class="chips">${top(tc, 14).map(chip("custom")).join("")}</div></section>` : ""}`;
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
    const open = S.open === s.id;
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
      ${open ? detailHTML(s, terms) : ""}
    </li>`;
  }
  function detailHTML(s, terms) {
    const d = playlists.find((p) => p.id === S.dest);
    const twins = songs.filter((x) => twinKey(x) === twinKey(s));
    const ys = { auto: "ファイルの埋め込み情報から", manual: "自分で指定", missing: "未設定" }[s.yearStatus] || "";
    const chip = (kind) => (t) => `<button class="chip${terms.has(t) ? " is-hit" : ""}" type="button" data-act="pick" data-kind="${kind}" data-v="${esc(t)}" title="この${KIND_NAME[kind]}を条件に加える"><span>${esc(t)}</span></button>`;
    const fav = L.fav.some((x) => x.id === s.id);
    const editing = S.editTags === s.id;
    return `<div class="detail">
      <div>
        <dl>
          <dt>アーティスト</dt><dd>${s.artist ? esc(s.artist) : "情報なし（ファイルにアーティストが入っていません）"}</dd>
          <dt>制作年</dt><dd>${s.year ? s.year + "年" : "未設定"} <span class="note">${ys}</span></dd>
          <dt>ジャンル</dt><dd><div class="detail-tags">${s.genres.map(chip("genre")).join("") || "なし"}</div></dd>
          <dt>タグ</dt><dd><div class="detail-tags">${s.tags.map(chip("custom")).join("") || "なし"}
            ${editing ? `<label class="finder-field" style="height:40px;flex:1 1 200px"><input id="tagEdit" placeholder="タグを入力して Enter" aria-label="この曲に加えるタグ"></label>` : `<button class="chip" type="button" data-act="edit-tags" data-id="${s.id}">${ICON.tag}<span>タグを編集</span></button>`}</div>
            <span class="note">タグを押すと検索条件に加わります</span></dd>
          <dt>長さ</dt><dd>${fmtDur(s.dur)}</dd>
          <dt>ファイル</dt><dd>${esc(s.folder)}/${esc(s.untitled ? s.title : s.title.slice(0, 18))}.${s.fmt.toLowerCase()} <span class="note">${s.fmt}</span></dd>
          <dt>再生回数</dt><dd>${s.plays}回</dd>
        </dl>
      </div>
      <div>
        <div class="detail-actions">
          ${s.missing ? `<p class="note" style="font-size:14px;color:var(--danger)">ファイルが見つからないため追加できません。ライブラリの再読み込みで元の場所に戻ると使えるようになります。</p>` :
          `${d.kind !== "fav" ? `<button class="btn primary" type="button" data-act="add" data-id="${s.id}">${ICON.plus}${esc(d.name)}に追加</button>` : ""}
          <button class="btn" type="button" data-act="fav" data-id="${s.id}" aria-pressed="${fav}">${fav ? ICON.heart : ICON.heartO}${fav ? "お気に入りに登録済み" : "お気に入りに登録"}</button>
          <button class="btn" type="button" data-act="open-dock">${ICON.list}ほかの追加先へ</button>`}
        </div>
        ${twins.length > 1 ? `<div class="twins"><span class="note">同じ曲名とアーティストのファイルが${twins.length}件あります。形式と場所で区別できます。</span>
          ${twins.map((t) => `<div class="twin"><div><b>${t.fmt}</b>　${fmtDur(t.dur)}　再生${t.plays}回${t.id === s.id ? "（この行）" : ""}<div class="path">${esc(t.folder)}</div></div>
          <button class="add" type="button" data-act="add" data-id="${t.id}" aria-label="${t.fmt}版を${esc(d.name)}に追加" style="--dest:${INK[d.ink]}"><i>${ICON.plus}</i></button></div>`).join("")}</div>` : ""}
      </div>
    </div>`;
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
      bar.innerHTML = `<span class="rb-sel" role="status">${S.selected.size}曲を選択中</span><span class="grow"></span>
        <button class="rb-btn" type="button" data-act="sel-all">表示中を選択</button>
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
  function emptyHTML() {
    const act = S.clauses.filter((c) => c.on);
    const relax = act.map((c) => ({ cs: [c], n: filter(activeClauses().filter((x) => x !== c)).length })).sort((a, b) => b.n - a.n);
    // when no single removal helps, offer the pairs that do
    let pairs = [];
    if (relax.length > 2 && relax[0].n === 0) {
      for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++)
        pairs.push({ cs: [act[i], act[j]], n: filter(activeClauses().filter((x) => x !== act[i] && x !== act[j])).length });
      pairs = pairs.filter((p) => p.n).sort((a, b) => b.n - a.n).slice(0, 3);
    }
    const opt = ({ cs, n }) => `<button type="button" data-act="rm-clauses" data-ids="${cs.map((c) => c.id).join(",")}"><span class="what">${cs.map((c) => `<s>${esc(clauseText(c))}</s>`).join(" と ")} を外す</span><span class="n">${fmtN(n)}</span>曲</button>`;
    return `<h3>${act.length}つの条件すべてに一致する曲はありません</h3>
      <p>${pairs.length ? "一つ外すだけでは見つかりません。二つ外すと次の件数になります。" : "どれか一つを外すと、次の件数になります。"}</p>
      <div class="relax">${(pairs.length ? pairs : relax).map(opt).join("")}</div>
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
    renderQuery(); renderLens(); renderResults(); renderDock();
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
      case "open-lens": S.lens = true; render(); focusInput(); break;
      case "close-lens": commitInput(); break;
      case "edit-clause": S.lens = true; S.focusClause = null; render(); flash(id); focusInput(); break;
      case "rm-clause": removeClause(id); break;
      case "rm-clauses": { const prev = snapshot(); const ids = t.dataset.ids.split(",").map(Number); S.clauses = S.clauses.filter((c) => !ids.includes(c.id)); update();
        toast(`条件を${ids.length}つ外しました`, "元に戻す", () => { S.clauses = prev.clauses; update(); }); break; }
      case "rm-val": removeValue(id, t.dataset.v); break;
      case "alt": S.focusClause = S.focusClause === id ? null : id; S.input = ""; render(); focusInput(); break;
      case "toggle": { const c = S.clauses.find((x) => x.id === id); c.on = !c.on; update(); break; }
      case "not": { const c = S.clauses.find((x) => x.id === id); c.not = !c.not; update(); break; }
      case "pick": if (S.lens || t.closest(".detail")) { addValue(t.dataset.kind, t.dataset.v); if (!S.lens) toast(`条件「${t.dataset.v}」を加えました`); } break;
      case "pick-group": addValue(t.dataset.kind, JSON.parse(t.dataset.vs)); break;
      case "year": S.focusClause = null; addValue("year", t.dataset.v); break;
      case "recent": { const r = S.recent[Number(t.dataset.i)]; S.clauses = JSON.parse(JSON.stringify(r.snap.clauses)); S.mode = r.snap.mode; update(); break; }
      case "mode": S.mode = S.mode === "all" ? "any" : "all"; update(); break;
      case "set-mode": S.mode = t.dataset.v; update(); break;
      case "dest-list": S.destList = !S.destList; renderDock(); if (S.destList) setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "rb-menu": S.rbMenu = !S.rbMenu; renderResults(); if (S.rbMenu) setTimeout(() => $(".rb-more .menu button")?.focus()); break;
      case "sort-to": S.sort = t.dataset.v; S.rbMenu = false; update(); break;
      case "clear-all": { const prev = snapshot(); S.clauses = []; update(); toast("条件をすべて外しました", "元に戻す", () => { S.clauses = prev.clauses; S.mode = prev.mode; update(); }); break; }
      case "retry": S.sim = "ok"; update(); toast("検索を更新しました"); break;
      case "open": S.open = S.open === id ? null : id; S.active = id; S.editTags = null; renderResults(); break;
      case "add": {
        if (t.getAttribute("aria-disabled") === "true") { toast("ファイルが見つからないため追加できません"); break; }
        addTo(S.dest, [id], t); break;
      }
      case "fav": addTo("fav", [id], t); break;
      case "edit-tags": S.editTags = id; renderResults(); setTimeout(() => $("#tagEdit")?.focus()); break;
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
  // a click into the results ends condition editing on desktop
  // read the target before a handler re-renders it out of the document
  let clickInResults = false;
  document.addEventListener("click", (e) => { clickInResults = !!e.target.closest("#results"); }, true);
  document.addEventListener("click", () => {
    if (!S.lens || narrow() || !clickInResults) return;
    commitInput();
  });
  // leaving the lens keeps what was typed as the highlighted suggestion
  function commitInput() {
    const o = S.input.trim() && !S.focusClause ? sugg.out[S.sugIndex] : null;
    S.lens = false; S.focusClause = null;
    if (o) addValue(o.kind, o.value); else { S.input = ""; update(); }
  }
  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  moreBtn.addEventListener("click", () => { moreMenu.hidden = !moreMenu.hidden; moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden)); if (!moreMenu.hidden) moreMenu.querySelector("button").focus(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#moreBtn") && !e.target.closest("#moreMenu")) { moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
    if (S.rbMenu && !e.target.closest(".rb-more")) { S.rbMenu = false; renderResults(); }
  });
  $("#scrim").addEventListener("click", () => { S.dockOpen = false; render(); });
  document.addEventListener("change", (e) => { if (e.target.id === "sortSel") { S.sort = e.target.value; update(); } });
  function flash(id) { setTimeout(() => { const el = document.querySelector(`.clause[data-id="${id}"]`); if (el) { el.classList.add("is-focus"); setTimeout(() => el.classList.remove("is-focus"), 1200); } }); }
  const narrow = () => innerWidth <= 760;
  function focusInput() { const i = narrow() ? $("#lensInput") : $("#finderInput"); if (i && document.activeElement !== i) { i.focus(); const v = i.value; i.value = ""; i.value = v; } }

  function onInput(e) {
    S.input = e.target.value; S.sugIndex = 0; S.lens = true;
    compute(); renderQuery(); renderLens(); renderResults();
    if (e.target.id === "lensInput") focusInput(); // the sheet re-renders its own field
  }
  $("#finderInput").addEventListener("input", onInput);
  let quietFocus = false;
  $("#finderInput").addEventListener("focus", () => { if (!quietFocus && !narrow() && !S.lens) { S.lens = true; render(); focusInput(); } });
  $("#finderInput").addEventListener("click", () => { if (narrow()) { S.lens = true; render(); focusInput(); } });
  document.addEventListener("input", (e) => { if (e.target.id === "lensInput") onInput(e); });
  document.addEventListener("keydown", (e) => {
    const inField = e.target.matches("input");
    if (e.key === "/" && !inField) { e.preventDefault(); S.lens = true; render(); focusInput(); return; }
    if (e.target.id === "tagEdit" && e.key === "Enter" && e.target.value.trim()) {
      const s = byId.get(S.editTags); s.tags.push(e.target.value.trim()); S.editTags = null; renderResults(); toast("タグを加えました（試作のため保存しません）"); return;
    }
    if ((e.target.id === "finderInput" || e.target.id === "lensInput")) {
      const opts = [...document.querySelectorAll(".sugg")];
      if (e.key === "ArrowDown" && opts.length) { e.preventDefault(); S.sugIndex = Math.min(opts.length - 1, S.sugIndex + 1); markSugg(opts); }
      else if (e.key === "ArrowUp" && opts.length) { e.preventDefault(); S.sugIndex = Math.max(0, S.sugIndex - 1); markSugg(opts); }
      else if (e.key === "Enter" && opts.length) { e.preventDefault(); const o = opts[S.sugIndex]; addValue(o.dataset.kind, o.dataset.v); focusInput(); }
      else if (e.key === "Backspace" && !e.target.value && S.clauses.length) { removeClause(S.clauses[S.clauses.length - 1].id); focusInput(); }
      else if (e.key === "Escape") { S.lens = false; S.focusClause = null; S.input = ""; update(); e.target.blur(); }
      return;
    }
    if (e.key === "Escape") {
      if (!moreMenu.hidden) { moreMenu.hidden = true; moreBtn.focus(); }
      else if (S.rbMenu) { S.rbMenu = false; renderResults(); $('[data-act="rb-menu"]')?.focus(); }
      else if (S.dockOpen) { S.dockOpen = false; render(); $(".dest-chip")?.focus(); }
      else if (S.destList) { S.destList = false; renderDock(); $(".dock-change")?.focus(); }
      else if (S.lens) { commitInput(); quietFocus = true; $("#finderInput").focus(); quietFocus = false; }
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
  function markSugg(opts) {
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === S.sugIndex)));
    opts[S.sugIndex].scrollIntoView({ block: "nearest" });
    const inp = narrow() ? $("#lensInput") : $("#finderInput"); inp?.setAttribute("aria-activedescendant", opts[S.sugIndex].id);
    result = filter(activeClauses()).slice().sort(SORTS[S.sort][1]); renderQuery(); renderResults();
  }
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
    if (S.after) { const f = S.after; S.after = null; f(); }
    document.querySelectorAll(".demo button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === name)));
  }
  $("#demo").addEventListener("click", (e) => { const b = e.target.closest("[data-scn]"); if (b) { scenario(b.dataset.scn); history.replaceState(null, "", "#" + b.dataset.scn); } });
  const params = new URLSearchParams(location.search);
  if (params.has("capture")) document.body.classList.add("capture");
  if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");
  renderNow();
  document.fonts && document.fonts.ready.then(() => renderQuery());
  scenario(params.get("s") || location.hash.slice(1) || "base");
  window.FKP = { S, scenario, update, render };
})();
