// Overprint Liner — #173 proposal: search conditions, track detail, tag editing.
// Mock data and a mock tag service; nothing leaves the page. The rest of the
// screen (rows, navigation, playback, destinations) is the #170 base.
(function () {
  const FK = window.FK;
  const { songs, tagIndex, playlists } = FK;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $("#app");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => n.toLocaleString("ja-JP");
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const fmtSize = (b) => (b >= 1e6 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
  const INK = { blue: "var(--blue)", teal: "var(--teal)", orange: "var(--orange)", violet: "var(--violet)", pink: "var(--pink-text)" };
  const KIND_NAME = { year: "制作年", genre: "ジャンル", custom: "タグ", text: "文字", artist: "アーティスト" };
  const ICON = {
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6L21 7.4 19.6 6z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13z"/></svg>',
    heartO: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13zm0-2.8 6-5.9a2.8 2.8 0 0 0-4.6-3.3L12 9.8l-1.4-1.5a2.8 2.8 0 0 0-4.6 3.3z"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m7 9.5 5 5 5-5 1.4 1.4-6.4 6.4-6.4-6.4z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m10 5.6 1.4 1.4-4 4H20v2H7.4l4 4L10 18.4 3.6 12z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M8 5.6 9.4 7l-2.6 2.6H14a6 6 0 0 1 0 12h-3v-2h3a4 4 0 0 0 0-8H6.8l2.6 2.6L8 15.6 3 10.6z"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M16 5.6 14.6 7l2.6 2.6H10a6 6 0 0 0 0 12h3v-2h-3a4 4 0 0 1 0-8h7.2l-2.6 2.6 1.4 1.4 5-5z"/></svg>',
    select: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm2 2v3h3V6zm7 0h8v2h-8zm0 9h8v2h-8zM4 13h7v7H4zm1.6 3.4 1.4-1.4 1 1 2.4-2.4 1.4 1.4-3.8 3.8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M6 5.5 15 12l-9 6.5zM16 5h2v14h-2z"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 4h9l9 9-8 8-9-9V4zm4 2.5A1.5 1.5 0 1 0 7 9.5a1.5 1.5 0 0 0 0-3z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm13-2v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><path d="M10 3a7 7 0 0 1 5.6 11.2l5 5-1.4 1.4-5-5A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 2.5 22.5 21h-21zm-1 6.5v6h2V9zm0 8v2h2v-2z"/></svg>',
  };
  const kindMark = (kind) => `<i class="k-mark" data-kind="${kind}" aria-hidden="true"></i>`;

  // ---------------------------------------------------------------- state
  let uid = 1;
  const S = {
    clauses: [], mode: "all", input: "", lens: false, focusClause: null, sugIndex: 0,
    dest: "queue", sim: "ok", sort: "added", limit: 60,
    selectMode: false, selected: new Set(), open: null, active: null,
    recent: [], dockOpen: false, hist: [], fut: [], clauseMenu: null, expandKind: null,
    techOpen: false, tagsAll: false, keep: null, justSaved: null, ed: null,
  };
  const L = { queue: [], fri: [], work: [], anison: [], fav: [] };
  // the two hand-placed songs added for #173 sit at the front; offset by
  // them so the queue and lists hold the same songs as the #170 base
  const pickIds = (n, off) => Array.from({ length: n }, (_, i) => songs[2 + ((off + i * 131) % (songs.length - 2))].id);
  pickIds(4, 40).forEach((id) => L.queue.push({ id, auto: false }));
  pickIds(3, 900).forEach((id) => L.queue.push({ id, auto: true }));
  pickIds(23, 1200).forEach((id) => L.fri.push({ id }));
  pickIds(61, 5000).forEach((id) => L.work.push({ id }));
  pickIds(11, 7000).forEach((id) => L.anison.push({ id }));
  pickIds(140, 3000).forEach((id) => L.fav.push({ id }));
  const byId = new Map(songs.map((s) => [s.id, s]));
  const K = (k) => songs.find((s) => s.key === k);
  const nowPlaying = K("moon");
  const twinKey = (s) => s.title + "\u0000" + s.artist;
  const twinCount = new Map();
  songs.forEach((s) => twinCount.set(twinKey(s), (twinCount.get(twinKey(s)) || 0) + 1));
  const tagsArr = () => [...tagIndex.values()];
  const hashCount = () => { const m = new Map(); songs.forEach((s) => m.set(s.file.hash, (m.get(s.file.hash) || 0) + 1)); return m; };
  let sameHash = hashCount();

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
  function filter(clauses, mode = S.mode) {
    const on = clauses.filter((c) => c.on !== false);
    if (!on.length) return songs;
    return mode === "all" ? songs.filter((s) => on.every((c) => clauseMatch(c, s)))
      : songs.filter((s) => on.some((c) => clauseMatch(c, s)));
  }
  const countOf = (clauses, mode) => filter(clauses, mode).length;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // One rule decides where a picked value lands, so the suggestion can say
  // it before the pick: an open "言い換え" clause takes it as an alternative,
  // a second year joins the year as an alternative (a song has one year),
  // anything else becomes a new condition joined by the current mode.
  function placeValue(clauses, kind, values, focusId) {
    const focus = clauses.find((c) => c.id === focusId);
    if (focus && focus.kind === kind && kind !== "text") {
      values.forEach((v) => { if (!focus.values.includes(v)) focus.values.push(v); });
      return { how: "alt", into: focus };
    }
    const yc = kind === "year" && clauses.find((c) => c.kind === "year" && c.on && !c.not);
    if (yc) {
      const v = values[0];
      if (yc.values.includes(v)) { yc.values = yc.values.filter((x) => x !== v); if (!yc.values.length) clauses.splice(clauses.indexOf(yc), 1); return { how: "drop", into: yc }; }
      yc.values.push(v); return { how: "alt", into: yc };
    }
    const dup = clauses.find((c) => c.kind === kind && c.on && !c.not && c.values.length === values.length && values.every((v) => c.values.includes(v)));
    if (dup) return { how: "same", into: dup };
    const c = { id: uid++, kind, values: [...values], on: true, not: false };
    clauses.push(c);
    return { how: "new", into: c };
  }

  // While typing, the results preview the highlighted suggestion, never the
  // raw text: typing a tag's name must not empty the list on the way there.
  let sugg = { out: [], sections: [] };
  const pendingClause = () => {
    if (!S.input.trim() || !S.lens || S.focusClause) return null;
    const o = sugg.out[S.sugIndex];
    return o && o.kind !== "more" ? { kind: o.kind, values: [o.value], on: true, pending: true } : null;
  };
  function previewClauses() {
    const p = pendingClause();
    if (!p) return S.clauses;
    const cs = clone(S.clauses); placeValue(cs, p.kind, p.values, null); return cs;
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
    sugg = S.lens && S.input.trim() ? suggestions() : { out: [], sections: [] };
    if (S.sugIndex >= sugg.out.length) S.sugIndex = 0;
    result = filter(previewClauses()).slice().sort(SORTS[S.sort][1]);
    // a song whose edit made it leave the conditions stays where it was
    // until the conditions change, so saving never yanks the open row away
    if (S.keep && !result.some((s) => s.id === S.keep.id)) {
      result.splice(Math.min(S.keep.at, result.length), 0, byId.get(S.keep.id));
    }
    if (S.sim === "ok") lastGood = result;
  }

  // ---------------------------------------------------------------- suggestions
  // Grouped by kind, each group named in words: "制作年 2015" and the tag
  // "2015" never sit in one undifferentiated list.
  function suggestions() {
    const q = S.input.trim();
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const fq = fold(q);
    const per = { year: [], artist: [], genre: [], custom: [] };
    for (const t of tagsArr()) {
      if (focus && focus.kind !== t.kind) continue;
      if (focus && focus.values.includes(t.value)) continue;
      if (!t.count) continue;
      const f = fold(t.value);
      const at = f.indexOf(fq);
      if (at < 0) continue;
      per[t.kind].push({ t, f, score: (at === 0 ? 2 : 0) + (f === fq ? 3 : 0) });
    }
    if (!focus || focus.kind === "artist") {
      const arts = new Map();
      for (const s of songs) { if (s.artist && fold(s.artist).includes(fq)) arts.set(s.artist, (arts.get(s.artist) || 0) + 1); if (arts.size > 60) break; }
      [...arts.entries()].forEach(([a, n]) => per.artist.push({ t: { kind: "artist", value: a, count: n }, f: fold(a), score: fold(a).startsWith(fq) ? 2 : 0 }));
    }
    const exactKinds = Object.entries(per).filter(([, xs]) => xs.some((x) => x.f === fq)).map(([k]) => k);
    const sections = [];
    const hypoCount = (kind, values) => { const cs = clone(S.clauses); const r = placeValue(cs, kind, values, S.focusClause); return { n: countOf(cs), how: r.how, into: r.into }; };
    for (const kind of ["year", "artist", "genre", "custom"]) {
      const xs = per[kind];
      if (!xs.length) continue;
      xs.sort((a, b) => b.score - a.score || b.t.count - a.t.count);
      const groups = new Map();
      for (const x of xs) { const k = x.f; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x.t); }
      const cap = S.expandKind === kind ? 12 : kind === "custom" ? 4 : 3;
      const items = [];
      for (const [, g] of groups) {
        if (items.length >= cap) break;
        g.sort((a, b) => b.count - a.count);
        const head = g[0];
        const h = hypoCount(kind, [head.value]);
        items.push({ kind, value: head.value, total: head.count, n: h.n, how: h.how, into: h.into && h.into.values,
          variants: g.slice(1).map((v) => ({ value: v.value, total: v.count })), best: xs[0].score });
      }
      sections.push({ kind, items, total: groups.size, more: Math.max(0, groups.size - items.length), best: Math.max(...xs.map((x) => x.score)) });
    }
    sections.sort((a, b) => b.best - a.best);
    if (!focus) {
      const n = countOf([...S.clauses, { kind: "text", values: [q], on: true }]);
      const text = { kind: "text", items: [{ kind: "text", value: q, label: `「${q}」を曲名・アーティストに含む`, n, how: "new" }], total: 1, more: 0 };
      // the plain-text option leads unless some name starts with what was typed
      if (sections.some((s) => s.best >= 2)) sections.push(text); else sections.unshift(text);
    }
    const out = [];
    sections.forEach((sec) => {
      sec.items.forEach((o) => out.push(o));
      if (sec.more) out.push({ kind: "more", forKind: sec.kind, value: sec.kind, more: sec.more });
    });
    return { out, sections, ambiguous: exactKinds.length > 1 ? exactKinds : null };
  }

  // ---------------------------------------------------------------- mutations + history
  const snapshot = () => clone({ clauses: S.clauses, mode: S.mode });
  function checkpoint() { S.hist.push(snapshot()); if (S.hist.length > 50) S.hist.shift(); S.fut = []; }
  function restore(snap) { S.clauses = clone(snap.clauses); S.mode = snap.mode; S.keep = null; }
  function undo() { if (!S.hist.length) return; S.fut.push(snapshot()); restore(S.hist.pop()); S.clauseMenu = null; update(); }
  function redo() { if (!S.fut.length) return; S.hist.push(snapshot()); restore(S.fut.pop()); S.clauseMenu = null; update(); }
  function remember() {
    if (!S.clauses.length) return;
    const key = JSON.stringify([S.mode, S.clauses.map((c) => [c.kind, c.values, c.not, c.on])]);
    S.recent = S.recent.filter((r) => r.key !== key);
    S.recent.unshift({ key, snap: snapshot(), n: filter(S.clauses).length });
    S.recent = S.recent.slice(0, 4);
  }
  function mutate(fn, msg) {
    const prev = snapshot();
    checkpoint(); fn(); S.keep = null; S.clauseMenu = null;
    update(); remember();
    if (msg) toast(msg, "元に戻す", () => { restore(prev); update(); });
  }
  function addValue(kind, value) {
    const values = Array.isArray(value) ? value : [value];
    const focusId = S.focusClause;
    S.input = ""; S.sugIndex = 0; S.focusClause = null; S.open = null; S.expandKind = null;
    mutate(() => { placeValue(S.clauses, kind, values, focusId); });
  }
  const valText = (kind, v) => (kind === "year" ? v + "年" : v);
  const clauseText = (c) => c.values.map((v) => valText(c.kind, v)).join(" または ");
  function removeClause(id) {
    const c = S.clauses.find((x) => x.id === id); if (!c) return;
    mutate(() => { S.clauses = S.clauses.filter((x) => x.id !== id); if (S.focusClause === id) S.focusClause = null; }, `条件「${clauseText(c)}」を外しました`);
  }
  function removeValue(id, v) {
    const c = S.clauses.find((x) => x.id === id); if (!c) return;
    if (c.values.length === 1) return removeClause(id);
    mutate(() => { const cc = S.clauses.find((x) => x.id === id); cc.values = cc.values.filter((x) => x !== v); }, `「${valText(c.kind, v)}」を外しました`);
  }
  function addTo(destId, ids, from) {
    const d = playlists.find((p) => p.id === destId);
    const list = L[destId];
    ids = ids.filter((id) => !byId.get(id).missing);
    if (!ids.length) return;
    if (d.kind === "fav") {
      const has = new Set(list.map((x) => x.id));
      const fresh = ids.filter((id) => !has.has(id));
      if (ids.length === 1 && has.has(ids[0])) {
        const at = list.findIndex((x) => x.id === ids[0]); const [it] = list.splice(at, 1);
        render(); toast(`「${byId.get(ids[0]).title}」をお気に入りから外しました`, "元に戻す", () => { list.splice(at, 0, it); render(); });
        return;
      }
      fresh.forEach((id) => list.push({ id, fresh: true }));
      fly(from); render();
      toast(fresh.length === 1 ? `「${byId.get(fresh[0]).title}」をお気に入りに登録しました` : `${fresh.length}曲をお気に入りに登録しました`,
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

  // ---------------------------------------------------------------- render: query line
  // One printed line. Each condition is an underlined phrase with a small
  // ink mark for its kind; the kind is also written when the same value
  // exists under another kind. Desktop gives each condition its own ×.
  function ambiguousValue(kind, v) {
    if (kind === "year" || kind === "text") return false;
    return ["genre", "custom"].some((k) => k !== kind && (tagIndex.get(k + ":" + v) || {}).count);
  }
  function termLabel(c) {
    const amb = c.values.some((v) => ambiguousValue(c.kind, v));
    return (amb ? `<span class="t-kind">${KIND_NAME[c.kind]}</span>` : "") +
      c.values.map((v, i) => `${i ? '<span class="t-or">または</span>' : ""}<span class="t-label">${esc(valText(c.kind, v))}</span>`).join("");
  }
  function termHTML(c) {
    const st = c.on ? (c.not ? "（これ以外）" : "") : "（一時停止中）";
    return `<span class="term-wrap"><button class="term${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}" type="button" data-kind="${c.kind}" data-act="edit-clause" data-id="${c.id}" aria-label="${esc(KIND_NAME[c.kind] + " " + clauseText(c) + st)}。押すと条件を編集"><i class="t-mark" aria-hidden="true"></i>${termLabel(c)}${c.on ? "" : '<span class="t-state">停止中</span>'}${c.not ? '<span class="t-state">以外</span>' : ""}</button><button class="t-x" type="button" data-act="rm-clause" data-id="${c.id}" aria-label="条件「${esc(clauseText(c))}」を外す" title="この条件を外す">${ICON.x}</button></span>`;
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
      if (p) h += `${S.clauses.length ? `<span class="t-join" aria-hidden="true">${join}</span>` : ""}<span class="term-wrap"><span class="term is-ghost" data-kind="${p.kind === "artist" ? "text" : p.kind}"><i class="t-mark" aria-hidden="true"></i><span class="t-label">${esc(valText(p.kind, p.values[0]))}</span><span class="ghost-note">選択中</span></span></span>`;
      const paused = S.clauses.filter((c) => !c.on).length;
      box.innerHTML = `<div class="terms" id="terms">${h}</div>${S.clauses.length ? `<button class="sum-edit" type="button" data-act="open-lens" aria-label="条件を編集（${S.clauses.length}つ${paused ? `、うち${paused}つ一時停止中` : ""}）">編集</button>` : ""}`;
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
      const e = items.pop(); e.hidden = true; if (e.classList.contains("term-wrap")) hidden++;
      more.textContent = `ほか${hidden}つ`;
      more.setAttribute("aria-label", `ほか${hidden}つの条件を表示して編集`);
    }
    const vis = items.filter((e) => !e.hidden);
    if (vis.length && vis[vis.length - 1].classList.contains("t-join")) vis[vis.length - 1].hidden = true;
  }

  // ---------------------------------------------------------------- render: lens
  // Left: the conditions written as one sentence. Basic editing is the value
  // chips and their ×. Pausing, "これ以外" and alternatives live behind each
  // condition's ⋯, and every such choice shows the count it would give.
  function clauseRow(c, i) {
    const join = S.mode === "all" ? "かつ" : "または";
    const vals = c.values.map((v, k) => `${k ? '<span class="val-or">または</span>' : ""}<span class="val"><span>${esc(valText(c.kind, v))}</span><button type="button" data-act="rm-val" data-id="${c.id}" data-v="${esc(v)}" aria-label="「${esc(valText(c.kind, v))}」を外す">${ICON.x}</button></span>`).join("");
    const state = !c.on ? `<span class="cl-state">一時停止中・結果に使っていません</span>` : c.not ? `<span class="cl-state is-not">これを含まない曲</span>` : "";
    const open = S.clauseMenu === c.id;
    return `${i ? `<div class="cl-join" aria-hidden="true"><span>${join}</span></div>` : ""}
      <div class="cl${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}${S.focusClause === c.id ? " is-focus" : ""}" data-id="${c.id}">
        <span class="cl-kind">${kindMark(c.kind)}${KIND_NAME[c.kind]}</span>
        <span class="cl-vals">${vals}${state}</span>
        <button class="icon-btn cl-more" type="button" data-act="clause-menu" data-id="${c.id}" aria-expanded="${open}" aria-label="条件「${esc(clauseText(c))}」のほかの操作">${ICON.more}</button>
      </div>
      ${open ? trayHTML(c) : ""}`;
  }
  function trayHTML(c) {
    const others = S.clauses.filter((x) => x.id !== c.id);
    const nOff = countOf(c.on ? others : [...others, { ...c, on: true }]);
    const nNot = countOf([...others, { ...c, not: !c.not, on: true }]);
    const nRm = countOf(others);
    const opt = (act, label, sub, n) => `<button type="button" class="tray-opt" data-act="${act}" data-id="${c.id}"><span><b>${label}</b><small>${sub}</small></span><span class="tray-n">${fmtN(n)}<small>曲</small></span></button>`;
    return `<div class="tray" role="group" aria-label="条件「${esc(clauseText(c))}」の操作">
      ${c.kind !== "text" ? `<button type="button" class="tray-opt" data-act="alt" data-id="${c.id}"><span><b>${S.focusClause === c.id ? "足す値を選んでいます" : "別の値も含める"}</b><small>表記違いなど。どれかに一致すれば残ります</small></span><span class="tray-n">${ICON.plus}</span></button>` : ""}
      ${opt("toggle", c.on ? "一時停止する" : "再開する", c.on ? "残したまま、結果には使いません" : "結果に戻します", nOff)}
      ${opt("not", c.not ? "これを含む曲に戻す" : "これを含まない曲にする", c.not ? "元の向きに戻します" : "付いていない曲だけにします", nNot)}
      ${opt("rm-clause", "この条件を外す", "取り消しで戻せます", nRm)}
    </div>`;
  }
  function renderLens() {
    const el = $("#lens");
    el.hidden = !S.lens;
    if (!S.lens) return;
    el.classList.toggle("is-typing", !!S.input.trim());
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const on = S.clauses.filter((c) => c.on);
    const sentence = !S.clauses.length ? "" : on.length < 2 ? "次の条件に当てはまる曲" : S.mode === "all" ? "次の条件に<b>すべて</b>当てはまる曲" : "次の条件の<b>どれか</b>に当てはまる曲";
    const hist = `<span class="hist"><button class="icon-btn" type="button" data-act="undo" ${S.hist.length ? "" : "disabled"} aria-label="条件の変更を一つ戻す" title="一つ戻す（Ctrl+Z）">${ICON.undo}</button><button class="icon-btn" type="button" data-act="redo" ${S.fut.length ? "" : "disabled"} aria-label="戻した変更をやり直す" title="やり直す">${ICON.redo}</button></span>`;
    const modeBlock = on.length >= 2 ? `<div class="mode" role="radiogroup" aria-label="条件の組み方">
        <span class="mode-h">条件の組み方</span>
        <button type="button" role="radio" data-act="set-mode" data-v="all" aria-checked="${S.mode === "all"}"><i></i><span>すべてに当てはまる</span><b>${fmtN(countOf(S.clauses, "all"))}曲</b></button>
        <button type="button" role="radio" data-act="set-mode" data-v="any" aria-checked="${S.mode === "any"}"><i></i><span>どれかに当てはまる</span><b>${fmtN(countOf(S.clauses, "any"))}曲</b></button>
      </div>` : "";
    const left = `
      <section class="sent">
        <h2 class="lens-h"><span>${S.clauses.length ? sentence : "条件"}</span>${hist}</h2>
        ${S.clauses.length ? S.clauses.map(clauseRow).join("") : '<p class="lens-empty">まだ条件はありません。上の欄に入力するか、右から選んでください。</p>'}
        ${modeBlock}
      </section>
      ${S.recent.length ? `<section><h2>最近の条件</h2><div class="recent">${S.recent.map((r, i) => `<button type="button" data-act="recent" data-i="${i}"><span class="r-terms">${esc(r.snap.clauses.map(clauseText).join(r.snap.mode === "all" ? " かつ " : " または "))}</span><span class="r-n">${fmtN(r.n)}曲</span></button>`).join("")}</div></section>` : ""}`;
    let right;
    if (S.sim === "error") {
      right = `<section><h2>候補を読み込めませんでした</h2><p class="lens-empty">タグの一覧を読めないため、候補と件数を出せません。曲名とアーティストの検索は使えます。</p><button class="btn" type="button" data-act="retry">再試行</button></section>`;
    } else if (S.input.trim()) {
      right = suggHTML(focus);
    } else {
      right = browseHTML(focus);
    }
    const head = `<div class="lens-head"><button class="icon-btn" type="button" data-act="close-lens" aria-label="条件の編集を閉じる">${ICON.back}</button>
      <label class="finder-field"><input id="lensInput" type="search" autocomplete="off" value="${esc(S.input)}" placeholder="タグ・年・曲名を入力" aria-label="タグ・年・曲名を入力" role="combobox" aria-expanded="true" aria-controls="suggList"></label></div>`;
    const foot = `<div class="lens-foot"><span class="lens-foot-note">条件を編集中・Esc で閉じる</span><button class="btn" type="button" data-act="clear-all" ${S.clauses.length ? "" : "disabled"}>すべて外す</button><button class="btn primary" type="button" data-act="close-lens">${S.sim === "loading" ? "照合中…" : fmtN(result.length) + "曲を表示"}</button></div>`;
    el.innerHTML = head + `<div class="lens-col clauses">${left}</div><div class="lens-col lens-cands">${right}</div>` + foot;
    // narrow: the year strip scrolls; bring the chosen (or latest) year into view
    const ys = el.querySelector(".years");
    if (ys && ys.scrollWidth > ys.clientWidth) { const on = ys.querySelector('[aria-pressed="true"]') || ys.lastElementChild; ys.scrollLeft = on.offsetLeft - ys.clientWidth / 2 + on.offsetWidth / 2; }
  }
  function hl(text) {
    const q = S.input.trim(); if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function suggHTML(focus) {
    const { sections, ambiguous } = sugg;
    let idx = 0;
    const amb = ambiguous ? `<p class="amb" role="note">「${esc(S.input.trim())}」は${ambiguous.map((k) => `<b>${KIND_NAME[k]}</b>`).join("と")}の両方にあります。種類を見て選んでください。</p>` : "";
    const secHTML = sections.map((sec) => {
      const head = `<li class="sugg-h" role="presentation">${kindMark(sec.kind)}<span>${sec.kind === "text" ? "曲名・アーティストの文字" : KIND_NAME[sec.kind]}</span>${sec.kind !== "text" ? `<small>${fmtN(sec.total)}件</small>` : ""}</li>`;
      const items = sec.items.map((o) => optHTML(o, idx++)).join("");
      const more = sec.more ? `<li class="sugg sugg-more" role="option" id="sg${idx}" aria-selected="${idx++ === S.sugIndex}" data-act="more-kind" data-kind="${sec.kind}">${KIND_NAME[sec.kind]}をあと${fmtN(sec.more)}件見る</li>` : "";
      return head + items + more;
    }).join("");
    return `<section><h2>${focus ? `「${esc(clauseText(focus))}」に足す値（どれか一つに一致）` : "候補"}</h2>${amb}
      <ul class="sugg-list" role="listbox" id="suggList" aria-label="候補">${secHTML}</ul>
      ${!sugg.out.length ? `<p class="lens-empty">「${esc(S.input)}」に一致するものはありません。</p>` : ""}</section>`;
  }
  function optHTML(o, i) {
    const dead = o.n === 0;
    const sub = o.kind === "text" ? "入力した文字で絞り込む" : o.kind === "artist" ? `${fmtN(o.total)}曲` : `ライブラリ全体で${fmtN(o.total)}曲`;
    // say how the pick will join before it is picked
    const how = o.how === "alt" ? `<span class="how">「${esc(o.into.map((v) => valText(o.kind, v)).join("・"))}」<em>または</em>で加わる</span>`
      : o.how === "drop" ? `<span class="how">選択中・押すと外す</span>`
      : o.how === "same" ? `<span class="how">条件にあります</span>`
      : S.clauses.length ? `<span class="how"><em>${S.mode === "all" ? "かつ" : "または"}</em>で加わる</span>` : "";
    const n = dead ? "0曲になる" : `<b>${fmtN(o.n)}</b>曲になる`;
    let h = `<li class="sugg${dead ? " is-dead" : ""}" role="option" id="sg${i}" aria-selected="${i === S.sugIndex}" data-act="pick" data-kind="${o.kind}" data-v="${esc(o.value)}" aria-label="${esc((o.kind === "text" ? o.label : KIND_NAME[o.kind] + " " + valText(o.kind, o.value)) + "、" + (dead ? "0曲" : fmtN(o.n) + "曲") + "になる")}">
      <span class="sugg-main"><span class="sugg-name">${o.kind === "text" ? esc(o.label) : hl(valText(o.kind, o.value))}</span><span class="sugg-sub">${sub}${how}</span></span>
      <span class="sugg-n">${n}</span></li>`;
    if (o.variants && o.variants.length) {
      h += `<li class="sugg-variants" role="presentation"><span>似た表記</span>${o.variants.map((v) => `<span class="var">${esc(v.value)}<small>（${fmtN(v.total)}曲）</small></span>`).join("")}
        <button type="button" data-act="pick-group" data-kind="${o.kind}" data-vs="${esc(JSON.stringify([o.value, ...o.variants.map((v) => v.value)]))}">表記違いもまとめて含める</button></li>`;
    }
    return h;
  }
  function browseHTML(focus) {
    const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
    const yBase = filter(S.clauses.filter((c) => c !== yc));
    const yc2 = new Map(); yBase.forEach((s) => s.year && yc2.set(s.year, (yc2.get(s.year) || 0) + 1));
    const max = Math.max(1, ...yc2.values());
    let years = "";
    for (let y = 2008; y <= 2026; y++) {
      const n = yc2.get(y) || 0; const on = yc && yc.values.includes(String(y));
      years += `<button class="year-bar" type="button" data-act="year" data-v="${y}" aria-pressed="${!!on}" aria-label="${y}年 ${fmtN(n)}曲"><i style="height:${Math.max(2, (n / max) * 70)}px"></i><span>${String(y).slice(2)}</span></button>`;
    }
    const base = filter(S.clauses);
    const gc = new Map(), tc = new Map();
    base.forEach((s) => { s.genres.forEach((g) => gc.set(g, (gc.get(g) || 0) + 1)); s.tags.forEach((t) => tc.set(t, (tc.get(t) || 0) + 1)); });
    const used = new Set(S.clauses.flatMap((c) => c.values.map((v) => c.kind + ":" + v)));
    const top = (m, kind, k) => [...m.entries()].filter(([v]) => !used.has(kind + ":" + v)).sort((a, b) => b[1] - a[1]).slice(0, k);
    const chip = (kind) => ([v, n]) => `<button class="chip" type="button" data-kind="${kind}" data-act="pick" data-v="${esc(v)}" aria-label="${KIND_NAME[kind]} ${esc(v)}、${fmtN(n)}曲"><span>${esc(v)}</span><span class="n">${fmtN(n)}</span></button>`;
    const onlyKind = focus ? focus.kind : null;
    return `
      ${!onlyKind || onlyKind === "year" ? `<section><h2>${kindMark("year")}制作年 <span class="aside">棒は${S.clauses.length ? "いまの条件での" : ""}曲数。2つ以上の年は「または」で加わります</span></h2><div class="years">${years}</div><p class="years-note">${fmtN(yBase.filter((s) => !s.year).length)}曲は制作年が未設定です</p></section>` : ""}
      ${!onlyKind || onlyKind === "genre" ? `<section><h2>${kindMark("genre")}ジャンル <span class="aside">いまの結果に多い順</span></h2><div class="chips">${top(gc, "genre", 8).map(chip("genre")).join("")}</div></section>` : ""}
      ${!onlyKind || onlyKind === "custom" ? `<section><h2>${kindMark("custom")}タグ <span class="aside">いまの結果に多い順。全${fmtN(tagsArr().filter((t) => t.kind === "custom").length)}件は入力で探せます</span></h2><div class="chips">${top(tc, "custom", 12).map(chip("custom")).join("")}</div></section>` : ""}`;
  }

  // ---------------------------------------------------------------- render: rows (base)
  function splitTitle(t) {
    const m = t.match(/^(.*?)(\s*[\(（〜~].*)$/);
    return m && m[1] ? [m[1], m[2]] : [t, ""];
  }
  const displayTitle = (s) => (s.untitled ? `${s.title}.${s.fmt.toLowerCase()}` : s.title);
  function rowHTML(s) {
    const d = playlists.find((p) => p.id === S.dest);
    const inDest = L[S.dest].filter((x) => x.id === s.id).length;
    const isFav = d.kind === "fav";
    const playing = s.id === nowPlaying.id;
    const [main, mix] = splitTitle(s.title);
    const act = S.clauses.filter((c) => c.on && !c.not);
    const hits = S.mode === "any" ? act.flatMap((c) => c.values.filter((v) => clauseMatch({ ...c, values: [v], not: false }, s)).map((v) => valText(c.kind, v))) : [];
    const twins = twinCount.get(twinKey(s)) || 1;
    const open = S.open === s.id;
    const justAdded = S.lastAdded && S.lastAdded.id === s.id && S.lastAdded.dest === S.dest;
    const kept = S.keep && S.keep.id === s.id && !filter(S.clauses).includes(s);
    let state = "";
    if (s.missing) state = '<span class="st bad">ファイルなし</span>';
    else if (kept) state = '<span class="st kept">いまの条件から外れました</span>';
    else if (justAdded && !isFav) state = `<span class="st in">✓ ${esc(d.name)}の${S.lastAdded.pos}番目</span>`;
    else if (inDest) state = `<span class="st in">${isFav ? "♥ 登録済み" : `✓ ${esc(d.name)}にあり`}</span>`;
    const title = s.untitled ? `<span class="row-title is-untitled">${esc(displayTitle(s))}</span>` : `<span class="row-title">${esc(main)}${mix ? `<span class="mix">${esc(mix)}</span>` : ""}</span>`;
    const addLabel = s.missing ? `「${s.title}」はファイルが見つからないため追加できません` : isFav ? (inDest ? `「${s.title}」をお気に入りから外す` : `「${s.title}」をお気に入りに登録`) : `「${s.title}」を${d.name}に追加`;
    const addIcon = isFav ? (inDest ? ICON.heart : ICON.heartO) : justAdded ? ICON.check : ICON.plus;
    const sel = S.selected.has(s.id);
    const name = displayTitle(s) + "、" + (s.artist || "アーティスト情報なし") + (playing ? "、再生中" : "");
    return `<li class="row${open ? " is-open" : ""}${S.selectMode ? " is-select" : ""}${S.active === s.id ? " is-active" : ""}${playing ? " is-playing" : ""}${kept ? " is-kept" : ""}" data-id="${s.id}" style="--dest:${INK[d.ink]}">
      ${S.selectMode ? `<button class="row-check" type="button" role="checkbox" aria-checked="${sel}" data-act="sel" data-id="${s.id}" aria-label="「${esc(s.title)}」を選択"><i></i></button>` : ""}
      <span class="row-mark" aria-hidden="true">${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</span>
      <button class="row-main" type="button" data-act="open" data-id="${s.id}" aria-expanded="${open}" aria-label="${esc(name)}。詳細">
        ${title}
        <span class="row-sub">
          <span class="row-artist${s.artist ? "" : " is-missing"}">${esc(s.artist || "アーティスト情報なし")}</span>
          ${twins > 1 ? `<span class="row-twin" title="同じ曲名とアーティストのファイルが${twins}件あります">${s.fmt}・同名${twins}件</span>` : ""}
          <span class="narrow-meta">${s.year || "年なし"}・${fmtDur(s.dur)}</span>
          ${state}
          ${hits.length ? `<span class="row-why">${hits.map((t) => `<span class="hit">${esc(t)}</span>`).join("")}</span>` : ""}
        </span>
      </button>
      <span class="row-meta">${s.year ? s.year : '<span title="制作年が未設定">—</span>'}<span class="dur">${fmtDur(s.dur)}</span></span>
      <button class="add${inDest && isFav ? " is-done" : ""}${justAdded ? " is-just" : ""}${isFav ? " is-fav" : ""}" type="button" data-act="add" data-id="${s.id}" aria-label="${esc(addLabel)}" ${s.missing ? 'aria-disabled="true"' : ""} title="${esc(addLabel)}"><i>${addIcon}</i></button>
      ${open ? detailHTML(s) : ""}
    </li>`;
  }

  // ---------------------------------------------------------------- render: detail
  // Liner notes for one track. First layer: what you need to listen and
  // decide. Second layer, folded: where the file is and how its metadata
  // was read. Nothing technical is dropped; it is one press away.
  const YEAR_SRC = {
    auto: "ファイルの日付から", manual: "自分で指定", unset: "年なしに指定",
    missing: "ファイルに日付がありません", invalid: "ファイルの日付が読めません", future: "ファイルの日付が未来です", conflict: "ファイルの日付が食い違っています",
  };
  const SEM_NAME = { recording: "録音日", generic: "日付", release: "発売日", original: "元の発売日" };
  function yearDiag(s) {
    const st = s.auto.status;
    if (st === "resolved") return null;
    const c = s.file.embedded.candidates.filter((x) => x.semantic !== "original").sort((a, b) => a.rank - b.rank)[0];
    if (st === "missing") return "ファイルに、自動で使える日付がありません。";
    if (st === "invalid") return `${c.raw_key} の値「${c.raw_value}」は年として読めません。`;
    if (st === "future") return `${c.raw_key} の年「${c.raw_value}」は未来の年なので使いません。`;
    if (st === "conflict") return `${c.raw_key} に異なる年（${String(c.raw_value).split("\n").join("、")}）が入っていて、どれか決められません。`;
    return null;
  }
  function detailHTML(s) {
    const d = playlists.find((p) => p.id === S.dest);
    const twins = songs.filter((x) => twinKey(x) === twinKey(s));
    const fav = L.fav.some((x) => x.id === s.id);
    const [, mixRaw] = splitTitle(s.title);
    const mix = mixRaw.trim().replace(/^[(（](.*)[)）]$/, "$1");
    const eff = FK.effective(s);
    const saved = S.justSaved && S.justSaved.hash === s.file.hash ? S.justSaved.keys : null;
    const chip = (t) => `<button class="chip tchip${saved && saved.has(t.key) ? " is-saved" : ""}" type="button" data-act="pick" data-kind="${t.kind}" data-v="${esc(t.value)}" aria-label="${KIND_NAME[t.kind]}「${esc(t.value)}」で絞り込む"><span>${esc(t.value)}</span></button>`;
    const genres = eff.filter((t) => t.kind === "genre");
    const tags = eff.filter((t) => t.kind === "custom");
    const TAG_CAP = 8;
    const tagsShown = S.tagsAll ? tags : tags.slice(0, TAG_CAP);
    const inQueue = L.queue.findIndex((x) => x.id === s.id);
    const status = [];
    if (s.id === nowPlaying.id) status.push("再生中");
    if (inQueue >= 0) status.push(`再生待ちの${inQueue + 1}番目`);
    if (fav) status.push("お気に入り");
    status.push(`再生 ${s.plays}回`);
    const yearLine = s.year ? `<b>${s.year}年</b>` : "<b>未設定</b>";
    const diag = yearDiag(s);
    const ys = YEAR_SRC[s.yearStatus];
    const hashN = sameHash.get(s.file.hash) || 1;
    return `<div class="detail" role="region" aria-label="「${esc(displayTitle(s))}」の詳細">
      <div class="dt-credits">
        <dl class="credits">
          ${mix ? `<dt>版</dt><dd>${esc(mix)}</dd>` : ""}
          <dt>アーティスト</dt><dd>${s.artist ? esc(s.artist) : '<span class="muted">情報なし（ファイルにアーティストが入っていません）</span>'}</dd>
          <dt>長さ</dt><dd>${fmtDur(s.dur)}<span class="muted">　${s.fmt}</span></dd>
          <dt>制作年</dt><dd>${yearLine}<span class="muted">　${ys}${s.yearStatus === "manual" && diag ? "（ファイルの日付は使えません）" : ""}</span></dd>
          <dt>${kindMark("genre")}ジャンル</dt><dd><div class="detail-tags">${genres.map(chip).join("") || '<span class="muted">なし</span>'}</div></dd>
          <dt>${kindMark("custom")}タグ</dt><dd><div class="detail-tags">${tagsShown.map(chip).join("") || '<span class="muted">なし</span>'}${tags.length > TAG_CAP ? `<button class="chip more-chip" type="button" data-act="tags-all" aria-expanded="${S.tagsAll}">${S.tagsAll ? "少なく表示" : `ほか${tags.length - TAG_CAP}件`}</button>` : ""}</div></dd>
          <dt>状態</dt><dd>${status.join("・")}</dd>
        </dl>
        <p class="note">ジャンルやタグを押すと、それで絞り込みます</p>
      </div>
      <div class="dt-side">
        <div class="detail-actions">
          ${s.missing ? `<p class="dt-bad">ファイルが見つからないため、追加とタグの編集ができません。ライブラリの再読み込みで元の場所に戻ると使えるようになります。</p>` :
          `${d.kind !== "fav" ? `<button class="btn primary" type="button" data-act="add" data-id="${s.id}">${ICON.plus}${esc(d.name)}に追加</button>` : ""}
          <button class="btn" type="button" data-act="edit-tags" data-id="${s.id}">${ICON.tag}タグを編集</button>
          <button class="btn" type="button" data-act="fav" data-id="${s.id}" aria-pressed="${fav}">${fav ? ICON.heart : ICON.heartO}${fav ? "お気に入り登録済み" : "お気に入り"}</button>
          <button class="btn" type="button" data-act="open-dock">${ICON.list}ほかの追加先へ</button>`}
        </div>
        ${twins.length > 1 ? `<div class="twins"><p class="note">同じ曲名とアーティストのファイルが${twins.length}件あります。形式と場所で見分けられます。</p>
          ${twins.map((t) => `<div class="twin${t.id === s.id ? " is-this" : ""}"><div><b>${t.fmt}</b>　${fmtDur(t.dur)}　再生${t.plays}回${t.id === s.id ? '<span class="this">この行</span>' : ""}${t.id !== s.id && t.file.hash === s.file.hash ? '<span class="same">中身が同じ・タグを共有</span>' : ""}<div class="path">${esc(t.folder)}</div></div>
          ${t.missing ? "" : `<button class="add" type="button" data-act="add" data-id="${t.id}" aria-label="${t.fmt}・${esc(t.folder)}のファイルを${esc(d.name)}に追加" style="--dest:${INK[d.ink]}"><i>${ICON.plus}</i></button>`}</div>`).join("")}</div>` : ""}
      </div>
      <details class="tech" ${S.techOpen ? "open" : ""}>
        <summary><span>ファイルと技術情報</span><small>場所・識別・埋め込み情報・制作年の決め方</small></summary>
        <div class="tech-body">
          <dl class="tech-dl">
            <dt>場所</dt><dd class="mono sel">${esc(s.file.path)}</dd>
            <dt>形式と大きさ</dt><dd>${s.fmt}・${fmtSize(s.file.size)}・更新 ${s.file.mtime}</dd>
            <dt>内容の識別</dt><dd><span class="mono">${s.file.hash}</span><span class="muted">　${hashN > 1 ? `中身が同じファイルが${hashN}件あり、自分で付けたタグを共有します` : "タグはこの内容に結び付きます。ファイル名を変えても残ります"}</span></dd>
            <dt>読み込み</dt><dd>${s.missing ? '<span class="bad">ファイルが見つかりません</span>' : "完了"}</dd>
          </dl>
          <h4>ファイルに埋め込まれた情報<small>読み取るだけで、書き換えません</small></h4>
          <table class="raw"><thead><tr><th scope="col">項目</th><th scope="col">値</th></tr></thead><tbody>
            ${s.file.embedded.fields.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v).replace(/\n/g, '<span class="nl">↵</span>')}</td></tr>`).join("") || '<tr><td colspan="2" class="muted">埋め込まれた情報はありません</td></tr>'}
          </tbody></table>
          <h4>制作年の決め方</h4>
          <ol class="cands">${s.file.embedded.candidates.map((c) => `<li><span class="mono">${esc(c.raw_key)}</span> ${esc(String(c.raw_value).replace(/\n/g, "・"))}<span class="muted">　${SEM_NAME[c.semantic]}${c.semantic === "original" ? "（自動では使いません）" : `・優先${c.rank + 1}`}</span></li>`).join("") || '<li class="muted">日付の項目はありません</li>'}</ol>
          <p class="cand-result">自動の判定：${s.auto.status === "resolved" ? `${s.auto.year}年` : YEAR_SRC[s.auto.status]}${diag ? `<span class="muted">　${esc(diag)}</span>` : ""}<br>使っている年：${s.year ? s.year + "年" : "なし"}（${ys}）</p>
        </div>
      </details>
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
        <button class="rb-btn rb-tagedit" type="button" data-act="edit-batch" ${S.selected.size ? "" : "disabled"}>${ICON.tag}タグを編集</button>
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
    if (!list.length) { rows.innerHTML = ""; empty.hidden = false; empty.innerHTML = emptyHTML(); return; }
    empty.hidden = true;
    rows.innerHTML = list.slice(0, S.limit).map(rowHTML).join("");
  }
  function emptyHTML() {
    const act = S.clauses.filter((c) => c.on);
    const without = (xs) => countOf(S.clauses.filter((c) => !xs.includes(c)));
    const relax = act.map((c) => ({ cs: [c], n: without([c]) })).sort((a, b) => b.n - a.n);
    let pairs = [];
    if (relax.length > 2 && relax[0].n === 0) {
      for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) pairs.push({ cs: [act[i], act[j]], n: without([act[i], act[j]]) });
      pairs = pairs.filter((p) => p.n).sort((a, b) => b.n - a.n).slice(0, 3);
    }
    const opt = ({ cs, n }) => `<button type="button" data-act="rm-clauses" data-ids="${cs.map((c) => c.id).join(",")}"><span class="what">${cs.map((c) => `<s>${esc(clauseText(c))}</s>`).join(" と ")} を外す</span><span class="n">${fmtN(n)}</span>曲</button>`;
    return `<h3>${act.length}つの条件すべてに一致する曲はありません</h3>
      <p>${pairs.length ? "一つ外すだけでは見つかりません。二つ外すと次の件数になります。" : "どれか一つを外すと、次の件数になります。"}</p>
      <div class="relax">${(pairs.length ? pairs : relax).map(opt).join("")}</div>
      ${S.mode === "all" ? `<p style="margin-top:14px"><button class="btn" type="button" data-act="mode">どれかに一致する曲にする（${fmtN(countOf(act, "any"))}曲）</button></p>` : ""}`;
  }

  // ---------------------------------------------------------------- render: dock + now (base)
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
    } else { const shown = list.slice(-10); tailHTML = tail(shown, list.length - shown.length + 1); }
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

  // ================================================================ tag service (mock)
  // Same request/response/error shapes as update_track_tags. The music
  // files are frozen objects: the service can only write the manual store.
  const SVC = { rev: 1, gen: 1, nextFail: null, writes: 0 };
  const revision = () => `r${SVC.rev}`;
  const tagKey = (t) => t.kind + ":" + t.value;
  function applyPatch(rec, patch) {
    const r = clone(rec);
    if (patch.year_change) r.year = clone(patch.year_change);
    (patch.add || []).forEach((t) => {
      const k = tagKey(t);
      if (r.sup.some((x) => tagKey(x) === k)) r.sup = r.sup.filter((x) => tagKey(x) !== k);
      else if (!r.add.some((x) => tagKey(x) === k)) r.add.push(clone(t));
    });
    return r;
  }
  function applyRemoves(rec, patch, embeddedGenres) {
    const r = rec;
    (patch.remove || []).forEach((t) => {
      const k = tagKey(t);
      r.add = r.add.filter((x) => tagKey(x) !== k);
      // removing an automatic tag excludes it; the file is not touched
      if (t.kind === "genre" && embeddedGenres.includes(t.value) && !r.sup.some((x) => tagKey(x) === k)) r.sup.push(clone(t));
    });
    // an added value that is embedded needs no manual addition
    r.add = r.add.filter((x) => !(x.kind === "genre" && embeddedGenres.includes(x.value) && !r.sup.some((y) => tagKey(y) === tagKey(x))));
    return r;
  }
  const byPath = () => new Map(songs.map((s) => [s.file.path, s]));
  function svcUpdate(req) {
    return new Promise((resolve, reject) => setTimeout(() => {
      const fail = SVC.nextFail; SVC.nextFail = null; renderDemo();
      if (fail === "stale_revision") { otherSessionEdit(); }
      if (fail && fail !== "stale_revision") return reject({ code: fail });
      const paths = byPath();
      const tracks = [];
      for (const t of req.targets) {
        const s = paths.get(t.path);
        if (!s || s.missing) return reject({ code: "identity_unavailable" });
        if (s.file.hash !== t.expected_hash) return reject({ code: "identity_changed", path: t.path, now: s.file.hash });
        tracks.push(s);
      }
      if (req.expected_revision !== revision()) return reject({ code: "stale_revision" });
      const y = req.patch.year_change;
      if (y && y.mode === "set" && !(Number.isInteger(y.value) && y.value >= 1000 && y.value <= 9999)) return reject({ code: "invalid_input" });
      const hashes = [...new Set(tracks.map((s) => s.file.hash))];
      let changed = 0, noop = 0;
      for (const h of hashes) {
        const s = tracks.find((x) => x.file.hash === h);
        const before = FK.manual.get(h);
        const after = applyRemoves(applyPatch(before, req.patch), req.patch, [...s.file.embedded.genres]);
        if (JSON.stringify(after) === JSON.stringify(before)) noop++;
        else { FK.manual.set(h, after); changed++; }
      }
      if (changed) {
        SVC.rev++; SVC.gen++; SVC.writes++;
        songs.forEach((s) => { if (hashes.includes(s.file.hash)) FK.applyEffective(s); });
        FK.reindex();
      }
      resolve({ snapshot: { revision: revision() }, changed, no_op: noop });
    }, 420));
  }
  // demo: the same track edited from another window
  function otherSessionEdit() {
    const ed = S.ed;
    const s = ed ? byId.get(ed.targets[0].id) : K("after-mp3");
    const rec = FK.manual.get(s.file.hash);
    if (!rec.add.some((t) => t.value === "コール入り")) rec.add.push({ kind: "custom", value: "コール入り" });
    else rec.add.push({ kind: "custom", value: "サビ早い" });
    SVC.rev++; SVC.gen++;
    songs.forEach((x) => { if (x.file.hash === s.file.hash) FK.applyEffective(x); });
    FK.reindex();
  }
  // demo: an outside tool rewrote the file; the scan sees a new content hash
  function replaceFile() {
    const s = S.ed ? byId.get(S.ed.targets[0].id) : K("after-mp3");
    const old = s.file;
    const nh = "7a10" + old.hash.slice(4).split("").reverse().join("");
    s.file = Object.freeze({ ...old, hash: nh, size: old.size + 2048, mtime: "2026-11-23" });
    FK.manual.set(nh, { year: { mode: "auto" }, add: [], sup: [] });
    FK.applyEffective(s); FK.reindex();
    SVC.rev++; sameHash = hashCount();
  }
  function scan() { SVC.rev++; }

  // ================================================================ editor
  // One editor for one track and for a selection. It fixes its targets,
  // their content hashes and the revision when it opens; the draft is a
  // patch (add / remove / year), never a replacement of the whole set.
  function targetsFor(ids) {
    return ids.map((id) => byId.get(id)).map((s) => ({ id: s.id, path: s.file.path, hash: s.file.hash }));
  }
  function baseState(targets) {
    // what each target looks like now (for presence and the "before" side)
    return targets.map((t) => { const s = byId.get(t.id); return { id: t.id, hash: t.hash, eff: FK.effective(s), rec: clone(FK.manual.get(t.hash)), auto: s.auto, embedded: [...s.file.embedded.genres] }; });
  }
  function openEditor(ids, opener, extra = {}) {
    const targets = targetsFor(ids);
    S.ed = Object.assign({
      batch: ids.length > 1 || !!extra.batch, targets, rev: revision(), base: baseState(targets),
      add: [], remove: [], year: null, yearOpen: false, yearInput: "", q: "", sugIndex: 0,
      showTargets: false, showChanges: false, err: null, saving: false, notice: null, ref: null, opener,
      excluded: extra.excluded || null, reloaded: null, folds: new Set(),
    }, extra);
    delete S.ed.batchFlag;
    $("#editor").hidden = false;
    app.inert = true;
    renderEditor(true);
    $("#edInput").focus();
  }
  function closeEditor(how) {
    const ed = S.ed; if (!ed || ed.saving) return;
    const dirty = isDirty(ed);
    S.ed = null;
    $("#editor").hidden = true; $("#editor").innerHTML = "";
    app.inert = false;
    render();
    const back = ed.opener && document.querySelector(ed.opener);
    quietFocus = true; (back || $("#finderInput")).focus(); quietFocus = false;
    if (how !== "saved" && dirty) toast("タグの下書きを捨てました", "下書きに戻る", () => { S.ed = ed; $("#editor").hidden = false; app.inert = true; renderEditor(true); setTimeout(() => $("#edInput")?.focus()); });
  }
  const isDirty = (ed) => !!(ed.add.length || ed.remove.length || ed.year);
  // presence of a tag across the targets, counted by rows
  function presence(ed) {
    const m = new Map();
    ed.base.forEach((b) => b.eff.filter((t) => t.kind !== "year").forEach((t) => {
      const e = m.get(t.key) || { key: t.key, kind: t.kind, value: t.value, n: 0, origins: new Set() };
      e.n++; e.origins.add(t.origin); m.set(t.key, e);
    }));
    return m;
  }
  function suppressedOf(ed) {
    if (ed.batch) return [];
    return ed.base[0].rec.sup.filter((t) => !ed.add.some((a) => tagKey(a) === tagKey(t)));
  }
  function edAdd(t) {
    const ed = S.ed; const k = tagKey(t);
    if (ed.remove.some((x) => tagKey(x) === k)) ed.remove = ed.remove.filter((x) => tagKey(x) !== k);
    else if (!ed.add.some((x) => tagKey(x) === k)) ed.add.push(t);
  }
  function edRemove(t) {
    const ed = S.ed; const k = tagKey(t);
    if (ed.add.some((x) => tagKey(x) === k)) ed.add = ed.add.filter((x) => tagKey(x) !== k);
    else if (!ed.remove.some((x) => tagKey(x) === k)) ed.remove.push(t);
  }
  function edSuggestions(ed) {
    const q = ed.q.trim(); if (!q) return [];
    const fq = fold(q);
    const pres = presence(ed);
    const total = ed.targets.length;
    const out = [];
    for (const t of tagsArr()) {
      if (t.kind === "year") continue;
      const p = pres.get(t.key);
      if (p && p.n === total && !ed.remove.some((x) => tagKey(x) === t.key)) continue;
      if (ed.add.some((x) => tagKey(x) === t.key)) continue;
      const f = fold(t.value); const at = f.indexOf(fq); if (at < 0) continue;
      out.push({ kind: t.kind, value: t.value, count: t.count, score: (f === fq ? 3 : 0) + (at === 0 ? 2 : 0) });
    }
    out.sort((a, b) => b.score - a.score || b.count - a.count);
    const top = out.slice(0, 7);
    const exact = (kind) => tagsArr().some((t) => t.kind === kind && t.value === q);
    if (!exact("custom") && !ed.add.some((x) => x.kind === "custom" && x.value === q)) top.push({ kind: "custom", value: q, create: true });
    if (!exact("genre") && !ed.add.some((x) => x.kind === "genre" && x.value === q)) top.push({ kind: "genre", value: q, create: true });
    return top;
  }
  function yearNow(b) {
    // the effective year of one target before the draft
    const y = b.eff.find((t) => t.kind === "year");
    return y ? Number(y.value) : null;
  }
  function yearAfter(ed, b) {
    const y = ed.year;
    if (!y) return yearNow(b);
    if (y.mode === "set") return y.value;
    if (y.mode === "unset") return null;
    return b.auto.year;
  }
  function changeList(ed) {
    const items = [];
    if (ed.year) {
      const label = ed.year.mode === "set" ? `${ed.year.value}年に指定` : ed.year.mode === "unset" ? "年なしに指定" : "ファイルの日付に任せる";
      items.push({ type: "year", sign: "年", text: `制作年を${label}`, act: "ed-year-reset" });
    }
    ed.add.forEach((t) => items.push({ type: "add", sign: "＋", text: `${KIND_NAME[t.kind]}「${t.value}」を付ける`, key: tagKey(t) }));
    ed.remove.forEach((t) => items.push({ type: "rm", sign: "−", text: `${KIND_NAME[t.kind]}「${t.value}」を外す`, key: tagKey(t) }));
    return items;
  }

  function renderEditor(first) {
    const ed = S.ed; const host = $("#editor");
    if (!ed) return;
    const total = ed.targets.length;
    const hashes = new Set(ed.targets.map((t) => t.hash));
    const s0 = byId.get(ed.targets[0].id);
    if (first) {
      host.innerHTML = `<div class="ed-scrim" data-act="ed-close"></div>
        <section class="ed" role="dialog" aria-modal="true" aria-labelledby="edTitle" aria-describedby="edSafe">
          <header class="ed-head" id="edHead"></header>
          <div class="ed-banner" id="edBanner" aria-live="assertive"></div>
          <div class="ed-body" id="edBody">
            <section class="ed-year" id="edYear" aria-labelledby="edYearH"></section>
            <section class="ed-tags" aria-labelledby="edTagsH">
              <h3 id="edTagsH" class="vh">ジャンルとタグ</h3>
              <div class="ed-find-wrap">
                <label class="finder-field ed-find">${ICON.search}<input id="edInput" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="edSugg" placeholder="タグやジャンルを追加・この曲のタグから探す" aria-label="タグやジャンルを追加、またはこの曲のタグから探す"></label>
                <ul class="ed-sugg" id="edSugg" role="listbox" aria-label="付けられるタグ" hidden></ul>
              </div>
              <div id="edChips"></div>
            </section>
          </div>
          <footer class="ed-foot" id="edFoot"></footer>
        </section>`;
    }
    // header
    $("#edHead").innerHTML = `<button class="icon-btn ed-x" type="button" data-act="ed-close" aria-label="タグの編集を閉じる（下書きは捨てて、取り消しで戻せます）">${ICON.x}</button>
      <div class="ed-titles">
        <h2 id="edTitle">${ed.batch ? `${total}曲のタグをまとめて編集` : "タグを編集"}</h2>
        ${ed.batch ? `<button type="button" class="ed-targets-btn" data-act="ed-targets" aria-expanded="${ed.showTargets}">対象 ${total}曲${hashes.size < total ? `・保存するデータは${hashes.size}つ` : ""}${ICON.chev}</button>`
          : `<p class="ed-song"><b>${esc(displayTitle(s0))}</b><span>${esc(s0.artist || "アーティスト情報なし")}・${s0.fmt}・${esc(s0.folder)}</span></p>${ed.excluded ? `<p class="note ed-excl">${esc(ed.excluded)}</p>` : ""}`}
      </div>
      ${ed.batch && ed.showTargets ? `<div class="ed-targets"><p class="note">開いたときの${total}曲に固定しています。一覧の条件やスキャンで表示が変わっても、対象は増減しません。${hashes.size < total ? `中身が同じファイルはタグを共有するため、保存するデータは${hashes.size}つです。` : ""}</p>
        <ol>${ed.targets.map((t) => { const s = byId.get(t.id); const share = ed.targets.filter((x) => x.hash === t.hash).length > 1; return `<li><b>${esc(displayTitle(s))}</b><span>${s.fmt}・${esc(s.folder)}${share ? '<span class="same">中身が同じ</span>' : ""}</span></li>`; }).join("")}</ol>
        ${ed.excluded ? `<p class="note">${esc(ed.excluded)}</p>` : ""}</div>` : ""}`;
    // banner
    $("#edBanner").innerHTML = bannerHTML(ed);
    // year
    $("#edYear").innerHTML = yearHTML(ed);
    // chips
    const pres = presence(ed);
    const q = ed.q.trim(); const fq = q ? fold(q) : "";
    const match = (v) => !fq || fold(v).includes(fq);
    const reloadedKeys = new Set((ed.reloaded || []).map((x) => x.key));
    const chipHTML = (p, pre) => {
      const k = p.key;
      const del = ed.remove.some((x) => tagKey(x) === k);
      const drafted = ed.add.some((x) => tagKey(x) === k);
      // an addition that a reload showed is already there stays in the
      // draft (reload never edits it) but no longer reads as a change
      const redundant = drafted && p.n === total;
      const add = drafted && !redundant;
      const mixed = ed.batch && p.n < total;
      const embedded = p.origins.has("embedded") || p.origins.has("both");
      const vis = match(p.value);
      const label = `${KIND_NAME[p.kind]}「${p.value}」`;
      const cls = `tg${del ? " is-del" : ""}${add ? " is-add" : ""}${mixed && !add ? " is-mixed" : ""}${vis ? "" : " is-dim"}${reloadedKeys.has(k) ? " is-new" : ""}${redundant ? " is-redundant" : ""}`;
      const presTxt = ed.batch ? `<span class="tg-n" aria-label="${add ? total : p.n}曲中${total}曲">${add ? total : p.n}/${total}</span>` : "";
      const origin = embedded ? `<span class="tg-o" title="音声ファイルに埋め込まれていた値">ファイル</span>` : "";
      const btns = del ? `<button type="button" class="tg-b tg-undo" data-act="ed-keep" data-k="${esc(k)}" aria-label="${esc(label)}を外すのをやめる">戻す</button>`
        : `${mixed && !add ? `<button type="button" class="tg-b" data-act="ed-add-all" data-k="${esc(k)}" aria-label="${esc(label)}を${total}曲すべてに付ける">${ICON.plus}</button>` : ""}<button type="button" class="tg-b" data-act="ed-rm" data-k="${esc(k)}" aria-label="${esc(label)}を${ed.batch ? `${total}曲すべてから` : ""}外す">${ICON.x}</button>`;
      const shown = pre ? p.value.slice(pre.length + 1) : p.value;
      return `<li class="${cls}" data-k="${esc(k)}"><span class="tg-v"${pre ? ` title="${esc(p.value)}"` : ""}>${esc(shown)}</span>${origin}${presTxt}${reloadedKeys.has(k) ? '<span class="tg-o is-new">ほかの操作で追加</span>' : ""}${redundant ? '<span class="tg-o">下書きの追加は不要に</span>' : ""}${btns}</li>`;
    };
    const all = [...pres.values()];
    ed.add.forEach((t) => { if (!pres.has(tagKey(t))) all.push({ key: tagKey(t), kind: t.kind, value: t.value, n: 0, origins: new Set(["manual"]) }); });
    const group = (kind) => {
      const xs = all.filter((p) => p.kind === kind);
      // pending changes first, then the order they were attached
      xs.sort((a, b) => rank(b) - rank(a));
      const shown = xs.filter((p) => match(p.value) || ed.add.some((x) => tagKey(x) === p.key) || ed.remove.some((x) => tagKey(x) === p.key));
      return { xs, shown };
    };
    const rank = (p) => (ed.add.some((x) => tagKey(x) === p.key) ? 2 : ed.remove.some((x) => tagKey(x) === p.key) ? 1 : 0);
    const g = group("genre"), c = group("custom");
    // many tags: values that share a prefix such as 原曲: fold into one
    // bundle, so a megamix shows a dozen chips and three bundles, not 46 ×
    const prefixOf = (v) => { const m = v.match(/^(.+?)[:：]/); return m ? m[1] : null; };
    const pending = (p) => ed.add.some((x) => tagKey(x) === p.key) || ed.remove.some((x) => tagKey(x) === p.key);
    const foldList = (shown) => {
      if (q) return { loose: shown, folds: [] };
      const by = new Map();
      shown.forEach((p) => { const pre = prefixOf(p.value); if (pre && !pending(p)) { if (!by.has(pre)) by.set(pre, []); by.get(pre).push(p); } });
      const folds = [...by.entries()].filter(([, xs]) => xs.length >= 4);
      const folded = new Set(folds.flatMap(([, xs]) => xs.map((p) => p.key)));
      return { loose: shown.filter((p) => !folded.has(p.key)), folds };
    };
    const tagList = (kind, grp) => {
      const { loose, folds } = foldList(grp.shown);
      const foldChips = folds.map(([pre, xs]) => `<li class="tg-fold"><button type="button" data-act="ed-fold" data-pre="${esc(pre)}" aria-expanded="${ed.folds.has(pre)}" aria-controls="fold-${kind}-${esc(pre)}"><span>${esc(pre)}</span><small>${xs.length}件</small>${ICON.chev}</button></li>`).join("");
      const subs = folds.filter(([pre]) => ed.folds.has(pre)).map(([pre, xs]) => `<div class="tg-sub" id="fold-${kind}-${esc(pre)}"><h5>${esc(pre)}<small>${xs.length}件</small></h5><ul class="tgs" aria-label="${esc(pre)}で始まるタグ">${xs.map((p) => chipHTML(p, pre)).join("")}</ul></div>`).join("");
      return `<ul class="tgs" aria-label="${KIND_NAME[kind]}">${loose.map((p) => chipHTML(p)).join("")}${foldChips}${!loose.length && !folds.length ? '<li class="tg-none">なし</li>' : ""}</ul>${subs}`;
    };
    const sup = suppressedOf(ed);
    const matchNote = q ? `<p class="ed-match" role="status">この曲のタグで「${esc(q)}」を含むもの：${g.xs.filter((p) => match(p.value)).length + c.xs.filter((p) => match(p.value)).length}件</p>` : "";
    const embRm = ed.remove.some((t) => all.find((p) => p.key === tagKey(t) && (p.origins.has("embedded") || p.origins.has("both"))));
    $("#edChips").innerHTML = `${matchNote}
      <div class="tg-group"><h4>${kindMark("genre")}ジャンル<small>${g.xs.length}</small></h4>${tagList("genre", g)}</div>
      <div class="tg-group"><h4>${kindMark("custom")}タグ<small>${c.xs.length}</small></h4>${tagList("custom", c)}</div>
      ${embRm ? `<p class="ed-note">「ファイル」と書いた値を外すと、このアプリの分類から除きます。音声ファイルの中身はそのままです。</p>` : ""}
      ${sup.length ? `<div class="tg-group is-sup"><h4>外しているファイルの値<small>${sup.length}</small></h4><ul class="tgs">${sup.map((t) => `<li class="tg is-sup"><span class="tg-v">${esc(t.value)}</span><span class="tg-o">${KIND_NAME[t.kind]}</span><button type="button" class="tg-b tg-undo" data-act="ed-restore" data-k="${esc(tagKey(t))}" aria-label="${KIND_NAME[t.kind]}「${esc(t.value)}」を分類に戻す">戻す</button></li>`).join("")}</ul></div>` : ""}
      ${ed.ref ? `<div class="ed-ref"><h4>前のファイルに向けた下書き</h4><p class="note">新しいファイルには自動で入れません。必要なものだけ押して入れ直してください。</p><ul class="tgs">${ed.ref.map((r) => `<li class="tg is-ref"><span class="tg-v">${r.sign} ${esc(r.text)}</span>${r.t ? `<button type="button" class="tg-b tg-undo" data-act="ed-ref" data-sign="${r.sign}" data-k="${esc(tagKey(r.t))}">入れる</button>` : ""}</li>`).join("")}</ul></div>` : ""}`;
    // suggestions
    const sg = $("#edSugg"); const opts = edSuggestions(ed);
    if (ed.sugIndex >= opts.length) ed.sugIndex = 0;
    sg.hidden = !opts.length;
    $("#edInput").setAttribute("aria-expanded", String(!!opts.length));
    sg.innerHTML = opts.map((o, i) => `<li role="option" id="es${i}" class="es${o.create ? " is-create" : ""}" aria-selected="${i === ed.sugIndex}" data-act="ed-pick" data-kind="${o.kind}" data-v="${esc(o.value)}">
      ${kindMark(o.kind)}<span class="es-k">${KIND_NAME[o.kind]}</span><span class="es-v">${o.create ? `新しく「${esc(o.value)}」を作って付ける` : hlq(o.value, q)}</span><span class="es-n">${o.create ? "" : ed.batch && pres.get(o.kind + ":" + o.value) ? `${pres.get(o.kind + ":" + o.value).n}/${total}曲に付いています` : `ライブラリで${fmtN(o.count)}曲`}</span></li>`).join("");
    if (opts.length) $("#edInput").setAttribute("aria-activedescendant", "es" + ed.sugIndex); else $("#edInput").removeAttribute("aria-activedescendant");
    // footer
    const items = changeList(ed);
    const blocked = ed.err && ["stale_revision", "identity_changed", "store_read_only"].includes(ed.err.code) && !ed.err.retryable;
    const yearBad = ed.year && ed.year.mode === "set" && !Number.isInteger(ed.year.value);
    const sum = items.length ? `<button type="button" class="ed-sum" data-act="ed-changes" aria-expanded="${ed.showChanges}"><span class="ed-sum-n">${items.length}</span>件の変更<span class="ed-marks">${items.slice(0, 4).map((i) => `<i class="m-${i.type}">${i.sign}</i>`).join("")}</span>${ICON.chev}</button>` : `<span class="ed-sum is-none">変更はまだありません</span>`;
    $("#edFoot").innerHTML = `${ed.showChanges && items.length ? `<ul class="ed-changes">${items.map((i) => `<li class="m-${i.type}"><i>${i.sign}</i><span>${esc(i.text)}</span><button type="button" class="tg-b" data-act="${i.act || "ed-undo-item"}" data-k="${esc(i.key || "")}" data-type="${i.type}" aria-label="「${esc(i.text)}」をやめる">やめる</button></li>`).join("")}</ul>` : ""}
      <div class="ed-foot-row">${sum}
        <p class="ed-safe" id="edSafe">${ed.batch ? `保存先：${total}曲（データ${hashes.size}つ）。` : ""}音声ファイルは書き換えません</p>
        <button class="btn" type="button" data-act="ed-cancel" ${ed.saving ? "disabled" : ""}>キャンセル</button>
        <button class="btn primary ed-save" type="button" data-act="ed-save" ${!items.length || ed.saving || blocked || yearBad ? "disabled" : ""} aria-busy="${ed.saving}">${ed.saving ? "保存中…" : ed.batch ? `${total}曲に保存` : "保存"}</button>
      </div>`;
    $(".ed").classList.toggle("is-saving", ed.saving);
    $(".ed").classList.toggle("is-batch", ed.batch);
  }
  function hlq(text, q) {
    const i = fold(text).indexOf(fold(q));
    if (!q || i < 0 || text.length !== fold(text).length) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }
  function yearHTML(ed) {
    const total = ed.targets.length;
    const b0 = ed.base[0];
    const s0 = byId.get(b0.id);
    const nowYears = ed.base.map(yearNow);
    const summary = (() => {
      if (ed.batch) {
        const m = new Map(); nowYears.forEach((y) => m.set(y, (m.get(y) || 0) + 1));
        return [...m.entries()].map(([y, n]) => `${y ? y + "年" : "未設定"} ${n}曲`).join("・");
      }
      return nowYears[0] ? `${nowYears[0]}年` : "未設定";
    })();
    const src = ed.batch ? "" : YEAR_SRC[s0.yearStatus];
    const draft = ed.year;
    const after = draft ? (ed.batch ? (draft.mode === "set" ? `${draft.value || "？"}年` : draft.mode === "unset" ? "年なし" : "各曲のファイルの日付") : (() => { const y = yearAfter(ed, b0); return y ? y + "年" : draft.mode === "auto" ? "未設定（ファイルの日付が使えません）" : "年なし"; })()) : null;
    const head = `<div class="ey-row"><h3 id="edYearH">${kindMark("year")}制作年</h3>
      <span class="ey-now">${draft ? `<s>${esc(summary)}</s><span class="ey-arrow" aria-hidden="true">→</span><b class="ey-after">${esc(after)}</b>` : `<b>${esc(summary)}</b><small>${esc(src)}</small>`}</span>
      <button type="button" class="ey-toggle" data-act="ed-year-open" aria-expanded="${ed.yearOpen}">${ed.yearOpen ? "閉じる" : "変える"}</button></div>`;
    if (!ed.yearOpen) return head;
    const mode = draft ? draft.mode : ed.batch ? "keep" : b0.rec.year.mode;
    const autoTxt = ed.batch ? "各曲のファイルの日付から決める" : b0.auto.status === "resolved" ? `ファイルの日付から決める（${b0.auto.year}年）` : `ファイルの日付から決める（いまは決められません：${YEAR_SRC[b0.auto.status].replace("ファイルの日付", "日付")}）`;
    const setVal = draft && draft.mode === "set" ? (ed.yearInput || "") : ed.yearInput || (b0.rec.year.mode === "set" ? String(b0.rec.year.value) : "");
    const yErr = draft && draft.mode === "set" ? (!/^\d{4}$/.test(ed.yearInput) ? "4桁の年を入れてください" : Number(ed.yearInput) < 1000 ? "1000年より前は使えません" : Number(ed.yearInput) > FK.NOW_YEAR ? "未来の年です。このまま保存できます" : "") : "";
    const r = (v, label, sub, extra = "") => `<label class="ey-opt${mode === v ? " is-on" : ""}"><input type="radio" name="eyMode" value="${v}" ${mode === v ? "checked" : ""} data-act="ed-year-mode"><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</span>${extra}</label>`;
    const cands = ed.batch ? "" : (() => {
      const cs = s0.file.embedded.candidates;
      if (!cs.length) return `<p class="note">ファイルに日付の項目はありません。</p>`;
      const diag = yearDiag(s0);
      return `<details class="ey-cands" ${ed.candOpen ? "open" : ""} data-toggle="candOpen"><summary>ファイルに入っている日付（${cs.length}件）</summary>
        <ul>${cs.map((c) => {
          const ys = String(c.raw_value).split("\n").map((v) => v.trim());
          return `<li><span class="mono">${esc(c.raw_key)}</span><span class="ey-raw">${esc(ys.join("・"))}</span><small>${SEM_NAME[c.semantic]}${c.semantic === "original" ? "・自動では使いません" : `・優先${c.rank + 1}`}</small>
            <span class="ey-use">${ys.map((v) => { const m = v.match(/^(\d{4})/); const ok = m && Number(m[1]) >= 1000; return ok ? `<button type="button" class="tg-b" data-act="ed-year-cand" data-v="${m[1]}" aria-label="${m[1]}年に指定する">${m[1]}年にする</button>` : `<span class="bad">読めない値</span>`; }).join("")}</span></li>`;
        }).join("")}</ul>${diag ? `<p class="note">${esc(diag)}</p>` : ""}</details>`;
    })();
    return head + `<div class="ey-panel" role="radiogroup" aria-label="制作年の決め方">
      ${ed.batch ? r("keep", "変更しない", `${total}曲それぞれ今のまま（${esc(summary)}）`) : ""}
      ${r("auto", autoTxt, ed.batch ? "自分で指定した年を外します" : b0.rec.year.mode === "auto" ? "いまの設定" : "自分で指定した年を外します")}
      ${r("set", "年を指定する", "", `<span class="ey-input"><input id="edYearInput" inputmode="numeric" maxlength="4" value="${esc(setVal)}" aria-label="指定する年（4桁）" ${mode === "set" ? "" : "tabindex=\"-1\""} data-act="ed-year-input" aria-invalid="${!!yErr && !yErr.startsWith("未来")}" aria-describedby="edYearErr"><span>年</span></span>`)}
      ${yErr ? `<p class="ey-err${yErr.startsWith("未来") ? " is-warn" : ""}" id="edYearErr">${yErr}</p>` : ""}
      ${r("unset", "年なしにする", "ファイルの日付があっても使いません")}
      ${cands}
    </div>`;
  }
  const ERR = {
    persist_failed: ["保存できませんでした", "タグの保存先に書き込めませんでした。下書きはそのまま残っています。", "もう一度保存", true],
    store_read_only: ["タグの保存先が読み取り専用です", "いまは保存できません。ファイルから読んだタグは表示できます。下書きは残っています。", "もう一度保存", true],
    busy: ["ライブラリを更新しています", "更新が終わってから保存してください。下書きは残っています。", "もう一度保存", true],
    invalid_input: ["入力を確かめてください", "制作年は4桁の年で入れてください。", null, true],
    identity_unavailable: ["保存できない曲が含まれています", "ファイルが見つからない曲は、タグを保存できません。", null, false],
  };
  function bannerHTML(ed) {
    const parts = [];
    if (ed.notice) parts.push(`<div class="ed-msg is-info" role="status"><p>${esc(ed.notice)}</p></div>`);
    const e = ed.err;
    if (!e) return parts.join("");
    if (e.code === "stale_revision") {
      parts.push(`<div class="ed-msg is-warn" role="alert">${ICON.alert}<div><b>${e.proactive ? "開いたあとで、ライブラリかタグが更新されました" : "保存の直前に、タグがほかの操作で更新されていました"}</b>
        <p>${ed.batch ? `対象の${ed.targets.length}曲は変わりません。` : ""}最新の内容を読み込んで、下書きを確かめてから保存してください。下書きは消えません。</p>
        <p class="code">stale_revision</p></div><button class="btn primary" type="button" data-act="ed-reload">最新の内容を読み込む</button></div>`);
    } else if (e.code === "identity_changed") {
      parts.push(`<div class="ed-msg is-bad" role="alert">${ICON.alert}<div><b>この曲のファイルが変わりました</b>
        <p>開いたあとで、ファイルの中身が別のものになりました（識別 ${esc(e.was.slice(0, 8))}… → ${esc(e.now.slice(0, 8))}…）。この下書きは前のファイルに向けたものなので、新しいファイルには保存しません。</p>
        <p class="code">identity_changed</p></div><div class="ed-msg-btns"><button class="btn primary" type="button" data-act="ed-reopen">新しいファイルで開き直す</button></div></div>`);
    } else {
      const [t, b, retry] = ERR[e.code] || ["保存できませんでした", "", "もう一度保存"];
      parts.push(`<div class="ed-msg is-bad" role="alert">${ICON.alert}<div><b>${t}</b><p>${b}</p><p class="code">${esc(e.code)}</p></div>${retry ? `<button class="btn" type="button" data-act="ed-save">${retry}</button>` : ""}</div>`);
    }
    return parts.join("");
  }
  async function saveEditor() {
    const ed = S.ed; if (!ed || ed.saving) return;
    const patch = {};
    if (ed.year) patch.year_change = ed.year.mode === "set" ? { mode: "set", value: Number(ed.yearInput) } : { mode: ed.year.mode };
    if (ed.add.length) patch.add = ed.add.map((t) => ({ kind: t.kind, value: t.value }));
    if (ed.remove.length) patch.remove = ed.remove.map((t) => ({ kind: t.kind, value: t.value }));
    const req = { targets: ed.targets.map((t) => ({ path: t.path, expected_hash: t.hash })), expected_revision: ed.rev, patch };
    ed.lastRequest = req;
    ed.saving = true; ed.err = null; renderEditor();
    try {
      const res = await svcUpdate(req);
      ed.saving = false;
      const keys = new Set([...ed.add.map(tagKey), ...(ed.year ? ["year"] : [])]);
      S.justSaved = ed.batch ? null : { hash: ed.targets[0].hash, keys };
      const openId = S.open;
      sameHash = hashCount();
      // keep the open track in place even if the edit made it leave the conditions
      if (openId && !filter(S.clauses).some((s) => s.id === openId)) S.keep = { id: openId, at: Math.max(0, result.findIndex((s) => s.id === openId)) };
      update(); closeEditor("saved");
      const rows = ed.targets.length;
      if (res.changed === 0) toast(ed.batch ? `変更はありませんでした。${rows}曲とも、すでに同じ内容です` : "変更はありませんでした。すでに同じ内容です");
      else toast(ed.batch ? `${rows}曲のタグを保存しました${res.changed + res.no_op < rows ? `（中身が同じファイルを含むため、保存したデータは${res.changed + res.no_op}つ）` : ""}` : "タグを保存しました");
      LOG.push({ req, res });
    } catch (e) {
      if (!e || !e.code) { console.error(e); throw e; }
      ed.saving = false;
      if (e.code === "identity_changed") ed.err = { code: e.code, was: ed.targets.find((t) => t.path === e.path).hash, now: e.now };
      else ed.err = { code: e.code, retryable: ERR[e.code] ? ERR[e.code][3] : true };
      LOG.push({ req, err: e.code });
      renderEditor();
      $(".ed-msg .btn")?.focus();
    }
  }
  const LOG = [];
  function reloadEditor() {
    const ed = S.ed;
    // the revision and display refresh only if every target kept its hash
    const changedTarget = ed.targets.find((t) => byId.get(t.id).file.hash !== t.hash);
    if (changedTarget) { ed.err = { code: "identity_changed", was: changedTarget.hash, now: byId.get(changedTarget.id).file.hash }; renderEditor(); return; }
    const before = new Map(ed.base.flatMap((b) => b.eff.map((t) => [b.hash + "|" + t.key, t])));
    ed.base = baseState(ed.targets);
    ed.rev = revision();
    const fresh = [];
    ed.base.forEach((b) => b.eff.forEach((t) => { if (!before.has(b.hash + "|" + t.key)) fresh.push(t); }));
    ed.reloaded = fresh;
    // a pending addition that the other change already made is now redundant
    const total = ed.targets.length; const pres = presence(ed);
    const redundant = ed.add.filter((t) => (pres.get(tagKey(t)) || { n: 0 }).n === total);
    ed.err = null;
    ed.notice = `最新の内容を読み込みました。${fresh.length ? `ほかの操作で ${fresh.map((t) => `${KIND_NAME[t.kind]}「${t.value}」`).join("、")} が加わっていました。` : "この曲のタグに変化はありませんでした。"}${redundant.length ? `下書きの ${redundant.map((t) => `「${t.value}」`).join("、")} はすでに付いています。` : ""}下書きは残しています。`;
    renderEditor();
    $(".ed-save")?.focus();
  }

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
    $("#flyer").animate([
      { opacity: 1, transform: `translate(${a.left + a.width / 2 - 7}px, ${a.top + a.height / 2 - 7}px) scale(1)` },
      { opacity: 1, transform: `translate(${(a.left + b.left) / 2}px, ${Math.min(a.top, b.top) - 60}px) scale(1.3)`, offset: .45 },
      { opacity: 0, transform: `translate(${b.left + 10}px, ${b.top + b.height / 2 - 7}px) scale(.6)` },
    ], { duration: 520, easing: "cubic-bezier(.3,.7,.4,1)" });
  }

  // ---------------------------------------------------------------- events
  const edFind = (k) => { const [kind, ...rest] = k.split(":"); return { kind, value: rest.join(":") }; };
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT" || t.tagName === "INPUT") return;
    if (t.closest("#editor")) return edClick(t, e);
    const id = Number(t.dataset.id);
    switch (t.dataset.act) {
      case "open-lens": S.lens = true; render(); focusInput(); break;
      case "close-lens": commitInput(); break;
      case "edit-clause": S.lens = true; S.focusClause = null; S.clauseMenu = id; render(); setTimeout(() => $(`.cl[data-id="${id}"] .cl-more`)?.focus()); break;
      case "clause-menu": S.clauseMenu = S.clauseMenu === id ? null : id; renderLens(); setTimeout(() => $(`.cl[data-id="${id}"] .cl-more`)?.focus()); break;
      case "rm-clause": { const inLine = !!t.closest("#summary"); removeClause(id); if (inLine) { const next = $("#summary .t-x") || $("#finderInput"); quietFocus = true; next.focus(); quietFocus = false; } break; }
      case "rm-clauses": { const ids = t.dataset.ids.split(",").map(Number); mutate(() => { S.clauses = S.clauses.filter((c) => !ids.includes(c.id)); }, `条件を${ids.length}つ外しました`); break; }
      case "rm-val": removeValue(id, t.dataset.v); break;
      case "alt": S.focusClause = S.focusClause === id ? null : id; S.input = ""; S.clauseMenu = null; render(); focusInput(); break;
      case "toggle": { const c = S.clauses.find((x) => x.id === id); mutate(() => { const cc = S.clauses.find((x) => x.id === id); cc.on = !cc.on; }, c.on ? `条件「${clauseText(c)}」を一時停止しました` : null); break; }
      case "not": { mutate(() => { const cc = S.clauses.find((x) => x.id === id); cc.not = !cc.not; }); break; }
      case "pick": if (S.lens || t.closest(".detail")) { const inDetail = !!t.closest(".detail"); addValue(t.dataset.kind, t.dataset.v); if (inDetail) toast(`条件「${valText(t.dataset.kind, t.dataset.v)}」を加えました`, "元に戻す", undo); else focusInput(); } break;
      case "pick-group": addValue(t.dataset.kind, JSON.parse(t.dataset.vs)); focusInput(); break;
      case "more-kind": S.expandKind = t.dataset.kind; compute(); renderLens(); focusInput(); break;
      case "year": S.focusClause = null; addValue("year", t.dataset.v); break;
      case "recent": { const r = S.recent[Number(t.dataset.i)]; mutate(() => restore(r.snap)); break; }
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "mode": mutate(() => { S.mode = S.mode === "all" ? "any" : "all"; }); break;
      case "set-mode": if (S.mode !== t.dataset.v) mutate(() => { S.mode = t.dataset.v; }); break;
      case "dest-list": S.destList = !S.destList; renderDock(); if (S.destList) setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "rb-menu": S.rbMenu = !S.rbMenu; renderResults(); if (S.rbMenu) setTimeout(() => $(".rb-more .menu button")?.focus()); break;
      case "sort-to": S.sort = t.dataset.v; S.rbMenu = false; update(); break;
      case "clear-all": mutate(() => { S.clauses = []; }, "条件をすべて外しました"); break;
      case "retry": S.sim = "ok"; update(); toast("検索を更新しました"); break;
      case "open": S.open = S.open === id ? null : id; S.active = id; S.tagsAll = false; S.techOpen = false; if (S.keep && S.keep.id !== id) { S.keep = null; compute(); } S.justSaved = null; renderResults(); break;
      case "tags-all": S.tagsAll = !S.tagsAll; renderResults(); $(`.row[data-id="${S.open}"] .more-chip`)?.focus(); break;
      case "add": if (t.getAttribute("aria-disabled") === "true") { toast("ファイルが見つからないため追加できません"); break; } addTo(S.dest, [id], t); break;
      case "fav": addTo("fav", [id], t); break;
      case "edit-tags": openEditor([id], `.row[data-id="${id}"] [data-act="edit-tags"]`); break;
      case "edit-batch": openBatch(); break;
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
  function openBatch() {
    const visible = new Set(result.map((s) => s.id));
    const sel = [...S.selected];
    const shown = sel.filter((id) => visible.has(id));
    const hidden = sel.length - shown.length;
    const ok = shown.filter((id) => !byId.get(id).missing);
    const missing = shown.length - ok.length;
    const notes = [];
    if (hidden) notes.push(`選択した${sel.length}曲のうち${hidden}曲は、いまの条件で隠れているため対象にしていません。`);
    if (missing) notes.push(`ファイルが見つからない${missing}曲は、タグを保存できないため対象にしていません。`);
    if (!ok.length) { toast("編集できる曲がありません。" + notes.join("")); return; }
    openEditor(ok, ".rb-tagedit", { batch: ok.length > 1, excluded: notes.join("") || null, showTargets: !!notes.length });
  }
  function edClick(t) {
    const ed = S.ed; if (!ed) return;
    const act = t.dataset.act;
    const k = t.dataset.k;
    const refocusChip = () => { const el = $(`#editor .tg[data-k="${CSS.escape(k)}"] .tg-b`); (el || $("#edInput")).focus(); };
    switch (act) {
      case "ed-close": case "ed-cancel": closeEditor(); break;
      case "ed-save": saveEditor(); break;
      case "ed-reload": reloadEditor(); break;
      case "ed-reopen": {
        const old = changeList(ed).map((i) => ({ sign: i.sign, text: i.text, t: i.key ? edFind(i.key) : null }));
        // manual tags belong to the old content hash and are not carried over
        if (!ed.batch) {
          const nowEff = new Set(FK.effective(byId.get(ed.targets[0].id)).map((x) => x.key));
          ed.base[0].rec.add.filter((x) => !nowEff.has(tagKey(x)) && !ed.remove.some((r) => tagKey(r) === tagKey(x)))
            .forEach((x) => old.push({ sign: "＋", text: `${KIND_NAME[x.kind]}「${x.value}」を付ける（前のファイルで付けていた）`, t: x }));
        }
        const ids = ed.targets.map((x) => x.id); const opener = ed.opener;
        S.ed = null; openEditor(ids, opener, { batch: ed.batch, ref: old, notice: "新しいファイルの内容で開き直しました。下の「前のファイルに向けた下書き」から、必要なものを入れ直せます。" });
        break;
      }
      case "ed-fold": { const pre = t.dataset.pre; ed.folds.has(pre) ? ed.folds.delete(pre) : ed.folds.add(pre); renderEditor(); $(`#editor [data-act="ed-fold"][data-pre="${CSS.escape(pre)}"]`)?.focus(); break; }
      case "ed-targets": ed.showTargets = !ed.showTargets; renderEditor(); $(".ed-targets-btn")?.focus(); break;
      case "ed-changes": ed.showChanges = !ed.showChanges; renderEditor(); $(".ed-sum")?.focus(); break;
      case "ed-rm": edRemove(edFind(k)); renderEditor(); refocusChip(); break;
      case "ed-keep": edAdd(edFind(k)); renderEditor(); refocusChip(); break;
      case "ed-add-all": edAdd(edFind(k)); renderEditor(); refocusChip(); break;
      case "ed-restore": edAdd(edFind(k)); renderEditor(); $("#edInput").focus(); break;
      case "ed-ref": { const tt = edFind(k); t.dataset.sign === "−" ? edRemove(tt) : edAdd(tt); renderEditor(); break; }
      case "ed-pick": edAdd({ kind: t.dataset.kind, value: t.dataset.v }); ed.q = ""; $("#edInput").value = ""; renderEditor(); $("#edInput").focus(); break;
      case "ed-undo-item": { if (t.dataset.type === "add") ed.add = ed.add.filter((x) => tagKey(x) !== k); else ed.remove = ed.remove.filter((x) => tagKey(x) !== k); renderEditor(); $("#edInput").focus(); break; }
      case "ed-year-reset": ed.year = null; renderEditor(); $(".ey-toggle")?.focus(); break;
      case "ed-year-open": ed.yearOpen = !ed.yearOpen; renderEditor(); $(".ey-toggle")?.focus(); break;
      case "ed-year-cand": ed.year = { mode: "set", value: Number(t.dataset.v) }; ed.yearInput = t.dataset.v; renderEditor(); $(".ey-toggle")?.focus(); break;
    }
  }
  document.addEventListener("change", (e) => {
    if (e.target.id === "sortSel") { S.sort = e.target.value; update(); return; }
    if (e.target.name === "eyMode" && S.ed) {
      const ed = S.ed; const v = e.target.value; const b0 = ed.base[0];
      const cur = ed.batch ? "keep" : b0.rec.year.mode;
      if (v === "keep" || (v === cur && v !== "set")) ed.year = null;
      else if (v === "set") {
        ed.yearInput = ed.yearInput || (b0.rec.year.mode === "set" ? String(b0.rec.year.value) : String(yearNow(b0) || ""));
        const same = !ed.batch && b0.rec.year.mode === "set" && Number(ed.yearInput) === b0.rec.year.value;
        ed.year = same ? null : { mode: "set", value: /^\d{4}$/.test(ed.yearInput) ? Number(ed.yearInput) : NaN };
      } else ed.year = { mode: v };
      renderEditor();
      if (v === "set") { const i = $("#edYearInput"); i.focus(); i.select(); } else $(`#editor input[name=eyMode][value=${v}]`)?.focus();
    }
  });
  document.addEventListener("toggle", (e) => {
    if (e.target.classList && e.target.classList.contains("tech")) S.techOpen = e.target.open;
    if (e.target.dataset && e.target.dataset.toggle === "candOpen" && S.ed) S.ed.candOpen = e.target.open;
  }, true);
  let clickInResults = false;
  document.addEventListener("click", (e) => { clickInResults = !!e.target.closest("#results"); }, true);
  document.addEventListener("click", () => { if (!S.lens || narrow() || !clickInResults) return; commitInput(); });
  function commitInput() {
    const o = S.input.trim() && !S.focusClause ? sugg.out[S.sugIndex] : null;
    S.lens = false; S.focusClause = null; S.clauseMenu = null;
    if (o && o.kind !== "more") addValue(o.kind, o.value); else { S.input = ""; update(); }
  }
  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  moreBtn.addEventListener("click", () => { moreMenu.hidden = !moreMenu.hidden; moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden)); if (!moreMenu.hidden) moreMenu.querySelector("button").focus(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#moreBtn") && !e.target.closest("#moreMenu")) { moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
    if (S.rbMenu && !e.target.closest(".rb-more")) { S.rbMenu = false; renderResults(); }
  });
  $("#scrim").addEventListener("click", () => { S.dockOpen = false; render(); });
  const narrow = () => innerWidth <= 760;
  function focusInput() { const i = narrow() ? $("#lensInput") : $("#finderInput"); if (i && document.activeElement !== i) { i.focus(); const v = i.value; i.value = ""; i.value = v; } }
  function onInput(e) {
    S.input = e.target.value; S.sugIndex = 0; S.lens = true; S.expandKind = null;
    compute(); renderQuery(); renderLens(); renderResults();
    if (e.target.id === "lensInput") focusInput();
  }
  $("#finderInput").addEventListener("input", onInput);
  let quietFocus = false;
  $("#finderInput").addEventListener("focus", () => { if (!quietFocus && !narrow() && !S.lens) { S.lens = true; render(); focusInput(); } });
  $("#finderInput").addEventListener("click", () => { if (narrow()) { S.lens = true; render(); focusInput(); } });
  document.addEventListener("input", (e) => {
    if (e.target.id === "lensInput") onInput(e);
    if (e.target.id === "edInput" && S.ed) { S.ed.q = e.target.value; S.ed.sugIndex = 0; renderEditor(); }
    if (e.target.id === "edYearInput" && S.ed) {
      const ed = S.ed; ed.yearInput = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
      ed.year = { mode: "set", value: /^\d{4}$/.test(ed.yearInput) ? Number(ed.yearInput) : NaN };
      const pos = e.target.selectionStart; renderEditor(); const i = $("#edYearInput"); i.focus(); i.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (S.ed) return edKey(e);
    const inField = e.target.matches("input");
    if (e.key === "/" && !inField) { e.preventDefault(); S.lens = true; render(); focusInput(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && S.lens) { e.preventDefault(); e.shiftKey ? redo() : undo(); focusInput(); return; }
    if (e.target.id === "finderInput" || e.target.id === "lensInput") {
      const opts = $$(".sugg");
      if (e.key === "ArrowDown" && opts.length) { e.preventDefault(); S.sugIndex = Math.min(opts.length - 1, S.sugIndex + 1); markSugg(opts); }
      else if (e.key === "ArrowUp" && opts.length) { e.preventDefault(); S.sugIndex = Math.max(0, S.sugIndex - 1); markSugg(opts); }
      else if (e.key === "Enter" && opts.length) { e.preventDefault(); opts[S.sugIndex].click(); focusInput(); }
      else if (e.key === "Backspace" && !e.target.value && S.clauses.length) { removeClause(S.clauses[S.clauses.length - 1].id); focusInput(); }
      else if (e.key === "Escape") { S.lens = false; S.focusClause = null; S.clauseMenu = null; S.input = ""; update(); e.target.blur(); }
      return;
    }
    if (e.key === "Escape") {
      if (!moreMenu.hidden) { moreMenu.hidden = true; moreBtn.focus(); }
      else if (S.rbMenu) { S.rbMenu = false; renderResults(); $('[data-act="rb-menu"]')?.focus(); }
      else if (S.dockOpen) { S.dockOpen = false; render(); $(".dest-chip")?.focus(); }
      else if (S.destList) { S.destList = false; renderDock(); $(".dock-change")?.focus(); }
      else if (S.clauseMenu) { const id = S.clauseMenu; S.clauseMenu = null; renderLens(); $(`.cl[data-id="${id}"] .cl-more`)?.focus(); }
      else if (S.lens) { commitInput(); quietFocus = true; $("#finderInput").focus(); quietFocus = false; }
      else if (S.open && e.target.closest(".row.is-open")) { const id = S.open; S.open = null; renderResults(); $(`.row[data-id="${id}"] .row-main`)?.focus(); }
      return;
    }
    const row = e.target.closest && e.target.closest(".row");
    if (row && !inField && e.target.classList.contains("row-main")) {
      const id = Number(row.dataset.id);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const sib = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        sib?.querySelector(".row-main")?.focus(); S.active = sib ? Number(sib.dataset.id) : S.active;
      } else if (e.key === "a" || e.key === "+") { e.preventDefault(); addTo(S.dest, [id], row.querySelector(".add")); setTimeout(() => document.querySelector(`.row[data-id="${id}"] .row-main`)?.focus()); }
      else if (e.key === "t" && !byId.get(id).missing) { e.preventDefault(); openEditor([id], `.row[data-id="${id}"] .row-main`); }
      else if (e.key === " " && S.selectMode) { e.preventDefault(); S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderResults(); document.querySelector(`.row[data-id="${id}"] .row-main`)?.focus(); }
    }
  });
  function edKey(e) {
    const ed = S.ed;
    if (e.key === "Escape") {
      e.preventDefault();
      if (e.target.id === "edInput" && ed.q) { ed.q = ""; e.target.value = ""; renderEditor(); return; }
      closeEditor(); return;
    }
    if (e.key === "Tab") {
      // focus stays in the editor
      const f = $$("#editor .ed button:not([disabled]), #editor .ed input:not([tabindex='-1']), #editor .ed summary").filter((x) => x.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!$(".ed-save").disabled) saveEditor(); return; }
    if (e.target.id === "edInput") {
      const opts = $$("#edSugg .es");
      if (e.key === "ArrowDown" && opts.length) { e.preventDefault(); ed.sugIndex = Math.min(opts.length - 1, ed.sugIndex + 1); renderEditor(); $("#es" + ed.sugIndex)?.scrollIntoView({ block: "nearest" }); }
      else if (e.key === "ArrowUp" && opts.length) { e.preventDefault(); ed.sugIndex = Math.max(0, ed.sugIndex - 1); renderEditor(); }
      else if (e.key === "Enter" && opts.length) { e.preventDefault(); const o = opts[ed.sugIndex]; edAdd({ kind: o.dataset.kind, value: o.dataset.v }); ed.q = ""; e.target.value = ""; renderEditor(); }
      else if (e.key === "Backspace" && !e.target.value && ed.add.length) { ed.add.pop(); renderEditor(); }
    }
    if (e.target.id === "edYearInput" && e.key === "Enter") { e.preventDefault(); ed.yearOpen = false; renderEditor(); $(".ey-toggle")?.focus(); }
  }
  function markSugg(opts) {
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === S.sugIndex)));
    opts[S.sugIndex].scrollIntoView({ block: "nearest" });
    const inp = narrow() ? $("#lensInput") : $("#finderInput"); inp?.setAttribute("aria-activedescendant", opts[S.sugIndex].id);
    result = filter(previewClauses()).slice().sort(SORTS[S.sort][1]); renderQuery(); renderResults();
  }
  new IntersectionObserver((en) => { if (en[0].isIntersecting && result.length > S.limit && S.sim !== "loading") { S.limit += 60; renderResults(); } }, { root: $("#results") }).observe($("#sentinel"));
  $("#themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  });
  // a revision change while the editor is open is announced before saving
  function revChanged() {
    if (!S.ed) { update(); return; }
    if (S.ed.rev !== revision()) { S.ed.err = { code: "stale_revision", proactive: true }; S.ed.notice = null; renderEditor(); }
    update();
  }

  // ---------------------------------------------------------------- demo (not product UI)
  function renderDemo() {
    $$("#demo [data-fail]").forEach((b) => b.setAttribute("aria-pressed", String((SVC.nextFail || "") === b.dataset.fail)));
  }
  $("#demo").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.scn) { scenario(b.dataset.scn); history.replaceState(null, "", "?s=" + b.dataset.scn); return; }
    if (b.dataset.fail !== undefined) { SVC.nextFail = b.dataset.fail || null; renderDemo(); return; }
    if (b.dataset.sim === "other") { otherSessionEdit(); revChanged(); }
    if (b.dataset.sim === "replace") { replaceFile(); revChanged(); }
    if (b.dataset.sim === "scan") { scan(); revChanged(); }
  });

  // ---------------------------------------------------------------- scenarios (demo only)
  const C = (kind, values, extra = {}) => Object.assign({ id: uid++, kind, values: [].concat(values), on: true, not: false }, extra);
  const A3 = () => [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix")];
  const openSel = (k) => `.row[data-id="${K(k).id}"] [data-act="edit-tags"]`;
  const SCN = {
    base() {},
    a() { S.clauses = A3(); },
    "a-first"() { S.clauses = [C("year", "2015")]; S.lens = true; },
    "a-type"() { S.clauses = A3().slice(0, 2); S.lens = true; S.input = "アニソン"; },
    "a-amb"() { S.lens = true; S.input = "2015"; },
    "a-funkot"() { S.clauses = [C("year", "2015")]; S.lens = true; S.input = "funkot"; },
    "a-menu"() { S.clauses = A3(); S.lens = true; S.clauseMenu = S.clauses[1].id; },
    "a-or"() { S.clauses = A3(); S.mode = "any"; },
    eight() {
      S.clauses = [C("year", ["2015", "2016"]), C("custom", "日本人トラックメーカー"), C("genre", ["アニソンremix", "アニソンRemix", "anison remix"]),
        C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", { on: false }), C("genre", "Funkot"), C("custom", "コール入り", { not: true }),
        C("custom", "多幸感", { on: false }), C("text", "シグナル"), C("custom", "2015夏頒布", { on: false })];
    },
    "eight-edit"() { SCN.eight(); S.lens = true; },
    zero() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix"), C("custom", "2009冬頒布"), C("custom", "サイレン")]; },
    loading() { SCN.a(); S.sim = "loading"; },
    error() { SCN.a(); compute(); lastGood = result; S.clauses.push(C("custom", "ネタ曲")); S.sim = "error"; },
    long() { S.clauses = [C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ"), C("year", "2015")]; S.open = K("long").id; },
    detail() { SCN.a(); S.open = K("after-mp3").id; S.active = S.open; },
    "detail-tech"() { SCN.detail(); S.techOpen = true; },
    "detail-moon"() { SCN.a(); S.open = K("moon").id; S.active = S.open; S.techOpen = true; },
    "detail-copy"() { SCN.a(); S.open = K("steel").id; S.active = S.open; },
    edit() { SCN.detail(); S.after = () => { openEditor([K("after-mp3").id], openSel("after-mp3")); edAdd({ kind: "custom", value: "コール入り" }); edRemove({ kind: "genre", value: "アニソンremix" }); renderEditor(); }; },
    "edit-open"() { SCN.detail(); S.after = () => openEditor([K("after-mp3").id], openSel("after-mp3")); },
    "edit-sugg"() { SCN.detail(); S.after = () => { openEditor([K("after-mp3").id], openSel("after-mp3")); S.ed.q = "コール"; $("#edInput").value = "コール"; renderEditor(); }; },
    "edit-year"() { SCN.a(); S.open = K("moon").id; S.after = () => { openEditor([K("moon").id], openSel("moon")); S.ed.yearOpen = true; S.ed.candOpen = true; renderEditor(); }; },
    many() { SCN.a(); S.open = K("mega").id; S.after = () => { openEditor([K("mega").id], openSel("mega")); edAdd({ kind: "custom", value: "原曲:銀河学園" }); edRemove({ kind: "custom", value: "ピアノ" }); edRemove({ kind: "genre", value: "Happy Hardcore" }); renderEditor(); }; },
    "many-find"() { SCN.many(); const f = S.after; S.after = () => { f(); S.ed.q = "原曲:銀河"; $("#edInput").value = "原曲:銀河"; renderEditor(); }; },
    batch() {
      SCN.a(); S.selectMode = true; ["after-mp3", "steel", "steel-copy", "fever"].forEach((k) => S.selected.add(K(k).id));
      S.after = () => { openBatch(); edAdd({ kind: "custom", value: "2015夏頒布" }); renderEditor(); };
    },
    "batch-year"() { SCN.batch(); const f = S.after; S.after = () => { f(); S.ed.yearOpen = true; S.ed.showTargets = false; renderEditor(); }; },
    "batch-scan"() { SCN.batch(); const f = S.after; S.after = () => { f(); scan(); revChanged(); }; },
    fail() { SCN.edit(); const f = S.after; S.after = () => { f(); SVC.nextFail = "persist_failed"; saveEditor(); }; },
    stale() { SCN.detail(); S.after = () => { openEditor([K("after-mp3").id], openSel("after-mp3")); edAdd({ kind: "custom", value: "コール入り" }); renderEditor(); SVC.nextFail = "stale_revision"; saveEditor(); }; },
    "stale-reloaded"() { SCN.stale(); const f = S.after; S.after = () => { f(); setTimeout(() => reloadEditor(), 500); }; },
    identity() { SCN.edit(); const f = S.after; S.after = () => { f(); replaceFile(); saveEditor(); }; },
    "identity-reopen"() { SCN.identity(); const f = S.after; S.after = () => { f(); setTimeout(() => $('[data-act="ed-reopen"]')?.click(), 500); }; },
    saved() { SCN.edit(); const f = S.after; S.after = () => { f(); saveEditor(); }; },
  };
  function scenario(name) {
    if (S.ed) { S.ed = null; $("#editor").hidden = true; $("#editor").innerHTML = ""; app.inert = false; }
    Object.assign(S, { clauses: [], mode: "all", input: "", lens: false, focusClause: null, sim: "ok", open: null, active: null, selectMode: false, dockOpen: false, limit: 60, dest: "queue", lastAdded: null, destList: false, rbMenu: false, after: null, hist: [], fut: [], clauseMenu: null, expandKind: null, techOpen: false, tagsAll: false, keep: null, justSaved: null });
    S.selected = new Set();
    (SCN[name] || SCN.base)();
    compute(); if (S.sim === "ok") lastGood = result;
    if (["a", "eight", "detail"].includes(name)) remember();
    render();
    if (S.open) $(`.row[data-id="${S.open}"]`)?.scrollIntoView({ block: "start" });
    if (S.after) { const f = S.after; S.after = null; f(); }
    $$(".demo [data-scn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === name)));
  }
  const params = new URLSearchParams(location.search);
  if (params.has("capture")) document.body.classList.add("capture");
  if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");
  renderNow();
  document.fonts && document.fonts.ready.then(() => renderQuery());
  scenario(params.get("s") || "base");
  // test hooks for verify.mjs / compare.mjs (not product UI)
  const fileDigest = () => {
    const str = JSON.stringify(songs.map((s) => [s.file.path, s.file.hash, s.file.size, s.file.mtime, s.file.embedded]));
    let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return `${h}:${str.length}:${songs.every((s) => Object.isFrozen(s.file) && Object.isFrozen(s.file.embedded))}`;
  };
  window.FKP = { S, SVC, LOG, scenario, update, render, openEditor, saveEditor, K, byId, otherSessionEdit, replaceFile, revChanged,
    filterCount: (mode) => filter(S.clauses, mode).length, fileDigest,
    manualOf: (k) => clone(FK.manual.get(K(k).file.hash)), effOf: (k) => FK.effective(K(k)).map((t) => t.key) };
})();
