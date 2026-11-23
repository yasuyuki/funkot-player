// Overprint Index (#173 agy) — Interactive prototype for Areas A, B, and C.
// Built on Overprint Liner (b8b5b15) non-target shell + real TagService contract.
(function () {
  const {
    songs, byId, byPath, tagIndex, playlists, tagService,
    normalizeTag, tagKey, sameTag, parseCandidateYear,
    MAX_EFFECTIVE_TAGS, MAX_TAG_SCALARS,
  } = window.FK;

  const $ = (s, r = document) => r.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => Number(n).toLocaleString("ja-JP");
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const INK = { blue: "var(--blue)", teal: "var(--teal)", orange: "var(--orange)", violet: "var(--violet)", pink: "var(--pink-text)" };
  const KIND_NAME = { year: "制作年", genre: "ジャンル", custom: "任意タグ", text: "曲名・アーティスト", artist: "アーティスト", unset: "制作年" };
  const YEAR_STATUS_LABEL = { resolved: "自動決定", missing: "年なし", invalid: "年の値が不正", future: "未来年", conflict: "候補が競合" };
  const META_STATUS_LABEL = { ready: "読取完了", pending: "取得待ち", error: "読取エラー" };
  const SEMANTIC_LABEL = { recording: "録音日時・優先1", generic: "一般日付・優先2", release: "発売日時・優先3", original: "原盤情報・自動不採用" };
  const ORIGIN_LABEL = { embedded: "自動（埋め込み）", manual: "手動追加", both: "自動＋手動" };

  const ICON = {
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6L21 7.4 19.6 6z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13z"/></svg>',
    heartO: '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 19.4 13zm0-2.8 6-5.9a2.8 2.8 0 0 0-4.6-3.3L12 9.8l-1.4-1.5a2.8 2.8 0 0 0-4.6 3.3z"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m7 9.5 5 5 5-5 1.4 1.4-6.4 6.4-6.4-6.4z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m10 5.6 1.4 1.4-4 4H20v2H7.4l4 4L10 18.4 3.6 12z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
    select: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm2 2v3h3V6zm7 0h8v2h-8zm0 9h8v2h-8zM4 13h7v7H4zm1.6 3.4 1.4-1.4 1 1 2.4-2.4 1.4 1.4-3.8 3.8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M6 5.5 15 12l-9 6.5zM16 5h2v14h-2z"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 4h9l9 9-8 8-9-9V4zm4 2.5A1.5 1.5 0 1 0 7 9.5a1.5 1.5 0 0 0 0-3z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm13-2v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m7.4 15.4 4.6-4.6 4.6 4.6L18 14l-6-6-6 6z"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m7.4 8.6 4.6 4.6 4.6-4.6L18 10l-6 6-6-6z"/></svg>',
  };

  // ---------------------------------------------------------------- state
  let uid = 1;
  const S = {
    clauses: [], mode: "all", yearUnset: false,
    input: "", lens: false, lensView: "add", suggKind: "all", suggLimit: 12,
    focusClause: null, sugIndex: 0,
    dest: "queue", sim: "ok", sort: "added", limit: 60, allowNonFunkot: false,
    selectMode: false, selected: new Set(),
    open: null, active: null,
    inspectorTagFilter: "", inspectorTagsExpanded: false, inspectorTechOpen: false,
    recent: [], historyPast: [], historyFuture: [],
    dockOpen: false, destList: false, rbMenu: false, lastAdded: null,
    tagModal: null,
  };

  const L = { queue: [], fri: [], work: [], anison: [], fav: [] };
  const pickIds = (n, off) => Array.from({ length: n }, (_, i) => songs[(off + i * 131) % songs.length].id);
  pickIds(4, 40).forEach((id) => L.queue.push({ id, auto: false }));
  pickIds(3, 900).forEach((id) => L.queue.push({ id, auto: true }));
  pickIds(23, 1200).forEach((id) => L.fri.push({ id }));
  pickIds(61, 5000).forEach((id) => L.work.push({ id }));
  pickIds(11, 7000).forEach((id) => L.anison.push({ id }));
  pickIds(140, 3000).forEach((id) => L.fav.push({ id }));

  const nowPlaying = byId.get(songs[3].id);
  const twinKey = (s) => s.title + "\u0000" + s.artist;
  const twinCount = new Map();
  songs.forEach((s) => twinCount.set(twinKey(s), (twinCount.get(twinKey(s)) || 0) + 1));

  // ---------------------------------------------------------------- search & filter engine
  const fold = (s) => String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/りみっくす/g, "remix").replace(/anison[g]?/g, "あにそん").replace(/nihonjin/g, "日本人")
    .replace(/[\s・:：\-_/()（）]/g, "");

  const clauseMatch = (c, s) => {
    let hit = false;
    switch (c.kind) {
      case "year": hit = c.values.includes(String(s.year)); break;
      case "genre": hit = c.values.some((v) => s.genres.some((g) => g.toLowerCase() === v.toLowerCase() || g === v)); break;
      case "custom": hit = c.values.some((v) => s.tags.some((t) => t.toLowerCase() === v.toLowerCase() || t === v)); break;
      case "artist": hit = c.values.includes(s.artist); break;
      case "text": { const q = fold(c.values[0]); hit = fold(s.title).includes(q) || fold(s.artist).includes(q); break; }
    }
    return c.not ? !hit : hit;
  };

  // Mirrors src/lib/tag-filter.ts: yearUnset excludes pending metadata unless manual mode is unset.
  const matchesYearUnset = (s) => {
    if (s.year !== null) return false;
    return s.manual.year.mode === "unset" || s.metadata_status !== "pending";
  };

  let sugg = { out: [], allOut: [], kindCounts: {}, base: songs, disambig: false, total: 0 };
  const pendingClause = () => {
    if (!S.input.trim() || !S.lens || S.lensView !== "add" || S.focusClause) return null;
    const o = sugg.out[S.sugIndex];
    return o ? { kind: o.kind, values: [o.value], on: true, pending: true } : null;
  };
  const activeClauses = (extra) => {
    const a = S.clauses.filter((c) => c.on);
    const p = pendingClause();
    if (p) a.push(p);
    if (extra) a.push(extra);
    return a;
  };
  function filter(clauses, mode = S.mode, unset = S.yearUnset) {
    let list = songs;
    if (clauses.length) {
      list = mode === "all"
        ? list.filter((s) => clauses.every((c) => clauseMatch(c, s)))
        : list.filter((s) => clauses.some((c) => clauseMatch(c, s)));
    }
    if (unset) list = list.filter(matchesYearUnset);
    return list;
  }

  const SORTS = {
    added: ["新しく追加した順", (a, b) => b.added - a.added],
    title: ["曲名順", (a, b) => a.title.localeCompare(b.title, "ja")],
    artist: ["アーティスト順", (a, b) => a.artist.localeCompare(b.artist, "ja")],
    year: ["制作年が新しい順", (a, b) => (b.year || 0) - (a.year || 0)],
    plays: ["よく聴いた順", (a, b) => b.plays - a.plays],
  };

  let result = songs;
  let lastGood = songs;
  function compute() {
    sugg = S.lens && S.lensView === "add" && S.input.trim() ? suggestions() : { out: [], allOut: [], kindCounts: {}, base: songs, disambig: false, total: 0 };
    if (S.sugIndex >= sugg.out.length) S.sugIndex = 0;
    result = filter(activeClauses()).slice().sort(SORTS[S.sort][1]);
    if (S.sim === "ok") lastGood = result;
  }

  function suggestions() {
    const q = S.input.trim();
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const base = filter(S.clauses.filter((c) => c.on && c !== focus), S.mode, S.yearUnset);
    if (!q) return { out: [], allOut: [], kindCounts: {}, base, disambig: false, total: 0 };

    const fq = fold(q);
    const tags = [];
    for (const t of tagIndex.values()) {
      if (focus && focus.kind !== t.kind) continue;
      if (focus && focus.values.includes(t.value)) continue;
      const f = fold(t.value);
      const at = f.indexOf(fq);
      if (at < 0) continue;
      tags.push({ t, f, score: (at === 0 ? 2 : 0) + (f === fq ? 3 : 0) });
    }
    const countFor = (kind, value) => {
      const c = { kind, values: [value], on: true };
      let n = 0;
      for (const s of base) if (clauseMatch(c, s)) n++;
      return n;
    };
    tags.sort((a, b) => b.score - a.score || b.t.count - a.t.count);

    // Group spelling variants per kind+folded form
    const groups = new Map();
    for (const x of tags) {
      const k = x.t.kind + "|" + x.f;
      if (!groups.has(k)) groups.set(k, { score: x.score, list: [] });
      groups.get(k).list.push(x.t);
    }

    const allTagCandidates = [];
    for (const [, g] of groups) {
      g.list.sort((a, b) => b.count - a.count);
      const head = g.list[0];
      allTagCandidates.push({
        kind: head.kind,
        value: head.value,
        score: g.score,
        n: countFor(head.kind, head.value),
        total: head.count,
        variants: g.list.slice(1).map((v) => ({ value: v.value, total: v.count })),
      });
    }

    const extra = [];
    if (!focus) {
      let n = 0;
      const tc = { kind: "text", values: [q], on: true };
      for (const s of base) if (clauseMatch(tc, s)) n++;
      extra.push({ kind: "text", value: q, label: `曲名・アーティストに「${q}」を含む`, n, score: 1 });
    }
    if (!focus || focus.kind === "artist") {
      const arts = new Map();
      for (const s of base) {
        if (s.artist && fold(s.artist).includes(fq)) arts.set(s.artist, (arts.get(s.artist) || 0) + 1);
        if (arts.size > 60) break;
      }
      [...arts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([a, n]) => {
        extra.push({ kind: "artist", value: a, n, score: fold(a) === fq ? 4 : 1 });
      });
    }

    const lead = allTagCandidates.length && allTagCandidates[0].score >= 2 ? 2 : 0;
    const merged = allTagCandidates.slice();
    merged.splice(Math.min(lead, merged.length), 0, ...extra);

    // Detect exact-query kind collision (e.g., year:2015 vs custom:2015, genre:アニソンremix vs custom:アニソンremix)
    const exactKinds = new Set(merged.filter((o) => o.kind !== "text" && fold(o.value) === fq).map((o) => o.kind));
    const disambig = exactKinds.size >= 2 || (exactKinds.size >= 1 && /^\d{4}$/.test(q));

    const kindCounts = { all: merged.length, year: 0, genre: 0, custom: 0, text: 0 };
    for (const o of merged) {
      const k = o.kind === "artist" ? "text" : o.kind;
      kindCounts[k] = (kindCounts[k] || 0) + 1;
    }

    const filtered = S.suggKind === "all"
      ? merged
      : merged.filter((o) => (S.suggKind === "text" ? o.kind === "text" || o.kind === "artist" : o.kind === S.suggKind));
    const out = filtered.slice(0, S.suggLimit);
    return { out, allOut: filtered, kindCounts, base, disambig, total: groups.size };
  }

  // ---------------------------------------------------------------- query mutations & undo/redo
  const snapshotQuery = () => JSON.parse(JSON.stringify({ clauses: S.clauses, mode: S.mode, yearUnset: S.yearUnset }));
  function pushQueryHistory() {
    S.historyPast.push(snapshotQuery());
    if (S.historyPast.length > 30) S.historyPast.shift();
    S.historyFuture = [];
  }
  function applySnapshot(snap) {
    S.clauses = JSON.parse(JSON.stringify(snap.clauses));
    S.mode = snap.mode;
    S.yearUnset = !!snap.yearUnset;
  }
  function undoQuery() {
    if (!S.historyPast.length) return;
    S.historyFuture.push(snapshotQuery());
    applySnapshot(S.historyPast.pop());
    update();
  }
  function redoQuery() {
    if (!S.historyFuture.length) return;
    S.historyPast.push(snapshotQuery());
    applySnapshot(S.historyFuture.pop());
    update();
  }
  function remember() {
    if (!S.clauses.length && !S.yearUnset) return;
    const key = JSON.stringify([S.clauses.map((c) => [c.kind, c.values, c.not, c.on]), S.mode, S.yearUnset]);
    S.recent = S.recent.filter((r) => r.key !== key);
    S.recent.unshift({ key, snap: snapshotQuery(), n: result.length });
    S.recent = S.recent.slice(0, 6);
  }
  function addValue(kind, value, opts = {}) {
    pushQueryHistory();
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    if (focus && focus.kind === kind && kind !== "text") {
      if (!focus.values.includes(value)) focus.values.push(value);
    } else if (kind === "year" && S.clauses.some((c) => c.kind === "year" && c.on && !c.not) && !Array.isArray(value)) {
      const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
      if (yc.values.includes(value)) yc.values = yc.values.filter((v) => v !== value);
      else yc.values.push(value);
      if (!yc.values.length) S.clauses = S.clauses.filter((c) => c !== yc);
    } else {
      S.clauses.push({ id: uid++, kind, values: Array.isArray(value) ? value : [value], on: true, not: !!opts.not });
    }
    S.input = "";
    S.sugIndex = 0;
    S.suggKind = "all";
    S.suggLimit = 12;
    S.focusClause = null;
    update();
    remember();
  }
  function removeClause(id, silent) {
    const i = S.clauses.findIndex((c) => c.id === id);
    if (i < 0) return;
    pushQueryHistory();
    const [c] = S.clauses.splice(i, 1);
    if (S.focusClause === id) S.focusClause = null;
    update();
    if (!silent) toast(`条件「${clauseText(c)}」を外しました`, "元に戻す", () => undoQuery());
  }
  function removeValue(id, v) {
    const c = S.clauses.find((x) => x.id === id);
    if (!c) return;
    if (c.values.length === 1) return removeClause(id);
    pushQueryHistory();
    const i = c.values.indexOf(v);
    c.values.splice(i, 1);
    update();
    toast(`「${v}」を外しました`, "元に戻す", () => undoQuery());
  }
  const clauseText = (c) => c.values.map((v) => (c.kind === "year" ? v + "年" : v)).join(" または ");

  function addTo(destId, ids, from) {
    const d = playlists.find((p) => p.id === destId);
    const list = L[destId];
    const missingHits = ids.filter((id) => byId.get(id).missing).length;
    const nonFunkotHits = d.kind !== "fav" && !S.allowNonFunkot
      ? ids.filter((id) => { const s = byId.get(id); return !s.missing && s.analyzed && !s.funkot; }).length : 0;
    const validIds = ids.filter((id) => {
      const s = byId.get(id);
      if (s.missing) return false;
      if (d.kind !== "fav" && !S.allowNonFunkot && s.analyzed && !s.funkot) return false;
      return true;
    });
    if (!validIds.length) {
      if (missingHits) toast("ファイルが見つからないため追加できません");
      else if (nonFunkotHits) toast("非Funkotのため追加できません（タグ編集は可能です）");
      return;
    }
    if (d.kind === "fav") {
      const has = new Set(list.map((x) => x.id));
      const fresh = validIds.filter((id) => !has.has(id));
      const removed = validIds.length === 1 && has.has(validIds[0]);
      if (removed) {
        const at = list.findIndex((x) => x.id === validIds[0]);
        const [it] = list.splice(at, 1);
        render();
        toast(`「${byId.get(validIds[0]).title}」をお気に入りから外しました`, "元に戻す", () => { list.splice(at, 0, it); render(); });
        return;
      }
      fresh.forEach((id) => list.push({ id, fresh: true }));
      fly(from); render();
      toast(
        fresh.length === 1
          ? `「${byId.get(fresh[0]).title}」をお気に入りに登録しました`
          : `${fresh.length}曲をお気に入りに登録しました`,
        "元に戻す",
        () => { fresh.forEach((id) => { const k = list.findIndex((x) => x.id === id); if (k >= 0) list.splice(k, 1); }); render(); }
      );
      return;
    }
    list.forEach((x) => (x.fresh = false));
    let at = list.length;
    if (destId === "queue") {
      at = list.findIndex((x) => x.auto);
      if (at < 0) at = list.length;
    }
    const items = validIds.map((id) => ({ id, auto: false, fresh: true }));
    list.splice(at, 0, ...items);
    const pos = at + 1;
    S.lastAdded = validIds.length === 1 ? { id: validIds[0], dest: destId, pos } : null;
    fly(from); render();
    const skippedNote = nonFunkotHits ? `（非Funkot ${nonFunkotHits}曲を除外）` : "";
    toast(
      validIds.length === 1
        ? `「${byId.get(validIds[0]).title}」を${d.name}の${pos}番目に追加しました`
        : `${validIds.length}曲を${d.name}の${pos}番目から追加しました${skippedNote}`,
      "取り消す",
      () => { list.splice(at, items.length); S.lastAdded = null; render(); }
    );
  }

  // ---------------------------------------------------------------- render: query & 1-line summary
  function termHTML(c) {
    const vals = c.values.map((v, i) => `${i ? '<span class="t-or">または</span>' : ""}<span class="t-label">${esc(c.kind === "year" ? v + "年" : v)}</span>`).join("");
    const st = c.on ? (c.not ? "（これ以外）" : "") : "（一時停止中）";
    return `<span class="term-wrap" data-cid="${c.id}"><button class="term${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}" type="button" data-kind="${c.kind}" data-act="edit-clause" data-id="${c.id}" aria-label="${esc(KIND_NAME[c.kind] + " " + clauseText(c) + st)}。押すと条件を整理">${'<i class="t-mark" aria-hidden="true"></i>'}${vals}</button><button class="term-x" type="button" data-act="rm-clause" data-id="${c.id}" aria-label="条件「${esc(clauseText(c))}」を外す" title="この条件を外す">${ICON.x}</button></span>`;
  }

  function renderQuery() {
    const st = $("#status");
    st.className = "status";
    if (S.sim === "loading") st.innerHTML = `<span>${fmtN(songs.length)}曲を照合しています…</span>`;
    else if (S.sim === "error") {
      st.className = "status is-error";
      st.innerHTML = `<span>検索を更新できませんでした。タグを読み込めません。下は前回の結果です</span><button type="button" data-act="retry">再試行</button>`;
    } else st.innerHTML = "";
    st.hidden = !st.innerHTML;

    const box = $("#summary");
    const p = pendingClause();
    const totalActiveTerms = S.clauses.length + (S.yearUnset ? 1 : 0);
    if (!totalActiveTerms && !p) {
      box.hidden = true;
      box.innerHTML = "";
    } else {
      box.hidden = false;
      const join = S.mode === "all" ? "かつ" : "または";
      let h = S.clauses.map((c, i) => (i ? `<span class="t-join" aria-hidden="true">${join}</span>` : "") + termHTML(c)).join("");
      if (S.yearUnset) {
        h += `${S.clauses.length ? '<span class="t-join" aria-hidden="true">かつ</span>' : ""}<span class="term-wrap" data-unset="1"><button class="term" type="button" data-kind="unset" data-act="manage-lens" aria-label="制作年が未設定（常にAND）。押すと条件を整理"><i class="t-mark" aria-hidden="true"></i><span class="t-label">制作年が未設定</span></button><button class="term-x" type="button" data-act="toggle-unset" aria-label="制作年が未設定を外す" title="外す">${ICON.x}</button></span>`;
      }
      if (p) {
        h += `${totalActiveTerms ? `<span class="t-join" aria-hidden="true">${join}</span>` : ""}<span class="term is-ghost" data-kind="${p.kind === "artist" ? "text" : p.kind}"><i class="t-mark" aria-hidden="true"></i><span class="t-label">${esc(p.kind === "year" ? p.values[0] + "年" : p.values[0])}</span><span class="ghost-note">選択中</span></span>`;
      }
      const paused = S.clauses.filter((c) => !c.on).length;
      const negated = S.clauses.filter((c) => c.not).length;
      box.innerHTML = `<div class="terms" id="terms">${h}</div>${totalActiveTerms ? `<button class="sum-edit" type="button" data-act="manage-lens" aria-label="条件を整理（${totalActiveTerms}件${paused ? `・停止${paused}` : ""}${negated ? `・除外${negated}` : ""}）">条件を整理</button><button class="sum-clear icon-btn" type="button" data-act="clear-all" aria-label="条件をすべて外す" title="条件をすべて外す">${ICON.x}</button>` : ""}`;
      fitTerms($("#terms"));
    }
    const fi = $("#finderInput");
    if (fi.value !== S.input) fi.value = S.input;
    fi.setAttribute("aria-expanded", String(S.lens));
  }

  function fitTerms(box) {
    if (!box || box.scrollWidth <= box.clientWidth + 1) return;
    const items = [...box.children];
    const hiddenItems = [];
    const more = document.createElement("button");
    more.type = "button";
    more.className = "t-more";
    more.dataset.act = "manage-lens";
    box.appendChild(more);
    while (box.scrollWidth > box.clientWidth + 1 && items.length > 1) {
      const e = items.pop();
      e.hidden = true;
      if (e.classList.contains("term-wrap")) hiddenItems.push(e);
      let pausedHidden = 0;
      let notHidden = 0;
      for (const hw of hiddenItems) {
        if (hw.querySelector(".term.is-off")) pausedHidden++;
        if (hw.querySelector(".term.is-not")) notHidden++;
      }
      const tags = [];
      if (pausedHidden) tags.push(`停止${pausedHidden}`);
      if (notHidden) tags.push(`除外${notHidden}`);
      const suffix = tags.length ? `（${tags.join("・")}）` : "";
      more.textContent = `ほか${hiddenItems.length}つ${suffix}`;
      more.setAttribute("aria-label", `ほか${hiddenItems.length}つの条件を表示して整理${suffix}`);
    }
    const vis = items.filter((e) => !e.hidden);
    if (vis.length && vis[vis.length - 1].classList.contains("t-join")) vis[vis.length - 1].hidden = true;
  }

  // ---------------------------------------------------------------- render: Area A lens (Palette + Condition Ledger)
  function renderLens() {
    const el = $("#lens");
    el.hidden = !S.lens;
    if (!S.lens) return;

    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const totalTerms = S.clauses.length + (S.yearUnset ? 1 : 0);
    const showManage = S.lensView === "manage" && totalTerms > 0 && !focus;

    const head = `<div class="lens-head">
      <button class="icon-btn" type="button" data-act="close-lens" aria-label="検索画面を閉じる">${ICON.back}</button>
      <label class="finder-field">
        <input id="lensInput" type="search" autocomplete="off" value="${esc(S.input)}" placeholder="タグ・年・曲名を入力" aria-label="タグ・年・曲名を入力" aria-controls="suggList">
        ${S.input ? `<button class="clear-input-btn" type="button" data-act="clear-input" aria-label="入力を消す">${ICON.x}</button>` : ""}
      </label>
    </div>`;

    let strip = "";
    if (!showManage && totalTerms > 0 && !focus) {
      const hasAdv = S.mode === "any" || S.clauses.some((c) => !c.on || c.not || c.values.length > 1) || S.yearUnset;
      const pills = S.clauses.map((c) => `<span class="mini-clause${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}"><span class="k-mark" data-kind="${c.kind}" aria-hidden="true"></span><span class="mini-clause-text">${c.not ? "除外: " : ""}${esc(clauseText(c))}</span><button type="button" data-act="rm-clause" data-id="${c.id}" aria-label="「${esc(clauseText(c))}」を外す">${ICON.x}</button></span>`).join("");
      const unsetPill = S.yearUnset ? `<span class="mini-clause"><span class="k-mark" data-kind="unset" aria-hidden="true"></span><span class="mini-clause-text">制作年が未設定</span><button type="button" data-act="toggle-unset" aria-label="制作年が未設定を外す">${ICON.x}</button></span>` : "";
      const modeHint = S.mode === "any" && S.clauses.length > 1 ? '<span class="lens-strip-lbl">（どれかに一致）</span>' : "";
      strip = `<div class="lens-strip"><span class="lens-strip-lbl">いまの条件</span>${modeHint}${pills}${unsetPill}<button class="strip-link" type="button" data-act="to-manage">${hasAdv ? `条件を整理 (${totalTerms})` : "条件を詳しく調整"}</button></div>`;
    }

    const altBanner = focus
      ? `<div class="alt-banner"><span>「${KIND_NAME[focus.kind]}: ${esc(clauseText(focus))}」に「または」の候補を追加中</span><button type="button" data-act="cancel-alt">完了</button></div>`
      : "";

    let body = "";
    if (S.sim === "error") {
      body = `<section><h2>候補を読み込めませんでした</h2><p class="lens-empty">タグの一覧を読めないため、候補と件数を出せません。曲名とアーティストの検索は使えます。</p><button class="btn sm" type="button" data-act="retry">再試行</button></section>`;
    } else if (showManage) {
      body = renderConditionLedger();
    } else if (S.input.trim()) {
      body = renderSuggestions(focus);
    } else {
      body = renderBrowse(focus);
    }

    const foot = `<div class="lens-foot">
      <span class="lens-foot-note">${showManage ? "条件を整理中・Escで閉じる" : "Escで閉じる"}</span>
      ${showManage && S.historyPast.length ? `<button class="btn sm" type="button" data-act="undo-query">元に戻す</button>` : ""}
      <button class="btn sm" type="button" data-act="clear-all" ${totalTerms ? "" : "disabled"}>すべて外す</button>
      <button class="btn primary" type="button" data-act="close-lens">${S.sim === "loading" ? "照合中…" : fmtN(result.length) + "曲を表示"}</button>
    </div>`;

    el.innerHTML = head + strip + altBanner + `<div class="lens-body" id="lensBody">${body}</div>` + foot;
  }

  function renderConditionLedger() {
    const joinWord = S.mode === "all" ? "かつ" : "または";
    const pausedCount = S.clauses.filter((c) => !c.on).length;
    const exprParts = S.clauses.filter((c) => c.on).map((c) => {
      const txt = c.values.length > 1 ? `(${clauseText(c)})` : clauseText(c);
      return c.not ? `「${txt}」以外` : txt;
    });
    let expr = exprParts.join(` ${joinWord} `);
    if (S.yearUnset) expr = expr ? `(${expr}) かつ 制作年が未設定` : "制作年が未設定";
    if (!expr) expr = "一時停止中の条件のみ（全曲表示）";

    const rowsHTML = S.clauses.map((c, i) => `
      <div class="ledger-row${c.on ? "" : " is-off"}${c.not ? " is-not" : ""}" data-id="${c.id}">
        <div class="lr-join">${!c.on ? "停止中" : i === 0 ? "条件1" : joinWord}</div>
        <div class="lr-kind"><span class="k-mark" data-kind="${c.kind}" aria-hidden="true"></span><span>${KIND_NAME[c.kind]}</span></div>
        <div class="lr-vals">
          ${c.values.map((v, k) => `${k ? '<span class="val-or">または</span>' : ""}<span class="val"><span>${esc(c.kind === "year" ? v + "年" : v)}</span><button type="button" data-act="rm-val" data-id="${c.id}" data-v="${esc(v)}" aria-label="「${esc(v)}」を外す">${ICON.x}</button></span>`).join("")}
          ${c.kind !== "text" ? `<button class="add-alt" type="button" data-act="alt" data-id="${c.id}">＋または</button>` : ""}
        </div>
        <div class="lr-tools">
          <button class="not-pill" type="button" data-act="not" data-id="${c.id}" aria-pressed="${c.not}" title="この条件を含まない曲に絞る">これ以外</button>
          <button class="switch" type="button" role="switch" data-act="toggle" data-id="${c.id}" aria-checked="${c.on}" aria-label="条件「${esc(clauseText(c))}」を有効にする"><i></i></button>
          <button class="icon-btn lr-del" type="button" data-act="rm-clause" data-id="${c.id}" aria-label="条件「${esc(clauseText(c))}」を外す">${ICON.trash}</button>
        </div>
      </div>`).join("");

    const unsetRow = S.yearUnset ? `
      <div class="ledger-row" data-unset="1">
        <div class="lr-join">常にAND</div>
        <div class="lr-kind"><span class="k-mark" data-kind="unset" aria-hidden="true"></span><span>制作年</span></div>
        <div class="lr-vals"><span class="val"><span>未設定（確認済み・手動固定）</span><button type="button" data-act="toggle-unset" aria-label="制作年が未設定を外す">${ICON.x}</button></span></div>
        <div class="lr-tools"><button class="icon-btn lr-del" type="button" data-act="toggle-unset" aria-label="制作年が未設定を外す">${ICON.trash}</button></div>
      </div>` : "";

    const seg = S.clauses.length > 1 ? `<span class="seg" role="radiogroup" aria-label="複数条件の一致方法">
      <button type="button" role="radio" data-act="set-mode" data-v="all" aria-checked="${S.mode === "all"}">すべてに一致 (AND)</button>
      <button type="button" role="radio" data-act="set-mode" data-v="any" aria-checked="${S.mode === "any"}">どれかに一致 (OR)</button>
    </span>` : "";

    return `
      <div class="ledger-top">
        <div class="logic-preview">
          <span><strong>一致する曲：</strong>${esc(expr)}${pausedCount ? `（停止 ${pausedCount}件）` : ""}</span>
          <span><strong>${fmtN(result.length)}曲</strong></span>
        </div>
        <div class="ledger-toolbar">
          ${seg}
          <button class="tool-btn" type="button" data-act="toggle-unset" aria-pressed="${S.yearUnset}">制作年が未設定 (常にAND)</button>
          ${pausedCount ? `<button class="tool-btn" type="button" data-act="resume-all">停止中を再開 (${pausedCount})</button>` : ""}
          <button class="tool-btn" type="button" data-act="undo-query" ${S.historyPast.length ? "" : "disabled"}>元に戻す</button>
          <button class="tool-btn" type="button" data-act="redo-query" ${S.historyFuture.length ? "" : "disabled"}>やり直す</button>
          <button class="tool-btn" type="button" data-act="to-add" style="margin-left:auto">＋ 条件を追加</button>
        </div>
      </div>
      <div class="ledger-rows">${rowsHTML}${unsetRow}</div>`;
  }

  function hl(text) {
    const q = S.input.trim();
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function renderSuggestions(focus) {
    const { out, allOut, kindCounts, disambig, total } = sugg.allOut.length || S.input.trim() ? sugg : suggestions();
    const kinds = [
      ["all", "すべて"],
      ["year", "制作年"],
      ["genre", "ジャンル"],
      ["custom", "任意タグ"],
      ["text", "曲名・アーティスト"],
    ].filter(([k]) => k === "all" || (kindCounts[k] || 0) > 0);

    const tabsHTML = !focus && kinds.length > 2
      ? `<div class="kind-tabs" role="group" aria-label="候補の種類で絞り込む">${kinds.map(([k, lbl]) => `<button class="kind-tab" type="button" data-act="sugg-kind" data-k="${k}" aria-pressed="${S.suggKind === k}"><span>${lbl}</span><span class="n">${fmtN(kindCounts[k] || 0)}</span></button>`).join("")}</div>`
      : "";

    const disambigHTML = disambig && S.suggKind === "all"
      ? `<div class="disambig-note">「${esc(S.input.trim())}」は種類（制作年 / ジャンル / 任意タグ / 文字検索）によって対象が異なります。行の印と種別を確認して選べます。</div>`
      : "";

    const remain = Math.max(0, allOut.length - out.length);
    return `<section>
      <h2>${focus ? `「${esc(clauseText(focus))}」に追加できる${KIND_NAME[focus.kind]}` : "候補"} <span class="aside">${total ? `関連タグ ${fmtN(total)}件` : ""}</span></h2>
      ${tabsHTML}${disambigHTML}
      <ul class="sugg-list" role="listbox" id="suggList" aria-label="検索候補">${out.map((o, i) => suggHTML(o, i)).join("")}</ul>
      ${remain > 0 ? `<button class="btn sm show-more-sugg" type="button" data-act="more-sugg">さらに候補を表示（残り ${fmtN(remain)} 件）</button>` : ""}
      ${!out.length ? `<p class="lens-empty">「${esc(S.input)}」に一致する候補はありません。</p>` : ""}
    </section>`;
  }

  function suggHTML(o, i) {
    const dead = o.n === 0;
    let sub = "";
    if (o.kind === "text") sub = "曲名・アーティスト名の文字列として絞り込む";
    else if (o.kind === "artist") sub = `アーティスト（現在の候補内で ${fmtN(o.n)}曲）`;
    else if (o.kind === "year") sub = `曲の制作年として一致（全体 ${fmtN(o.total)}曲）`;
    else if (o.kind === "genre") sub = `ジャンル分類として一致（全体 ${fmtN(o.total)}曲）`;
    else sub = `任意タグ名として一致・制作年やジャンルとは別（全体 ${fmtN(o.total)}曲）`;

    const n = o.n === undefined ? "" : dead ? "加えると 0曲" : `加えると <b>${fmtN(o.n)}</b>曲`;
    let h = `<li class="sugg${dead ? " is-dead" : ""}" role="option" id="sg${i}" aria-selected="${i === S.sugIndex}" data-act="pick" data-kind="${o.kind}" data-v="${esc(o.value)}">
      <span class="sugg-ico" data-kind="${o.kind}" aria-hidden="true"></span>
      <span class="sugg-main">
        <span class="sugg-head"><span class="sugg-name">${o.kind === "text" ? esc(o.label) : hl(o.value)}</span><span class="kind-pill" data-kind="${o.kind}">${KIND_NAME[o.kind]}</span></span>
        <span class="sugg-sub">${sub}</span>
      </span>
      <span class="sugg-n">${n}</span></li>`;

    if (o.variants && o.variants.length) {
      h += `<li class="sugg-variants" role="presentation">表記揺れ: ${o.variants.map((v) => `${esc(v.value)}（${fmtN(v.total)}曲）`).join("、")}
        <button type="button" data-act="pick-group" data-kind="${o.kind}" data-vs="${esc(JSON.stringify([o.value, ...o.variants.map((v) => v.value)]))}">まとめて「どれか」で追加</button></li>`;
    }
    return h;
  }

  function renderBrowse(focus) {
    const base = filter(S.clauses.filter((c) => c.on && c !== focus), S.mode, S.yearUnset);
    const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
    const yBase = filter(S.clauses.filter((c) => c.on && c !== yc), S.mode, false);
    const yc2 = new Map();
    yBase.forEach((s) => s.year && yc2.set(s.year, (yc2.get(s.year) || 0) + 1));
    const max = Math.max(1, ...yc2.values());
    let years = "";
    for (let y = 2008; y <= 2026; y++) {
      const n = yc2.get(y) || 0;
      const on = yc && yc.values.includes(String(y));
      years += `<button class="year-bar" type="button" data-act="year" data-v="${y}" aria-pressed="${!!on}" aria-label="${y}年 ${fmtN(n)}曲"><i style="height:${Math.max(2, (n / max) * 68)}px"></i><span>${String(y).slice(2)}</span></button>`;
    }
    const unsetConfirmed = yBase.filter(matchesYearUnset).length;
    const pendingYearCount = yBase.filter((s) => s.year === null && !matchesYearUnset(s)).length;

    const gc = new Map();
    const tc = new Map();
    base.forEach((s) => {
      s.genres.forEach((g) => gc.set(g, (gc.get(g) || 0) + 1));
      s.tags.forEach((t) => tc.set(t, (tc.get(t) || 0) + 1));
    });
    const used = new Set(S.clauses.flatMap((c) => c.values));
    const top = (m, k) => [...m.entries()].filter(([v]) => !used.has(v)).sort((a, b) => b[1] - a[1]).slice(0, k);
    const chip = (kind) => ([v, n]) => `<button class="chip" type="button" data-kind="${kind}" data-act="pick" data-v="${esc(v)}"><span>${esc(v)}</span><span class="n">${fmtN(n)}</span></button>`;
    const onlyKind = focus ? focus.kind : null;

    const yearSec = !onlyKind || onlyKind === "year" ? `<section class="years-wrap">
      <h2>制作年 <span class="aside">${S.clauses.length ? "現在の条件での曲数・複数選択で「どれか」" : "押すと条件に追加"}</span></h2>
      <div class="years">${years}</div>
      <div class="unset-row">
        <button class="unset-pill" type="button" data-act="toggle-unset" aria-pressed="${S.yearUnset}">制作年が未設定のみ (${fmtN(unsetConfirmed)}曲)</button>
        ${pendingYearCount ? `<span class="years-note">※ 取得待ち ${fmtN(pendingYearCount)}曲は未確定のため除外</span>` : ""}
      </div>
    </section>` : "";

    const genreSec = !onlyKind || onlyKind === "genre" ? `<section>
      <h2>ジャンル <span class="aside">多い順</span></h2>
      <div class="chips">${top(gc, 10).map(chip("genre")).join("")}</div>
    </section>` : "";

    const tagSec = !onlyKind || onlyKind === "custom" ? `<section>
      <h2>よく使われるタグ <span class="aside">全${fmtN([...tagIndex.values()].filter((t) => t.kind === "custom").length)}件は入力で検索</span></h2>
      <div class="chips">${top(tc, 12).map(chip("custom")).join("")}</div>
    </section>` : "";

    const recentSec = !onlyKind && S.recent.length ? `<section>
      <h2>最近の条件</h2>
      <div class="recent">${S.recent.map((r, i) => {
        const lbl = [...r.snap.clauses.map(clauseText), ...(r.snap.yearUnset ? ["制作年が未設定"] : [])].join(" ＋ ");
        return `<button type="button" data-act="recent" data-i="${i}"><span class="r-terms">${esc(lbl)}</span><span class="r-n">${fmtN(r.n)}曲</span></button>`;
      }).join("")}</div>
    </section>` : "";

    return `<div class="browse-grid"><div>${yearSec}${recentSec}</div><div>${genreSec}${tagSec}</div></div>`;
  }

  // ---------------------------------------------------------------- render: results (non-target rows preserved)
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
    const hits = S.mode === "any" ? [String(s.year), ...s.genres, ...s.tags].filter((t) => terms.has(t)) : [];
    const twins = twinCount.get(twinKey(s)) || 1;
    const open = S.open === s.id;
    const justAdded = S.lastAdded && S.lastAdded.id === s.id && S.lastAdded.dest === S.dest;
    const nonFunkotGated = !isFav && !S.allowNonFunkot && s.analyzed && !s.funkot;

    let state = "";
    if (s.missing) state = '<span class="st bad">ファイルなし</span>';
    else if (justAdded && !isFav) state = `<span class="st in">✓ ${esc(d.name)}の${S.lastAdded.pos}番目</span>`;
    else if (inDest) state = `<span class="st in">${isFav ? "♥ 登録済み" : `✓ ${esc(d.name)}にあり`}</span>`;

    const title = s.untitled
      ? `<span class="row-title is-untitled">${esc(s.title)}.${s.fmt.toLowerCase()}</span>`
      : `<span class="row-title">${esc(main)}${mix ? `<span class="mix">${esc(mix)}</span>` : ""}</span>`;
    const addLabel = s.missing
      ? `「${s.title}」はファイルが見つからないため追加できません`
      : nonFunkotGated
      ? `「${s.title}」は非Funkotのため追加できません`
      : isFav
      ? (inDest ? `「${s.title}」をお気に入りから外す` : `「${s.title}」をお気に入りに登録`)
      : `「${s.title}」を${d.name}に追加`;
    const addIcon = isFav ? (inDest ? ICON.heart : ICON.heartO) : justAdded ? ICON.check : ICON.plus;
    const sel = S.selected.has(s.id);
    const ariaName = (s.untitled ? s.title + "." + s.fmt.toLowerCase() : s.title) + "、" + (s.artist || "アーティスト情報なし") + (playing ? "、再生中" : "");

    return `<li class="row${open ? " is-open" : ""}${S.selectMode ? " is-select" : ""}${S.active === s.id ? " is-active" : ""}${playing ? " is-playing" : ""}" data-id="${s.id}" style="--dest:${INK[d.ink]}">
      ${S.selectMode ? `<button class="row-check" type="button" role="checkbox" aria-checked="${sel}" data-act="sel" data-id="${s.id}" aria-label="「${esc(s.title)}」を選択"><i></i></button>` : ""}
      <span class="row-mark" aria-hidden="true">${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</span>
      <button class="row-main" type="button" data-act="open" data-id="${s.id}" aria-expanded="${open}" aria-label="${esc(ariaName)}。詳細を開く">
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
      <button class="add${inDest && isFav ? " is-done" : ""}${justAdded ? " is-just" : ""}${isFav ? " is-fav" : ""}" type="button" data-act="add" data-id="${s.id}" aria-label="${esc(addLabel)}" ${s.missing || nonFunkotGated ? 'aria-disabled="true"' : ""} title="${esc(addLabel)}"><i>${addIcon}</i></button>
    </li>`;
  }

  function currentList() {
    return S.sim === "error" ? lastGood : result;
  }

  function selectionStats() {
    const list = currentList();
    const visibleMap = new Map(list.map((s) => [s.id, s]));
    const visibleSelected = [...S.selected].map((id) => visibleMap.get(id)).filter(Boolean);
    const editableVisible = visibleSelected.filter((s) => !!s.content_hash);
    const unresolvedVisible = visibleSelected.filter((s) => !s.content_hash);
    const allSelectedTracks = [...S.selected].map((id) => byId.get(id)).filter(Boolean);
    const hiddenSelectedCount = allSelectedTracks.length - visibleSelected.length;
    const queueEligible = allSelectedTracks.filter((s) => !s.missing && (S.allowNonFunkot || !s.analyzed || s.funkot));
    return {
      totalSelected: S.selected.size,
      visibleSelected,
      editableVisible,
      unresolvedVisible,
      hiddenSelectedCount,
      queueEligible,
    };
  }

  function renderResults() {
    const d = playlists.find((p) => p.id === S.dest);
    app.style.setProperty("--dest", INK[d.ink]);
    const bar = $("#resultsBar");
    const list = currentList();
    const onCount = S.clauses.filter((c) => c.on).length + (S.yearUnset ? 1 : 0);
    const n = S.sim === "loading" ? "…" : fmtN(list.length);
    const what = !onCount ? "すべての曲" : onCount === 1 ? "条件に一致" : S.mode === "all" ? `${onCount}つの条件すべてに一致` : `${S.clauses.filter((c) => c.on).length}つの条件のどれかに一致${S.yearUnset ? "（かつ年未設定）" : ""}`;
    const count = `<span class="rb-count" id="rbCount"><b>${n}</b><span>曲</span><small>${S.sim === "error" ? "前回の結果" : S.sim === "loading" ? "照合中" : what}</small></span>`;
    const destChip = `<button class="dest-chip" type="button" data-act="open-dock" aria-label="追加先: ${esc(d.name)}。押すと変える" style="--dest:${INK[d.ink]}"><i aria-hidden="true"></i><span class="lbl">追加先</span><span class="nm">${esc(d.name)}</span>${ICON.chev}</button>`;

    bar.classList.toggle("is-select", S.selectMode);
    if (S.selectMode) {
      const st = selectionStats();
      const scopeHint = st.hiddenSelectedCount > 0 ? `<span class="rb-sel-sub">（表示中 ${st.visibleSelected.length}曲・非表示 ${st.hiddenSelectedCount}曲）</span>` : "";
      const editDisabled = !st.editableVisible.length;
      const editReason = st.unresolvedVisible.length && !st.editableVisible.length ? ' title="識別未確定の曲だけ選択されているためタグ編集できません"' : "";
      bar.innerHTML = `<span class="rb-sel" role="status">${st.totalSelected}曲を選択中${scopeHint}</span><span class="grow"></span>
        <button class="rb-btn" type="button" data-act="sel-all">表示中を選択</button>
        <button class="rb-btn" type="button" data-act="sel-end">やめる</button>
        <button class="rb-edit-tags" type="button" data-act="edit-selected-tags" ${editDisabled ? "disabled" : ""}${editReason}>${ICON.tag}タグを編集 (${st.editableVisible.length})</button>
        <button class="rb-primary" type="button" data-act="add-sel" ${st.queueEligible.length ? "" : "disabled"} style="--dest:${INK[d.ink]}">${ICON.plus}${esc(d.name)}に追加 (${st.queueEligible.length})</button>`;
    } else {
      const sortOpts = Object.entries(SORTS).map(([k, [nm]]) => `<option value="${k}"${k === S.sort ? " selected" : ""}>${nm}</option>`).join("");
      bar.innerHTML = `${count}<span class="grow"></span>
        <span class="rb-tools"><label class="vh" for="sortSel">並び順</label><select id="sortSel">${sortOpts}</select><button class="rb-btn" type="button" data-act="sel-start">${ICON.select}まとめて選ぶ</button></span>
        ${destChip}
        <span class="menu-wrap rb-more"><button class="icon-btn" type="button" data-act="rb-menu" aria-haspopup="menu" aria-expanded="${!!S.rbMenu}" aria-label="並び順とまとめて選ぶ" title="並び順とまとめて選ぶ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v2H3zm4 5h10v2H7zm3 5h4v2h-4z"/></svg></button>
          <span class="menu" role="menu" ${S.rbMenu ? "" : "hidden"}>${Object.entries(SORTS).map(([k, [nm]]) => `<button type="button" role="menuitemradio" aria-checked="${k === S.sort}" data-act="sort-to" data-v="${k}">${nm}</button>`).join("")}<button type="button" role="menuitem" data-act="sel-start" class="sep">まとめて選ぶ</button></span></span>`;
    }

    const rows = $("#rows");
    const empty = $("#rowsEmpty");
    $("#results").classList.toggle("is-stale", S.sim === "error");
    if (S.sim === "loading") {
      rows.innerHTML = Array.from({ length: 7 }, () => '<li class="skeleton" aria-hidden="true"><span></span><span><i class="t"></i><i class="a"></i></span><span></span></li>').join("");
      empty.hidden = true;
      return;
    }
    if (!list.length) {
      rows.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = emptyHTML();
      return;
    }
    empty.hidden = true;
    rows.innerHTML = list.slice(0, S.limit).map(rowHTML).join("");
  }

  function emptyHTML() {
    const act = S.clauses.filter((c) => c.on);
    // Diagnose structural year contradiction
    const activeYears = act.filter((c) => c.kind === "year" && !c.not);
    let conflictHTML = "";
    if (S.mode === "all" && activeYears.length > 1) {
      conflictHTML = `<div class="conflict-box"><span>1曲に制作年は1つだけのため、異なる制作年（${activeYears.map(clauseText).join(" と ")}）を「すべてに一致 (AND)」にすると一致しません。</span><div><button class="btn sm" type="button" data-act="merge-years">制作年を「または」にまとめる</button></div></div>`;
    } else if (S.yearUnset && activeYears.length >= 1) {
      conflictHTML = `<div class="conflict-box"><span>「制作年が未設定」と特定の制作年は同時に満たせません。</span><div><button class="btn sm" type="button" data-act="toggle-unset">制作年が未設定を外す</button></div></div>`;
    }

    const relax = act.map((c) => ({
      cs: [c],
      n: filter(activeClauses().filter((x) => x !== c), S.mode, S.yearUnset).length,
    })).sort((a, b) => b.n - a.n);

    let pairs = [];
    if (relax.length > 2 && (!relax.length || relax[0].n === 0)) {
      for (let i = 0; i < act.length; i++) {
        for (let j = i + 1; j < act.length; j++) {
          pairs.push({
            cs: [act[i], act[j]],
            n: filter(activeClauses().filter((x) => x !== act[i] && x !== act[j]), S.mode, S.yearUnset).length,
          });
        }
      }
      pairs = pairs.filter((p) => p.n).sort((a, b) => b.n - a.n).slice(0, 3);
    }

    const opt = ({ cs, n }) => `<div class="relax-item">
      <span class="what"><strong>${cs.map((c) => esc(clauseText(c))).join(" と ")}</strong></span>
      <span class="n">${fmtN(n)}曲</span>
      ${cs.length === 1 ? `<button class="btn sm" type="button" data-act="pause-clause" data-id="${cs[0].id}">一時停止</button>` : ""}
      <button class="btn sm" type="button" data-act="rm-clauses" data-ids="${cs.map((c) => c.id).join(",")}">外す</button>
    </div>`;

    return `<h3>条件に一致する曲はありません</h3>
      ${conflictHTML}
      <p>${pairs.length ? "1つの条件を外すだけでは見つかりません。2つ外すと次の件数になります。" : "条件を一時停止または外すと、次の件数が見つかります（一時停止は条件を残せます）。"}</p>
      <div class="relax">${(pairs.length ? pairs : relax).map(opt).join("")}</div>
      ${S.mode === "all" && act.length > 1 ? `<p style="margin-top:14px"><button class="btn" type="button" data-act="mode">どれかに一致 (OR) に切り替える（${fmtN(filter(act, "any", S.yearUnset).length)}曲）</button></p>` : ""}`;
  }

  // ---------------------------------------------------------------- render: Area B Liner Inspector Sheet
  function renderInspector() {
    const el = $("#inspector");
    const s = S.open !== null ? byId.get(S.open) : null;
    app.classList.toggle("inspector-open", !!s);
    el.hidden = !s;
    if (!s) {
      el.innerHTML = "";
      return;
    }

    const list = currentList();
    const pos = list.findIndex((x) => x.id === s.id);
    const prevSong = pos > 0 ? list[pos - 1] : null;
    const nextSong = pos >= 0 && pos < list.length - 1 ? list[pos + 1] : null;
    const [mainTitle, mixVer] = splitTitle(s.title);
    const d = playlists.find((p) => p.id === S.dest);
    const inDest = L[S.dest].some((x) => x.id === s.id);
    const fav = L.fav.some((x) => x.id === s.id);
    const playing = s.id === nowPlaying.id;
    const nonFunkotGated = d.kind !== "fav" && !S.allowNonFunkot && s.analyzed && !s.funkot;
    const terms = new Set(activeClauses().filter((c) => !c.not).flatMap((c) => c.values));

    const badges = [];
    if (playing) badges.push('<span class="insp-badge playing">♪ いま再生中</span>');
    if (inDest) badges.push(`<span class="insp-badge in-dest">✓ ${esc(d.name)}にあり</span>`);
    if (fav) badges.push('<span class="insp-badge">♥ お気に入り</span>');
    if (s.missing) badges.push('<span class="insp-badge bad">ファイルが見つかりません</span>');
    if (s.analyzed && !s.funkot) badges.push('<span class="insp-badge warn">非Funkot</span>');
    else if (!s.analyzed) badges.push('<span class="insp-badge">未解析</span>');

    let yearHTML = "";
    const ysNote = { auto: "自動", manual: "手動指定", unset: "未設定に固定", missing: "未設定" }[s.yearStatus] || "";
    if (s.year !== null) {
      yearHTML = `<span>${s.year}年</span> <span class="fact-note">${ysNote}</span>`;
    } else if (s.year_status === "conflict" || s.year_status === "future" || s.year_status === "invalid") {
      yearHTML = `<span class="insp-badge warn">⚠ ${YEAR_STATUS_LABEL[s.year_status]}</span>
        ${s.content_hash ? `<button class="fact-action" type="button" data-act="open-tag-editor" data-id="${s.id}">候補から選ぶ</button>` : ""}`;
    } else {
      yearHTML = `<span>未設定</span> <span class="fact-note">${ysNote}</span>`;
    }

    const chip = (kind) => (v) => `<button class="chip${terms.has(v) ? " is-hit" : ""}" type="button" data-act="pick-from-detail" data-kind="${kind}" data-v="${esc(v)}" title="この${KIND_NAME[kind]}を条件に加える"><span>${esc(v)}</span></button>`;
    const customFilter = S.inspectorTagFilter.trim().toLowerCase();
    const sortedCustom = [...s.tags].sort((a, b) => Number(terms.has(b)) - Number(terms.has(a)));
    const matchingCustom = customFilter ? sortedCustom.filter((v) => v.toLowerCase().includes(customFilter)) : sortedCustom;
    const BOUND = 10;
    const isBounded = !S.inspectorTagsExpanded && !customFilter && matchingCustom.length > BOUND;
    const shownCustom = isBounded ? matchingCustom.slice(0, BOUND) : matchingCustom;
    const hiddenCustomCount = matchingCustom.length - shownCustom.length;

    // Tier 2: Twins (different content_hash) vs Identical copies (same content_hash)
    const twins = songs.filter((x) => twinKey(x) === twinKey(s) && x.id !== s.id);
    const sameHashCopies = s.content_hash ? songs.filter((x) => x.content_hash === s.content_hash && x.id !== s.id) : [];
    const diffHashTwins = twins.filter((x) => !s.content_hash || x.content_hash !== s.content_hash);
    let relatedHTML = "";
    if (diffHashTwins.length || sameHashCopies.length) {
      relatedHTML = `<section class="insp-sec">
        <div class="insp-sec-head"><h3>同名ファイル・コピー</h3></div>
        ${diffHashTwins.length ? `<div class="insp-tag-group">
          <div class="insp-tag-label">同名・別音源ファイル（形式・長さが異なる別データ）</div>
          ${[s, ...diffHashTwins].map((t) => `<div class="twin-card${t.id === s.id ? " is-current" : ""}">
            <div><b>${esc(t.fmt)}</b>　${fmtDur(t.dur)}　再生 ${t.plays}回${t.id === s.id ? "<strong>（表示中）</strong>" : ""}
              <div class="path">${esc(t.path)}</div></div>
            <div class="twin-btns">
              ${t.id !== s.id ? `<button class="btn sm" type="button" data-act="open" data-id="${t.id}">表示</button>` : ""}
              <button class="add" type="button" data-act="add" data-id="${t.id}" aria-label="${esc(t.fmt)}版を${esc(d.name)}に追加" style="--dest:${INK[d.ink]}"><i>${ICON.plus}</i></button>
            </div>
          </div>`).join("")}
        </div>` : ""}
        ${sameHashCopies.length ? `<div class="insp-tag-group">
          <div class="insp-tag-label">同一音源のコピー（同じ content hash・手動タグを共有）</div>
          ${sameHashCopies.map((c) => `<div class="twin-card"><div><b>${esc(c.fmt)}</b>　${esc(c.title)}<div class="path">${esc(c.path)}</div></div><button class="btn sm" type="button" data-act="open" data-id="${c.id}">表示</button></div>`).join("")}
        </div>` : ""}
      </section>`;
    }

    // Tier 3: Technical & Metadata details (collapsed by default unless explicitly opened or flagged)
    const hasTechAlert = s.metadata_status !== "ready" || ["conflict", "future", "invalid"].includes(s.year_status) || s.diagnostics.length > 0;
    const techHTML = `<details class="tech-details" id="inspTechDetails"${S.inspectorTechOpen ? " open" : ""}>
      <summary>ファイル・メタデータ詳細 ${hasTechAlert ? '<span class="insp-badge warn">注意あり</span>' : ""}</summary>
      <div class="tech-body">
        <dl class="tech-dl">
          <dt>ファイルパス</dt>
          <dd><div class="path-row"><span class="mono">${esc(s.path)}</span><button class="btn sm" type="button" data-act="copy-path" data-path="${esc(s.path)}">コピー</button></div></dd>
          <dt>ファイル識別</dt>
          <dd class="mono">${s.content_hash ? esc(s.content_hash) : "未確定（スキャン待ち）"}</dd>
          <dt>解析状態</dt>
          <dd>${!s.analyzed ? "未解析" : s.funkot ? "Funkot認識済み" : "非Funkot"}</dd>
          <dt>メタデータ</dt>
          <dd>${META_STATUS_LABEL[s.metadata_status] || s.metadata_status} / 制作年判定: ${YEAR_STATUS_LABEL[s.year_status] || s.year_status}</dd>
          <dt>手動年の設定</dt>
          <dd>${s.manual.year.mode === "set" ? `手動指定 (${s.manual.year.value}年)` : s.manual.year.mode === "unset" ? "未設定に固定" : "自動"}</dd>
        </dl>
        <div>
          <div class="insp-tag-label" style="margin-bottom:4px">埋め込み制作年の候補 (${s.candidates.length}件)</div>
          ${s.candidates.length ? `<ul class="cand-list">${s.candidates.map((c) => `<li class="cand-item"><span><strong>${esc(c.raw_key)}</strong> = ${esc(c.raw_value)}</span><span class="fact-note">${SEMANTIC_LABEL[c.semantic] || c.semantic}</span></li>`).join("")}</ul>` : '<p class="insp-hint">埋め込み年候補はありません</p>'}
        </div>
        <div>
          <div class="insp-tag-label" style="margin-bottom:4px">タグの由来 (${s.effective.length}件)</div>
          ${s.effective.length ? `<ul class="cand-list">${s.effective.map((e) => `<li class="cand-item"><span>${KIND_NAME[e.kind]}: <strong>${esc(e.value)}</strong></span><span class="fact-note">${ORIGIN_LABEL[e.origin] || e.origin}</span></li>`).join("")}</ul>` : '<p class="insp-hint">なし</p>'}
        </div>
        ${s.manual.suppressed_auto_tags.length ? `<div><div class="insp-tag-label" style="margin-bottom:4px">除外済みの自動タグ</div><p class="insp-hint">${s.manual.suppressed_auto_tags.map((t) => `${KIND_NAME[t.kind]}: ${esc(t.value)}`).join("、")}</p></div>` : ""}
        ${s.diagnostics.length ? `<div><div class="insp-tag-label" style="margin-bottom:4px">診断メッセージ</div><p class="mono" style="color:var(--danger);margin:0">${s.diagnostics.map(esc).join("<br>")}</p></div>` : ""}
        <p class="insp-hint">音声ファイル自体は変更しません。タグはプレイヤー内のみに保存されます。</p>
      </div>
    </details>`;

    el.innerHTML = `
      <div class="insp-head">
        <button class="icon-btn insp-back" type="button" data-act="close-detail" aria-label="一覧へ戻る">${ICON.back}</button>
        <span class="insp-head-title">曲の詳細</span>
        <button class="icon-btn" type="button" data-act="open" data-id="${prevSong ? prevSong.id : ""}" ${prevSong ? "" : "disabled"} aria-label="前の曲" title="前の曲">${ICON.up}</button>
        <button class="icon-btn" type="button" data-act="open" data-id="${nextSong ? nextSong.id : ""}" ${nextSong ? "" : "disabled"} aria-label="次の曲" title="次の曲">${ICON.down}</button>
        <button class="icon-btn" type="button" data-act="close-detail" aria-label="曲の詳細を閉じる" title="閉じる (Esc)">${ICON.x}</button>
      </div>
      <div class="insp-body">
        <div>
          ${badges.length ? `<div class="insp-status-row" style="margin-bottom:8px">${badges.join("")}</div>` : ""}
          <h2 class="insp-title">${esc(s.untitled ? `${s.title}.${s.fmt.toLowerCase()}` : mainTitle)}</h2>
          ${mixVer && !s.untitled ? `<p class="insp-version">${esc(mixVer.trim())}</p>` : ""}
          ${s.untitled ? '<p class="insp-version">曲名メタデータなし（ファイル名を表示）</p>' : ""}
          <p class="insp-artist${s.artist ? "" : " is-missing"}">${esc(s.artist || "アーティスト情報なし（埋め込み情報なし）")}</p>
        </div>

        <div class="fact-grid">
          <div class="fact-cell"><div class="fact-k">制作年</div><div class="fact-v">${yearHTML}</div></div>
          <div class="fact-cell"><div class="fact-k">長さ・形式</div><div class="fact-v">${fmtDur(s.dur)} <span class="fact-note">${esc(s.fmt)}</span></div></div>
          <div class="fact-cell"><div class="fact-k">再生回数</div><div class="fact-v">${s.plays}回</div></div>
          <div class="fact-cell"><div class="fact-k">保存フォルダ</div><div class="fact-v" style="font-size:12.5px;overflow-wrap:anywhere">${esc(s.folder)}</div></div>
        </div>

        <div>
          ${s.missing
            ? '<p class="insp-disabled-note">ファイルが見つからないため追加できません。再読み込みで元の場所に戻ると追加できます。</p>'
            : nonFunkotGated
            ? '<p class="insp-disabled-note" style="margin-bottom:8px">非Funkotとして解析されたため再生待ち等への追加は制限されています（お気に入り・タグ編集は可能です）。</p>'
            : ""}
          <div class="insp-actions" style="--dest:${INK[d.ink]}">
            ${!s.missing && d.kind !== "fav" ? `<button class="btn primary" type="button" data-act="add" data-id="${s.id}" ${nonFunkotGated ? "disabled" : ""}>${ICON.plus}${esc(d.name)}に追加</button>` : ""}
            <button class="btn" type="button" data-act="fav" data-id="${s.id}" aria-pressed="${fav}">${fav ? ICON.heart : ICON.heartO}${fav ? "お気に入り済み" : "お気に入りに登録"}</button>
            ${!s.missing ? `<button class="btn" type="button" data-act="open-dock">${ICON.list}追加先を変更</button>` : ""}
          </div>
        </div>

        <section class="insp-sec">
          <div class="insp-sec-head">
            <h3>ジャンルとタグ</h3>
            <button class="btn sm" type="button" data-act="open-tag-editor" data-id="${s.id}" ${s.content_hash ? "" : "disabled"}>${ICON.tag}タグを編集</button>
          </div>
          ${!s.content_hash ? '<p class="insp-disabled-note">この曲はまだ識別（content hash）が確定していないため、スキャン完了後にタグ編集できます。</p>' : ""}
          <div class="insp-tag-group">
            <div class="insp-tag-label">ジャンル (${s.genres.length})</div>
            <div class="insp-chips">${s.genres.map(chip("genre")).join("") || '<span class="insp-hint">なし</span>'}</div>
          </div>
          <div class="insp-tag-group">
            <div class="insp-tag-label">任意タグ (${s.tags.length})</div>
            ${(s.tags.length > BOUND && S.inspectorTagsExpanded) || customFilter ? `<label class="insp-tag-filter"><input id="inspTagFilter" type="search" value="${esc(S.inspectorTagFilter)}" placeholder="この曲のタグを絞り込む (${s.tags.length}件)…" aria-label="この曲のタグを絞り込む"></label>` : ""}
            <div class="insp-chips">${shownCustom.map(chip("custom")).join("") || `<span class="insp-hint">${customFilter ? "一致するタグがありません" : "なし"}</span>`}</div>
            ${hiddenCustomCount > 0 ? `<div><button class="btn sm" type="button" data-act="insp-expand-tags">残り ${hiddenCustomCount}件のタグをすべて表示</button></div>` : ""}
            ${S.inspectorTagsExpanded && s.tags.length > BOUND ? `<div><button class="btn sm" type="button" data-act="insp-collapse-tags">タグを折りたたむ</button></div>` : ""}
          </div>
          ${s.genres.length + s.tags.length > 0 ? '<p class="insp-hint">タグを押すと検索条件に加わります</p>' : ""}
        </section>

        ${relatedHTML}
        ${techHTML}
      </div>`;
  }

  // ---------------------------------------------------------------- render: Area C Tag Editor Modal
  function summarizeEditTags(states) {
    const map = new Map();
    for (const st of states) {
      const seen = new Set();
      for (const eff of st.effective) {
        if (eff.kind === "year" || seen.has(eff.key)) continue;
        seen.add(eff.key);
        const cur = map.get(eff.key);
        if (cur) {
          cur.count += 1;
          if (cur.origin !== eff.origin) cur.origin = "both";
        } else {
          map.set(eff.key, { ...eff, count: 1 });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function buildDraftPatch(m) {
    let yearChange;
    const isBulk = m.displayed.length > 1;
    const initMode = isBulk ? "unchanged" : (m.displayed[0].manual.year.mode || "auto");
    const initVal = !isBulk && initMode === "set" ? m.displayed[0].manual.year.value : undefined;
    const parsedYear = m.mode === "set" ? Number(m.yearValue) : undefined;
    if (isBulk) {
      if (m.mode !== "unchanged") yearChange = m.mode === "set" ? { mode: "set", value: parsedYear } : { mode: m.mode };
    } else if (m.mode !== initMode || (m.mode === "set" && parsedYear !== initVal)) {
      yearChange = m.mode === "set" ? { mode: "set", value: parsedYear } : { mode: m.mode };
    }
    return {
      year_change: yearChange,
      add: m.add.map((t) => ({ ...t })),
      remove: m.remove.map((t) => ({ ...t })),
    };
  }

  function isModalDirty(m) {
    if (!m) return false;
    const p = buildDraftPatch(m);
    return !!(p.year_change || p.add.length || p.remove.length || m.addInput.trim());
  }

  function adderSuggestions(m) {
    const q = m.addInput.trim();
    if (!q) return [];
    const fq = fold(q);
    const out = [];
    for (const t of tagIndex.values()) {
      if (t.kind !== "genre" && t.kind !== "custom") continue;
      const f = fold(t.value);
      const at = f.indexOf(fq);
      if (at < 0) continue;
      out.push({ kind: t.kind, value: t.value, count: t.count, score: (at === 0 ? 2 : 0) + (f === fq ? 4 : 0) + (t.kind === m.addKind ? 1 : 0) });
    }
    out.sort((a, b) => b.score - a.score || b.count - a.count);
    return out.slice(0, 8);
  }

  function renderModal() {
    const host = $("#modalHost");
    const m = S.tagModal;
    host.hidden = !m;
    if (!m) {
      host.innerHTML = "";
      return;
    }

    const isBulk = m.targets.length > 1;
    const snap = tagService.listTrackTags();
    const changedElsewhere = snap.revision !== m.expectedRevision;
    const readOnly = !["ready", "missing"].includes(snap.store_status);
    const busy = m.saving || m.reloading;
    const uniqueCount = new Set(m.targets.map((t) => t.expected_hash)).size;

    const yearSummaryValues = new Set(m.displayed.map((st) => st.effective.find((e) => e.kind === "year")?.value ?? null));
    const currentYearText = yearSummaryValues.size === 1
      ? ([...yearSummaryValues][0] ? `${[...yearSummaryValues][0]}年` : "未設定")
      : "混在";

    let afterYearText = currentYearText;
    if (m.mode === "auto") {
      afterYearText = !isBulk ? (m.displayed[0].auto_year ? `${m.displayed[0].auto_year}年（自動）` : "未設定（自動）") : "自動に戻す";
    } else if (m.mode === "set") {
      const n = Number(m.yearValue);
      afterYearText = Number.isInteger(n) && n >= 1000 && n <= 9999 ? `${n}年（手動指定）` : "入力待ち（4桁）";
    } else if (m.mode === "unset") {
      afterYearText = "未設定に固定";
    }

    const validYear = m.mode !== "set" || (Number.isInteger(Number(m.yearValue)) && /^\d{4}$/.test(String(m.yearValue).trim()) && Number(m.yearValue) >= 1000 && Number(m.yearValue) <= 9999);
    const yearOpts = isBulk
      ? [["unchanged", "変更しない"], ["auto", "自動に戻す"], ["set", "年を指定"], ["unset", "未設定に固定"]]
      : [["auto", `自動 (${m.displayed[0].auto_year ? m.displayed[0].auto_year + "年" : "なし"})`], ["set", "年を指定"], ["unset", "未設定にする"]];

    const singleTrack = !isBulk ? m.displayed[0] : null;
    const hasYearIssue = singleTrack && ["conflict", "future", "invalid"].includes(singleTrack.year_status);
    const candidatesBlock = singleTrack && singleTrack.candidates.length ? (() => {
      const items = singleTrack.candidates.map((c) => {
        const py = parseCandidateYear(c.raw_value);
        const adoptable = py !== null && py <= 2026;
        const reason = c.semantic === "original" ? "原盤情報・自動不採用" : py === null ? "不正な年形式" : py > 2026 ? "未来年のため自動不採用" : SEMANTIC_LABEL[c.semantic];
        return `<div class="cand-row">
          <span><strong>${esc(c.raw_key)}</strong>: ${esc(c.raw_value)} <span class="cand-meta">（${reason}）</span></span>
          ${adoptable ? `<button class="btn sm" type="button" data-act="tm-adopt-year" data-y="${py}" ${busy || readOnly ? "disabled" : ""}>${py}年を使う</button>` : '<span class="cand-meta">選択不可</span>'}
        </div>`;
      }).join("");
      if (hasYearIssue) {
        return `<div class="cand-box"><p class="cand-box-title">⚠ 埋め込みメタデータの制作年が「${YEAR_STATUS_LABEL[singleTrack.year_status]}」です。候補から選べます：</p>${items}</div>`;
      }
      return `<details class="tech-details" style="border-top:0;padding-top:4px"><summary>埋め込みの年候補を見る (${singleTrack.candidates.length}件)</summary><div class="cand-box" style="margin-top:6px">${items}</div></details>`;
    })() : "";

    // Build unified tag ledger (existing + staged additions)
    const baseTags = summarizeEditTags(m.displayed);
    const mergedMap = new Map();
    for (const item of baseTags) {
      mergedMap.set(item.key, {
        key: item.key, kind: item.kind, value: item.value,
        origin: item.origin, count: item.count,
        adding: m.add.some((a) => tagKey(a) === item.key),
        removing: m.remove.some((r) => tagKey(r) === item.key),
      });
    }
    for (const a of m.add) {
      const k = tagKey(a);
      if (!mergedMap.has(k)) {
        mergedMap.set(k, {
          key: k, kind: a.kind, value: a.value, origin: "manual",
          count: 0, adding: true, removing: false,
        });
      }
    }
    const allItems = [...mergedMap.values()].sort((a, b) => Number(b.adding) - Number(a.adding) || a.key.localeCompare(b.key));
    const useLedgerMode = isBulk || allItems.length > 10;
    const lf = m.ledgerSearch.trim().toLowerCase();
    const visibleItems = allItems.filter((it) => {
      if (m.ledgerTab === "genre" && it.kind !== "genre") return false;
      if (m.ledgerTab === "custom" && it.kind !== "custom") return false;
      if (m.ledgerTab === "changed" && !it.adding && !it.removing) return false;
      if (lf && !it.value.toLowerCase().includes(lf)) return false;
      return true;
    });

    const ac = adderSuggestions(m);
    const qInput = m.addInput.trim();
    const crossKindHint = qInput && qInput === "2015" && m.addKind === "custom"
      ? '<p class="tm-year-preview">※ 制作年ではなく「任意タグ: 2015」として追加します。</p>'
      : "";

    let tagsSectionHTML = "";
    if (!useLedgerMode) {
      const genres = allItems.filter((x) => x.kind === "genre");
      const customs = allItems.filter((x) => x.kind === "custom");
      const renderChip = (it) => `<button type="button" class="tm-chip${it.removing ? " is-removing" : ""}${it.adding ? " is-adding" : ""}" data-act="${it.adding && it.count === 0 ? "tm-unadd" : "tm-toggle-rem"}" data-kind="${it.kind}" data-v="${esc(it.value)}" ${busy || readOnly ? "disabled" : ""} aria-pressed="${it.removing}">
        <span class="k-mark" data-kind="${it.kind}" aria-hidden="true"></span>
        <span>${esc(it.value)}</span>
        <span class="cand-meta">${it.adding ? "＋追加予定" : it.removing ? "↩ 戻す" : it.origin === "embedded" ? "自動 ×" : "×"}</span>
      </button>`;
      tagsSectionHTML = `
        <div class="insp-tag-group">
          <div class="insp-tag-label">ジャンル (${genres.length})</div>
          <div class="tm-simple-chips">${genres.map(renderChip).join("") || '<span class="insp-hint">なし</span>'}</div>
        </div>
        <div class="insp-tag-group">
          <div class="insp-tag-label">任意タグ (${customs.length})</div>
          <div class="tm-simple-chips">${customs.map(renderChip).join("") || '<span class="insp-hint">なし</span>'}</div>
        </div>`;
    } else {
      const changedLen = allItems.filter((x) => x.adding || x.removing).length;
      const genreLen = allItems.filter((x) => x.kind === "genre").length;
      const customLen = allItems.filter((x) => x.kind === "custom").length;
      tagsSectionHTML = `
        <div class="tm-filter-bar">
          <input class="tm-filter-input" id="tmFilterInput" type="search" value="${esc(m.ledgerSearch)}" placeholder="この編集内のタグを絞り込む (${allItems.length}件)…" aria-label="編集内のタグを絞り込む">
          <div class="seg" role="tablist" aria-label="表示するタグの種類">
            <button type="button" role="tab" data-act="tm-tab" data-tab="all" aria-checked="${m.ledgerTab === "all"}">すべて (${allItems.length})</button>
            <button type="button" role="tab" data-act="tm-tab" data-tab="genre" aria-checked="${m.ledgerTab === "genre"}">ジャンル (${genreLen})</button>
            <button type="button" role="tab" data-act="tm-tab" data-tab="custom" aria-checked="${m.ledgerTab === "custom"}">任意 (${customLen})</button>
            <button type="button" role="tab" data-act="tm-tab" data-tab="changed" aria-checked="${m.ledgerTab === "changed"}">変更 (${changedLen})</button>
          </div>
        </div>
        <div class="tm-ledger">
          ${visibleItems.map((it) => {
            const mixed = isBulk && it.count > 0 && it.count < m.displayed.length;
            const presenceText = isBulk
              ? (it.count === 0 ? "新規追加" : it.count === m.displayed.length ? `全${m.displayed.length}曲共通` : `${it.count}/${m.displayed.length}曲（混在）`)
              : (ORIGIN_LABEL[it.origin] || it.origin);
            const stateBadge = it.adding
              ? '<span class="tm-tag-state add">＋追加予定</span>'
              : it.removing
              ? `<span class="tm-tag-state rem">${it.origin === "embedded" || it.origin === "both" ? "－除外予定（再スキャンも抑止）" : "－削除予定"}</span>`
              : "";
            let acts = "";
            if (it.adding && it.count === 0) {
              acts = `<button class="btn sm" type="button" data-act="tm-unadd" data-kind="${it.kind}" data-v="${esc(it.value)}" ${busy || readOnly ? "disabled" : ""}>取消</button>`;
            } else if (mixed) {
              acts = `
                <button class="btn sm" type="button" data-act="tm-add-existing" data-kind="${it.kind}" data-v="${esc(it.value)}" ${busy || readOnly || it.adding ? "disabled" : ""}>全曲に追加</button>
                <button class="btn sm" type="button" data-act="tm-toggle-rem" data-kind="${it.kind}" data-v="${esc(it.value)}" ${busy || readOnly ? "disabled" : ""}>${it.removing ? "戻す" : "全曲から外す"}</button>`;
            } else {
              acts = `<button class="btn sm" type="button" data-act="tm-toggle-rem" data-kind="${it.kind}" data-v="${esc(it.value)}" ${busy || readOnly ? "disabled" : ""}>${it.removing ? "元に戻す" : (it.origin === "embedded" || it.origin === "both" ? "除外" : "削除")}</button>`;
            }
            return `<div class="tm-tag-row${it.removing ? " is-removing" : ""}${it.adding ? " is-adding" : ""}">
              <div class="tm-tag-info">
                <span class="k-mark" data-kind="${it.kind}" aria-hidden="true"></span>
                <span class="tm-tag-val">${esc(it.value)}</span>
                <span class="tm-tag-meta">${KIND_NAME[it.kind]} · ${presenceText}</span>
                ${stateBadge}
              </div>
              <div class="tm-tag-acts">${acts}</div>
            </div>`;
          }).join("") || '<div style="padding:12px" class="insp-hint">該当するタグがありません</div>'}
        </div>`;
    }

    const suppressedList = !isBulk ? m.displayed[0].manual.suppressed_auto_tags.filter((sTag) => !m.add.some((a) => sameTag(a, sTag))) : [];
    const suppressedHTML = suppressedList.length ? `<div class="tm-suppressed">
      <div class="tm-suppressed-title">除外済みの自動タグ (${suppressedList.length}件) — 再スキャンでも非表示のままです</div>
      <div class="tm-simple-chips">${suppressedList.map((st) => `<button class="btn sm" type="button" data-act="tm-restore-sup" data-kind="${st.kind}" data-v="${esc(st.value)}" ${busy || readOnly ? "disabled" : ""}>＋ ${KIND_NAME[st.kind]}: ${esc(st.value)} を戻す</button>`).join("")}</div>
    </div>` : "";

    const patch = buildDraftPatch(m);
    const diffParts = [];
    if (patch.year_change) diffParts.push(patch.year_change.mode === "set" ? `年→${patch.year_change.value || "?"}年` : patch.year_change.mode === "auto" ? "年→自動" : "年→未設定");
    if (patch.add.length) diffParts.push(`＋${patch.add.length}件追加`);
    if (patch.remove.length) diffParts.push(`－${patch.remove.length}件除外/削除`);
    const diffText = diffParts.length ? `変更予定：${diffParts.join("・")}` : "変更はありません";

    let previewHTML = "";
    if (m.showPreview && !isBulk) {
      const s = m.displayed[0];
      const remKeys = new Set(patch.remove.map(tagKey));
      const effAfter = s.effective.filter((e) => e.kind !== "year" && !remKeys.has(e.key)).map((e) => `${KIND_NAME[e.kind]}: ${e.value}`);
      for (const a of patch.add) {
        if (!effAfter.some((x) => x.toLowerCase() === `${KIND_NAME[a.kind]}: ${a.value}`.toLowerCase())) effAfter.push(`${KIND_NAME[a.kind]}: ${a.value} (新)`);
      }
      previewHTML = `<div class="tm-preview-box"><strong>保存後の有効な状態：</strong><span>制作年: ${esc(afterYearText)} / タグ ${effAfter.length}件（${effAfter.slice(0, 8).map(esc).join("、")}${effAfter.length > 8 ? ` ほか${effAfter.length - 8}件` : ""}）</span></div>`;
    }

    let errBanner = "";
    if (m.error) {
      const code = m.error.code;
      if (code === "stale_revision") {
        errBanner = `<div class="tm-banner bad" role="alert"><span>他の更新（再スキャン等）が入ったため、古い状態への誤保存を防ぎました。入力中の下書きは保持しています。</span><button class="btn sm" type="button" data-act="tm-reload" ${busy ? "disabled" : ""}>${m.reloading ? "読込中…" : "最新を再読込"}</button></div>`;
      } else if (code === "identity_changed" || code === "identity_unavailable") {
        errBanner = `<div class="tm-banner bad" role="alert"><span>対象ファイルが置き換わったか見つからないため、別の曲への誤適用を防ぐため保存を停止しました。下書きは参照用に残しています。</span></div>`;
      } else {
        errBanner = `<div class="tm-banner bad" role="alert"><span>保存できませんでした（${esc(m.error.message || code)}）。下書きは保持しています。</span></div>`;
      }
    }

    const headerBanners = [];
    if (readOnly) {
      headerBanners.push(`<div class="tm-banner bad" role="alert"><span>タグ保存領域が読み取り専用（${esc(snap.store_status)}）のため変更を保存できません。閲覧のみ可能です。</span></div>`);
    }
    if (uniqueCount < m.targets.length) {
      headerBanners.push(`<div class="tm-banner info"><span>表示中の ${m.targets.length} 行のうち同一音源のコピーをまとめ、実データ <strong>${uniqueCount}曲分</strong> として保存します。</span></div>`);
    }
    if (isBulk && m.scopeMeta.hiddenSelected > 0) {
      headerBanners.push(`<div class="tm-banner info"><span>選択中 ${m.scopeMeta.selectedTotal}曲のうち、現在表示中の <strong>${m.targets.length}曲</strong> だけを対象にしています（フィルタ外の ${m.scopeMeta.hiddenSelected}曲は変更しません）。</span></div>`);
    }
    if (changedElsewhere && (!m.error || m.error.code !== "stale_revision")) {
      headerBanners.push(`<div class="tm-banner warn"><span>背景でタグ状態が更新されました。下書きを保ったまま最新を確認できます。</span><button class="btn sm" type="button" data-act="tm-reload" ${busy ? "disabled" : ""}>${m.reloading ? "読込中…" : "最新を再読込"}</button></div>`);
    }
    if (m.reloaded) {
      headerBanners.push(`<div class="tm-banner ok" role="status"><span>最新の状態を読み込みました。入力内容を確認してそのまま保存できます。</span></div>`);
    }

    const identityBlocked = m.error && (m.error.code === "identity_changed" || m.error.code === "identity_unavailable");
    const hasMetaIssue = m.displayed.some((st) => st.metadata_status !== "ready" || st.diagnostics.length > 0);

    host.innerHTML = `<div class="tag-modal${m.dirtyShake ? " is-shake" : ""}" role="dialog" aria-modal="true" aria-labelledby="tagModalTitle">
      <div class="tm-head">
        <div class="tm-title-row">
          <div>
            <h2 id="tagModalTitle">${isBulk ? `${m.targets.length}曲のタグをまとめて編集` : `タグを編集`}</h2>
            <p class="tm-sub">${esc(m.title)}</p>
          </div>
          <button class="icon-btn" type="button" data-act="tm-close" ${busy ? "disabled" : ""} aria-label="タグ編集を閉じる">${ICON.x}</button>
        </div>
        <p class="tm-trust">プレイヤー内のみに保存され、音声ファイル自体は書き換えません。</p>
        ${isBulk ? `<div><button class="fact-action" type="button" data-act="tm-toggle-targets">${m.showTargets ? "対象曲の一覧を閉じる" : `固定された対象曲を見る (${m.targets.length}曲)`}</button>${m.showTargets ? `<div class="tm-targets-list">${m.targets.map((t) => `<div class="mono">${esc(t.path)}</div>`).join("")}</div>` : ""}</div>` : ""}
        ${headerBanners.join("")}
      </div>

      <div class="tm-body">
        <section class="tm-sec" aria-label="制作年">
          <div class="tm-sec-head">
            <h3>制作年</h3>
            <span class="tm-year-preview">現在: <strong>${esc(currentYearText)}</strong> → 保存後: <strong>${esc(afterYearText)}</strong></span>
          </div>
          <div class="tm-year-row">
            <div class="seg" role="radiogroup" aria-label="制作年の指定方法">
              ${yearOpts.map(([val, lbl]) => `<button type="button" role="radio" data-act="tm-year-mode" data-v="${val}" aria-checked="${m.mode === val}" ${busy || readOnly ? "disabled" : ""}>${lbl}</button>`).join("")}
            </div>
            ${m.mode === "set" ? `<label class="vh" for="tmYearInput">指定する西暦</label><input class="year-num" id="tmYearInput" type="number" inputmode="numeric" min="1000" max="9999" value="${esc(m.yearValue)}" placeholder="2015" ${busy || readOnly ? "disabled" : ""}>` : ""}
          </div>
          ${!validYear ? '<p class="tm-err-inline">1000〜9999の4桁の西暦を入力してください。</p>' : ""}
          ${candidatesBlock}
        </section>

        <section class="tm-sec" aria-label="タグの追加と編集">
          <div class="tm-sec-head">
            <h3>タグを追加・編集</h3>
            <span class="tm-year-preview">1曲あたり合計${MAX_EFFECTIVE_TAGS}件・各${MAX_TAG_SCALARS}文字まで</span>
          </div>
          <div class="adder-wrap">
            <div class="adder-bar">
              <div class="seg" role="radiogroup" aria-label="追加するタグの種類">
                <button type="button" role="radio" data-act="tm-add-kind" data-v="custom" aria-checked="${m.addKind === "custom"}" ${busy || readOnly ? "disabled" : ""}>任意タグ</button>
                <button type="button" role="radio" data-act="tm-add-kind" data-v="genre" aria-checked="${m.addKind === "genre"}" ${busy || readOnly ? "disabled" : ""}>ジャンル</button>
              </div>
              <input class="adder-input" id="tmAddInput" type="text" value="${esc(m.addInput)}" placeholder="タグ名を入力または候補から選ぶ…" aria-label="追加するタグ名" ${busy || readOnly ? "disabled" : ""}>
              <button class="btn sm primary" type="button" data-act="tm-add-btn" ${busy || readOnly || !qInput ? "disabled" : ""}>追加</button>
            </div>
            ${crossKindHint}
            ${m.addError ? `<p class="tm-err-inline">${esc(m.addError)}</p>` : ""}
            ${ac.length ? `<ul class="adder-ac" role="listbox" aria-label="既存タグの候補">${ac.map((opt, idx) => `<li><button class="adder-opt" type="button" role="option" aria-selected="${idx === m.acIndex}" data-act="tm-pick-ac" data-kind="${opt.kind}" data-v="${esc(opt.value)}"><span class="adder-opt-main"><span class="k-mark" data-kind="${opt.kind}"></span><span class="adder-opt-val">${esc(opt.value)}</span><span class="kind-pill" data-kind="${opt.kind}">${KIND_NAME[opt.kind]}</span></span><span class="cand-meta">${fmtN(opt.count)}曲</span></button></li>`).join("")}</ul>` : ""}
          </div>
          ${tagsSectionHTML}
          ${suppressedHTML}
        </section>

        <details class="tech-details">
          <summary>メタデータ・由来・診断 ${hasMetaIssue ? '<span class="insp-badge warn">注意あり</span>' : ""}</summary>
          <div class="tech-body">
            <dl class="tech-dl">
              <dt>保存リビジョン</dt><dd class="mono">${esc(m.expectedRevision)}</dd>
              <dt>保存先状態</dt><dd>${esc(snap.store_status)}</dd>
              ${m.displayed.map((st, idx) => `<dt>${isBulk ? `曲${idx + 1}` : "状態"}</dt><dd>${META_STATUS_LABEL[st.metadata_status]} / 年判定: ${YEAR_STATUS_LABEL[st.year_status]} / hash: <span class="mono">${esc(st.content_hash)}</span>${st.diagnostics.length ? `<br><span style="color:var(--danger)">${st.diagnostics.map(esc).join(" / ")}</span>` : ""}</dd>`).join("")}
            </dl>
          </div>
        </details>
      </div>

      <div class="tm-foot">
        ${errBanner}
        ${previewHTML}
        <div class="tm-foot-row">
          <div class="tm-diff-summary">
            <span>${esc(diffText)}</span>
            ${!isBulk && diffParts.length ? `<button class="fact-action" type="button" data-act="tm-toggle-preview">${m.showPreview ? "確認を閉じる" : "保存後のタグを確認"}</button>` : ""}
          </div>
          <div class="tm-foot-acts">
            <button class="btn" type="button" data-act="tm-close" ${busy ? "disabled" : ""}>キャンセル</button>
            <button class="btn primary" type="button" data-act="tm-save" ${busy || readOnly || !validYear || identityBlocked ? "disabled" : ""}>${m.saving ? "保存中…" : "保存"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- modal lifecycle & actions
  function openTagEditor(songIds, scopeMeta = null, opener = document.activeElement) {
    const snap = tagService.listTrackTags();
    const rows = songIds.map((id) => byId.get(id)).filter((s) => s && s.content_hash);
    if (!rows.length) {
      toast("識別（content hash）が未確定のためタグを編集できません");
      return;
    }
    const targets = rows.map((s) => ({
      path: s.path,
      expected_hash: s.content_hash,
      expected_fingerprint: s.fingerprint,
      songId: s.id,
    }));
    const initialStates = targets.map((t) => JSON.parse(JSON.stringify(snap.tracks[t.path])));
    const isBulk = targets.length > 1;
    const initYearMode = isBulk ? "unchanged" : (initialStates[0].manual.year.mode || "auto");
    const initYearVal = !isBulk && initYearMode === "set" ? String(initialStates[0].manual.year.value) : "";

    S.tagModal = {
      targets,
      expectedRevision: snap.revision,
      displayed: initialStates,
      opener: opener instanceof HTMLElement ? opener : null,
      title: isBulk ? `表示中の選択 ${targets.length}曲（対象は開いた時点で固定）` : `${rows[0].title}${rows[0].artist ? " — " + rows[0].artist : ""}`,
      scopeMeta: scopeMeta || { selectedTotal: targets.length, hiddenSelected: 0 },
      mode: initYearMode,
      yearValue: initYearVal,
      addKind: "custom",
      addInput: "",
      addError: null,
      acIndex: 0,
      add: [],
      remove: [],
      ledgerSearch: "",
      ledgerTab: "all",
      showTargets: false,
      showPreview: false,
      saving: false,
      reloading: false,
      reloaded: false,
      error: null,
      dirtyShake: false,
    };
    renderModal();
    setTimeout(() => {
      const target = $("#tmAddInput") || $(".tag-modal button:not(:disabled)");
      target?.focus();
    });
  }

  function closeTagEditor(force = false) {
    const m = S.tagModal;
    if (!m) return;
    if (!force && (m.saving || m.reloading)) return;
    const opener = m.opener;
    S.tagModal = null;
    renderModal();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  }

  function queueAddTag(kind, rawValue) {
    const m = S.tagModal;
    if (!m) return false;
    const res = normalizeTag(kind, rawValue);
    if (res.error) {
      m.addError = res.error === "too_long"
        ? `${MAX_TAG_SCALARS}文字以内で入力してください`
        : res.error === "control"
        ? "改行や制御文字は使えません"
        : "タグ名を入力してください";
      return false;
    }
    m.addError = null;
    const tag = res.tag;
    m.remove = m.remove.filter((r) => !sameTag(r, tag));
    if (!m.add.some((a) => sameTag(a, tag))) m.add.push(tag);
    m.addInput = "";
    m.acIndex = 0;
    return true;
  }

  function saveTagModal() {
    const m = S.tagModal;
    if (!m || m.saving || m.reloading) return;
    m.error = null;
    m.reloaded = false;
    if (m.addInput.trim()) {
      if (!queueAddTag(m.addKind, m.addInput)) { renderModal(); return; }
    }
    const patch = buildDraftPatch(m);
    if (patch.year_change && patch.year_change.mode === "set") {
      const y = patch.year_change.value;
      if (!Number.isInteger(y) || y < 1000 || y > 9999) {
        m.error = { code: "invalid_input", message: "制作年は1000〜9999の整数を指定してください" };
        renderModal();
        return;
      }
    }
    m.saving = true;
    renderModal();
    try {
      const res = tagService.updateTrackTags({
        targets: m.targets.map((t) => ({ path: t.path, expected_hash: t.expected_hash, expected_fingerprint: t.expected_fingerprint })),
        expected_revision: m.expectedRevision,
        patch,
      });
      m.saving = false;
      closeTagEditor(true);
      update();
      toast(res.changed
        ? (res.changed === 1 ? "タグを保存しました（音声ファイルは変更していません）" : `${res.changed}曲分のタグを保存しました（音声ファイルは変更していません）`)
        : "変更はありませんでした");
    } catch (err) {
      m.saving = false;
      m.error = { code: err?.code || "persist_failed", message: err?.message || "保存失敗" };
      renderModal();
    }
  }

  function reloadTagModal() {
    const m = S.tagModal;
    if (!m || m.saving || m.reloading) return;
    m.reloading = true;
    m.reloaded = false;
    renderModal();
    const snap = tagService.listTrackTags();
    m.reloading = false;
    if (!["ready", "missing"].includes(snap.store_status)) {
      m.error = { code: "store_read_only", message: snap.store_status };
      renderModal();
      return;
    }
    const allIntact = m.targets.every((t) => {
      const st = snap.tracks[t.path];
      const liveSong = byPath.get(t.path);
      return st && st.content_hash === t.expected_hash && liveSong && liveSong.fingerprint === t.expected_fingerprint;
    });
    if (!allIntact) {
      m.error = { code: "identity_changed", message: "identity_changed" };
      renderModal();
      return;
    }
    m.displayed = m.targets.map((t) => JSON.parse(JSON.stringify(snap.tracks[t.path])));
    m.expectedRevision = snap.revision;
    m.error = null;
    m.reloaded = true;
    renderModal();
  }

  // ---------------------------------------------------------------- render: dock + now (preserved)
  function renderDock() {
    const d = playlists.find((p) => p.id === S.dest);
    const list = L[S.dest];
    const dock = $("#dock");
    dock.style.setProperty("--dest", INK[d.ink]);
    const manual = list.filter((x) => !x.auto);
    const auto = list.filter((x) => x.auto);
    const tail = (arr, startPos) => arr.map((x, i) => {
      const s = byId.get(x.id);
      return `<li class="${x.fresh ? "is-new" : ""}${x.auto ? " auto" : ""}"><span class="pos">${startPos + i}</span><span><span class="t">${esc(s.title)}</span><span class="a">${esc(s.artist || "アーティスト情報なし")}</span></span></li>`;
    }).join("");
    let tailHTML;
    if (d.kind === "queue") {
      const shown = manual.slice(-8);
      tailHTML = tail(shown, manual.length - shown.length + 1) + (auto.length ? '<li class="boundary">ここから自動選曲（手動で選んだ曲の後に続きます）</li>' + tail(auto, manual.length + 1) : "");
    } else {
      const shown = list.slice(-10);
      tailHTML = tail(shown, list.length - shown.length + 1);
    }
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
    renderQuery();
    renderLens();
    renderResults();
    renderInspector();
    renderDock();
    renderModal();
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
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 6000);
  }

  function fly(from) {
    if (!from || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = innerWidth < 1100 ? $(".dest-chip") : $("#dockName");
    if (!to) return;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const f = $("#flyer");
    f.animate([
      { opacity: 1, transform: `translate(${a.left + a.width / 2 - 7}px, ${a.top + a.height / 2 - 7}px) scale(1)` },
      { opacity: 1, transform: `translate(${(a.left + b.left) / 2}px, ${Math.min(a.top, b.top) - 60}px) scale(1.3)`, offset: .45 },
      { opacity: 0, transform: `translate(${b.left + 10}px, ${b.top + b.height / 2 - 7}px) scale(.6)` },
    ], { duration: 520, easing: "cubic-bezier(.3,.7,.4,1)" });
  }

  // ---------------------------------------------------------------- events
  const narrow = () => innerWidth <= 959 || innerHeight <= 520;
  function focusInput() {
    const i = narrow() ? $("#lensInput") : $("#finderInput");
    if (i && document.activeElement !== i) {
      i.focus();
      const v = i.value;
      i.value = "";
      i.value = v;
    }
  }
  function commitInput() {
    const o = S.input.trim() && !S.focusClause && S.lensView === "add" ? sugg.out[S.sugIndex] : null;
    S.lens = false;
    S.focusClause = null;
    if (o) addValue(o.kind, o.value);
    else { S.input = ""; update(); }
  }

  document.addEventListener("click", (e) => {
    // Modal backdrop click
    if (e.target === $("#modalHost") && S.tagModal) {
      if (isModalDirty(S.tagModal)) {
        S.tagModal.dirtyShake = true;
        renderModal();
        toast("未保存の変更があります。「キャンセル」または Esc で破棄できます");
        setTimeout(() => { if (S.tagModal) { S.tagModal.dirtyShake = false; } }, 300);
      } else {
        closeTagEditor();
      }
      return;
    }

    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT") return;
    const id = Number(t.dataset.id);
    switch (t.dataset.act) {
      case "open-lens": S.lens = true; S.lensView = "add"; render(); focusInput(); break;
      case "manage-lens": S.lens = true; S.lensView = "manage"; S.focusClause = null; render(); break;
      case "to-manage": S.lensView = "manage"; S.focusClause = null; render(); break;
      case "to-add": S.lensView = "add"; render(); focusInput(); break;
      case "close-lens": commitInput(); break;
      case "clear-input": S.input = ""; S.sugIndex = 0; S.suggKind = "all"; S.suggLimit = 12; update(); focusInput(); break;
      case "edit-clause": S.lens = true; S.lensView = "manage"; S.focusClause = null; render(); flash(id); break;
      case "rm-clause": removeClause(id); break;
      case "rm-clauses": {
        pushQueryHistory();
        const ids = t.dataset.ids.split(",").map(Number);
        S.clauses = S.clauses.filter((c) => !ids.includes(c.id));
        update();
        toast(`条件を${ids.length}つ外しました`, "元に戻す", () => undoQuery());
        break;
      }
      case "pause-clause": {
        pushQueryHistory();
        const c = S.clauses.find((x) => x.id === id);
        if (c) c.on = false;
        update();
        toast(`「${clauseText(c)}」を一時停止しました`, "元に戻す", () => undoQuery());
        break;
      }
      case "resume-all": {
        pushQueryHistory();
        S.clauses.forEach((c) => (c.on = true));
        update();
        break;
      }
      case "rm-val": removeValue(id, t.dataset.v); break;
      case "alt": S.focusClause = S.focusClause === id ? null : id; S.lensView = "add"; S.input = ""; S.suggKind = "all"; S.suggLimit = 12; render(); focusInput(); break;
      case "cancel-alt": S.focusClause = null; S.lensView = "manage"; S.input = ""; update(); break;
      case "toggle": { pushQueryHistory(); const c = S.clauses.find((x) => x.id === id); if (c) c.on = !c.on; update(); break; }
      case "not": { pushQueryHistory(); const c = S.clauses.find((x) => x.id === id); if (c) c.not = !c.not; update(); break; }
      case "toggle-unset": { pushQueryHistory(); S.yearUnset = !S.yearUnset; update(); remember(); break; }
      case "merge-years": {
        pushQueryHistory();
        const ys = S.clauses.filter((c) => c.kind === "year" && !c.not);
        const vals = [...new Set(ys.flatMap((c) => c.values))];
        S.clauses = S.clauses.filter((c) => !(c.kind === "year" && !c.not));
        S.clauses.unshift({ id: uid++, kind: "year", values: vals, on: true, not: false });
        update();
        break;
      }
      case "sugg-kind": S.suggKind = t.dataset.k; S.sugIndex = 0; S.suggLimit = 12; update(); focusInput(); break;
      case "more-sugg": S.suggLimit += 30; update(); break;
      case "pick": if (S.lens) { addValue(t.dataset.kind, t.dataset.v); focusInput(); } break;
      case "pick-from-detail": addValue(t.dataset.kind, t.dataset.v); toast(`条件「${KIND_NAME[t.dataset.kind]}: ${t.dataset.v}」を加えました`, "元に戻す", () => undoQuery()); break;
      case "pick-group": addValue(t.dataset.kind, JSON.parse(t.dataset.vs)); focusInput(); break;
      case "year": S.focusClause = null; addValue("year", t.dataset.v); break;
      case "recent": { pushQueryHistory(); applySnapshot(S.recent[Number(t.dataset.i)].snap); update(); break; }
      case "mode": pushQueryHistory(); S.mode = S.mode === "all" ? "any" : "all"; update(); break;
      case "set-mode": pushQueryHistory(); S.mode = t.dataset.v; update(); break;
      case "undo-query": undoQuery(); break;
      case "redo-query": redoQuery(); break;
      case "clear-all": {
        pushQueryHistory();
        S.clauses = [];
        S.yearUnset = false;
        S.focusClause = null;
        if (S.lensView === "manage") S.lensView = "add";
        update();
        toast("条件をすべて外しました", "元に戻す", () => undoQuery());
        break;
      }
      case "retry": S.sim = "ok"; update(); toast("検索を更新しました"); break;

      case "open": {
        S.open = id;
        S.active = id;
        S.inspectorTagFilter = "";
        S.inspectorTagsExpanded = false;
        S.inspectorTechOpen = false;
        renderResults();
        renderInspector();
        break;
      }
      case "close-detail": {
        const prevOpen = S.open;
        S.open = null;
        renderResults();
        renderInspector();
        if (prevOpen !== null) setTimeout(() => $(`.row[data-id="${prevOpen}"] .row-main`)?.focus());
        break;
      }
      case "insp-expand-tags": S.inspectorTagsExpanded = true; renderInspector(); break;
      case "insp-collapse-tags": S.inspectorTagsExpanded = false; S.inspectorTagFilter = ""; renderInspector(); break;
      case "copy-path":
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t.dataset.path).catch(() => {});
        toast("ファイルパスをコピーしました");
        break;

      case "add": {
        if (t.getAttribute("aria-disabled") === "true") {
          const s = byId.get(id);
          toast(s.missing ? "ファイルが見つからないため追加できません" : "非Funkotのため追加できません（タグ編集は可能です）");
          break;
        }
        addTo(S.dest, [id], t);
        break;
      }
      case "fav": addTo("fav", [id], t); break;
      case "dest-list": S.destList = !S.destList; renderDock(); if (S.destList) setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "rb-menu": S.rbMenu = !S.rbMenu; renderResults(); if (S.rbMenu) setTimeout(() => $(".rb-more .menu button")?.focus()); break;
      case "sort-to": S.sort = t.dataset.v; S.rbMenu = false; update(); break;
      case "dest": S.dest = t.dataset.id; S.dockOpen = false; S.destList = false; S.lastAdded = null; render(); toast(`追加先を${playlists.find((p) => p.id === S.dest).name}に変えました`); break;
      case "open-dock": S.dockOpen = true; render(); setTimeout(() => $("#dock .dest[aria-checked=true]")?.focus()); break;
      case "close-dock": S.dockOpen = false; render(); break;

      case "sel-start": S.selectMode = true; S.rbMenu = false; S.selected.clear(); renderResults(); break;
      case "sel-end": S.selectMode = false; S.selected.clear(); renderResults(); break;
      case "sel": S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderResults(); break;
      case "sel-all": currentList().slice(0, S.limit).forEach((s) => S.selected.add(s.id)); renderResults(); break;
      case "add-sel": {
        const st = selectionStats();
        addTo(S.dest, st.queueEligible.map((s) => s.id), t);
        S.selected.clear();
        S.selectMode = false;
        renderResults();
        break;
      }
      case "edit-selected-tags": {
        const st = selectionStats();
        openTagEditor(st.editableVisible.map((s) => s.id), {
          selectedTotal: st.totalSelected,
          hiddenSelected: st.hiddenSelectedCount,
        }, t);
        break;
      }
      case "open-tag-editor": openTagEditor([id], null, t); break;

      // Area C modal actions
      case "tm-close": closeTagEditor(); break;
      case "tm-save": saveTagModal(); break;
      case "tm-reload": reloadTagModal(); break;
      case "tm-year-mode": if (S.tagModal) { S.tagModal.mode = t.dataset.v; renderModal(); if (t.dataset.v === "set") setTimeout(() => $("#tmYearInput")?.focus()); } break;
      case "tm-adopt-year": if (S.tagModal) { S.tagModal.mode = "set"; S.tagModal.yearValue = t.dataset.y; renderModal(); } break;
      case "tm-add-kind": if (S.tagModal) { S.tagModal.addKind = t.dataset.v; renderModal(); $("#tmAddInput")?.focus(); } break;
      case "tm-add-btn": if (S.tagModal) { queueAddTag(S.tagModal.addKind, S.tagModal.addInput); renderModal(); $("#tmAddInput")?.focus(); } break;
      case "tm-pick-ac": if (S.tagModal) { queueAddTag(t.dataset.kind, t.dataset.v); renderModal(); $("#tmAddInput")?.focus(); } break;
      case "tm-unadd": if (S.tagModal) { const tg = { kind: t.dataset.kind, value: t.dataset.v }; S.tagModal.add = S.tagModal.add.filter((a) => !sameTag(a, tg)); renderModal(); } break;
      case "tm-add-existing": if (S.tagModal) { queueAddTag(t.dataset.kind, t.dataset.v); renderModal(); } break;
      case "tm-restore-sup": if (S.tagModal) { queueAddTag(t.dataset.kind, t.dataset.v); renderModal(); } break;
      case "tm-toggle-rem": if (S.tagModal) {
        const tg = { kind: t.dataset.kind, value: t.dataset.v };
        if (S.tagModal.remove.some((r) => sameTag(r, tg))) S.tagModal.remove = S.tagModal.remove.filter((r) => !sameTag(r, tg));
        else { S.tagModal.add = S.tagModal.add.filter((a) => !sameTag(a, tg)); S.tagModal.remove.push(tg); }
        renderModal();
      } break;
      case "tm-tab": if (S.tagModal) { S.tagModal.ledgerTab = t.dataset.tab; renderModal(); } break;
      case "tm-toggle-targets": if (S.tagModal) { S.tagModal.showTargets = !S.tagModal.showTargets; renderModal(); } break;
      case "tm-toggle-preview": if (S.tagModal) { S.tagModal.showPreview = !S.tagModal.showPreview; renderModal(); } break;
    }
  });

  // Desktop click into results closes floating lens cleanly
  let clickInResults = false;
  document.addEventListener("click", (e) => { clickInResults = !!e.target.closest("#results"); }, true);
  document.addEventListener("click", () => {
    if (!S.lens || narrow() || !clickInResults) return;
    commitInput();
  });

  const moreBtn = $("#moreBtn");
  const moreMenu = $("#moreMenu");
  moreBtn.addEventListener("click", () => {
    moreMenu.hidden = !moreMenu.hidden;
    moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden));
    if (!moreMenu.hidden) moreMenu.querySelector("button").focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#moreBtn") && !e.target.closest("#moreMenu")) {
      moreMenu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
    }
    if (S.rbMenu && !e.target.closest(".rb-more")) {
      S.rbMenu = false;
      renderResults();
    }
  });
  $("#scrim").addEventListener("click", () => { S.dockOpen = false; render(); });
  document.addEventListener("change", (e) => {
    if (e.target.id === "sortSel") { S.sort = e.target.value; update(); }
  });
  document.addEventListener("toggle", (e) => {
    if (e.target.id === "inspTechDetails") S.inspectorTechOpen = e.target.open;
  }, true);

  function flash(id) {
    setTimeout(() => {
      const el = document.querySelector(`.ledger-row[data-id="${id}"]`);
      if (el) { el.classList.add("is-focus"); setTimeout(() => el.classList.remove("is-focus"), 1200); }
    });
  }

  function onSearchInput(e) {
    S.input = e.target.value;
    S.sugIndex = 0;
    S.suggKind = "all";
    S.suggLimit = 12;
    S.lens = true;
    S.lensView = "add";
    compute();
    renderQuery();
    renderLens();
    renderResults();
    if (e.target.id === "lensInput") focusInput();
  }

  $("#finderInput").addEventListener("input", onSearchInput);
  let quietFocus = false;
  $("#finderInput").addEventListener("focus", () => {
    if (!quietFocus && !narrow() && !S.lens) { S.lens = true; S.lensView = "add"; render(); focusInput(); }
  });
  $("#finderInput").addEventListener("click", () => {
    if (narrow()) { S.lens = true; S.lensView = "add"; render(); focusInput(); }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "lensInput") { onSearchInput(e); return; }
    if (e.target.id === "inspTagFilter") {
      S.inspectorTagFilter = e.target.value;
      const pos = e.target.selectionStart;
      renderInspector();
      const el = $("#inspTagFilter");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      return;
    }
    if (!S.tagModal) return;
    if (e.target.id === "tmYearInput") {
      S.tagModal.yearValue = e.target.value;
      const pos = e.target.selectionStart;
      renderModal();
      const el = $("#tmYearInput");
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
    } else if (e.target.id === "tmAddInput") {
      S.tagModal.addInput = e.target.value;
      S.tagModal.addError = null;
      S.tagModal.acIndex = 0;
      const pos = e.target.selectionStart;
      renderModal();
      const el = $("#tmAddInput");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    } else if (e.target.id === "tmFilterInput") {
      S.tagModal.ledgerSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderModal();
      const el = $("#tmFilterInput");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  });

  document.addEventListener("keydown", (e) => {
    // Modal focus trap + Escape + autocomplete keyboard nav
    if (S.tagModal) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTagEditor();
        return;
      }
      if (e.key === "Tab") {
        const modal = $(".tag-modal");
        if (modal) {
          const ctrls = [...modal.querySelectorAll("button:enabled, input:enabled, select:enabled, summary")]
            .filter((el) => el.getClientRects().length > 0);
          const first = ctrls[0];
          const last = ctrls[ctrls.length - 1];
          if (e.shiftKey && document.activeElement === first && last) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last && first) { e.preventDefault(); first.focus(); }
        }
        return;
      }
      if (e.target.id === "tmAddInput") {
        const opts = [...document.querySelectorAll(".adder-opt")];
        if (e.key === "ArrowDown" && opts.length) {
          e.preventDefault();
          S.tagModal.acIndex = Math.min(opts.length - 1, S.tagModal.acIndex + 1);
          renderModal();
          $("#tmAddInput")?.focus();
        } else if (e.key === "ArrowUp" && opts.length) {
          e.preventDefault();
          S.tagModal.acIndex = Math.max(0, S.tagModal.acIndex - 1);
          renderModal();
          $("#tmAddInput")?.focus();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (opts[S.tagModal.acIndex] && S.tagModal.addInput.trim()) {
            const pick = opts[S.tagModal.acIndex];
            queueAddTag(pick.dataset.kind, pick.dataset.v);
          } else if (S.tagModal.addInput.trim()) {
            queueAddTag(S.tagModal.addKind, S.tagModal.addInput);
          }
          renderModal();
          $("#tmAddInput")?.focus();
        }
      }
      return;
    }

    const inField = e.target.matches("input, select, textarea");
    if (e.key === "/" && !inField) { e.preventDefault(); S.lens = true; S.lensView = "add"; render(); focusInput(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inField) {
      e.preventDefault();
      if (e.shiftKey) redoQuery(); else undoQuery();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !inField) {
      e.preventDefault();
      redoQuery();
      return;
    }

    if (e.target.id === "finderInput" || e.target.id === "lensInput") {
      const opts = [...document.querySelectorAll(".sugg")];
      if (e.key === "ArrowDown" && opts.length) {
        e.preventDefault();
        S.sugIndex = Math.min(opts.length - 1, S.sugIndex + 1);
        markSugg(opts);
      } else if (e.key === "ArrowUp" && opts.length) {
        e.preventDefault();
        S.sugIndex = Math.max(0, S.sugIndex - 1);
        markSugg(opts);
      } else if (e.key === "Enter" && opts.length) {
        e.preventDefault();
        const o = opts[S.sugIndex];
        addValue(o.dataset.kind, o.dataset.v);
        focusInput();
      } else if (e.key === "Backspace" && !e.target.value && S.clauses.length) {
        removeClause(S.clauses[S.clauses.length - 1].id);
        focusInput();
      } else if (e.key === "Escape") {
        S.lens = false;
        S.focusClause = null;
        S.input = "";
        update();
        quietFocus = true;
        $("#finderInput").focus();
        quietFocus = false;
      }
      return;
    }

    if (e.key === "Escape") {
      if (!moreMenu.hidden) { moreMenu.hidden = true; moreBtn.focus(); }
      else if (S.rbMenu) { S.rbMenu = false; renderResults(); $('[data-act="rb-menu"]')?.focus(); }
      else if (S.dockOpen) { S.dockOpen = false; render(); $(".dest-chip")?.focus(); }
      else if (S.destList) { S.destList = false; renderDock(); $(".dock-change")?.focus(); }
      else if (S.lens) { commitInput(); quietFocus = true; $("#finderInput").focus(); quietFocus = false; }
      else if (S.open !== null) {
        const prev = S.open;
        S.open = null;
        renderResults();
        renderInspector();
        setTimeout(() => $(`.row[data-id="${prev}"] .row-main`)?.focus());
      }
      return;
    }

    const row = e.target.closest && e.target.closest(".row");
    if (row && !inField) {
      const id = Number(row.dataset.id);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const sib = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        sib?.querySelector(".row-main")?.focus();
        if (sib) S.active = Number(sib.dataset.id);
      } else if (e.key === "a" || e.key === "+") {
        e.preventDefault();
        addTo(S.dest, [id], row.querySelector(".add"));
        setTimeout(() => $(`.row[data-id="${id}"] .row-main`)?.focus());
      } else if (e.key === " " && S.selectMode) {
        e.preventDefault();
        S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
        renderResults();
        $(`.row[data-id="${id}"] .row-main`)?.focus();
      }
    }
  });

  function markSugg(opts) {
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === S.sugIndex)));
    opts[S.sugIndex].scrollIntoView({ block: "nearest" });
    const inp = narrow() ? $("#lensInput") : $("#finderInput");
    inp?.setAttribute("aria-activedescendant", opts[S.sugIndex].id);
    result = filter(activeClauses()).slice().sort(SORTS[S.sort][1]);
    renderQuery();
    renderResults();
  }

  new IntersectionObserver((en) => {
    if (en[0].isIntersecting && result.length > S.limit && S.sim !== "loading") {
      S.limit += 60;
      renderResults();
    }
  }, { root: $("#results") }).observe($("#sentinel"));

  $("#themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  });

  // ---------------------------------------------------------------- scenarios
  const C = (kind, values, extra = {}) => Object.assign({ id: uid++, kind, values: [].concat(values), on: true, not: false }, extra);
  const findSpecial = (substr) => songs.find((s) => s.title.includes(substr) || s.path.includes(substr));

  const SCN = {
    base() {},
    "search-basic"() { S.lens = true; S.lensView = "add"; },
    "search-disambig"() { S.lens = true; S.lensView = "add"; S.input = "2015"; },
    a() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix")]; },
    "a-edit"() { SCN.a(); S.clauses.pop(); S.lens = true; S.lensView = "add"; S.input = "アニソン"; },
    eight() {
      S.clauses = [
        C("year", ["2015", "2016"]),
        C("custom", "日本人トラックメーカー"),
        C("genre", ["アニソンremix", "アニソンRemix", "anison remix"]),
        C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", { on: false }),
        C("genre", "Funkot"),
        C("custom", "コール入り", { not: true }),
        C("custom", "多幸感", { on: false }),
        C("text", "シグナル"),
        C("custom", "2015夏頒布", { on: false }),
      ];
    },
    "eight-manage"() { SCN.eight(); S.lens = true; S.lensView = "manage"; },
    zero() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix"), C("custom", "2009冬頒布"), C("custom", "サイレン")]; },
    "year-unset"() { S.yearUnset = true; },
    detail() { SCN.a(); S.open = songs[5].id; S.active = songs[5].id; },
    "detail-tech"() { SCN.a(); S.open = songs[5].id; S.active = songs[5].id; S.inspectorTechOpen = true; },
    "detail-many"() { SCN.a(); S.open = songs[4].id; S.active = songs[4].id; },
    "edit-single"() {
      SCN.a();
      S.open = songs[6].id;
      S.after = () => { openTagEditor([songs[6].id]); };
    },
    "edit-many"() {
      SCN.a();
      S.open = songs[4].id;
      S.after = () => { openTagEditor([songs[4].id]); };
    },
    "edit-year-conflict"() {
      const cf = findSpecial("迷宮ラジオの夜明け");
      S.open = cf.id;
      S.after = () => { openTagEditor([cf.id]); };
    },
    "edit-bulk"() {
      SCN.a();
      const s1 = songs[2];
      const s2 = songs[7]; // identical content_hash copy of s1!
      const s3 = songs[6];
      S.selectMode = true;
      S.selected = new Set([s1.id, s2.id, s3.id]);
      S.after = () => { openTagEditor([s1.id, s2.id, s3.id], { selectedTotal: 4, hiddenSelected: 1 }); };
    },
    "edit-conflict"() {
      SCN.a();
      S.after = () => {
        openTagEditor([songs[6].id]);
        S.tagModal.mode = "set";
        S.tagModal.yearValue = "2016";
        queueAddTag("custom", "ライブ定番");
        tagService.simulateBackgroundScan();
        saveTagModal();
      };
    },
    "edit-identity"() {
      SCN.a();
      S.after = () => {
        openTagEditor([songs[6].id]);
        S.tagModal.mode = "set";
        S.tagModal.yearValue = "2016";
        tagService.simulateFileReplacement(songs[6].path);
        saveTagModal();
      };
    },
    "edit-readonly"() {
      SCN.a();
      tagService.store_status = "corrupt";
      S.after = () => { openTagEditor([songs[6].id]); };
    },
    "a-select"() { SCN.a(); S.selectMode = true; [1, 2, 4].forEach((k) => S.selected.add(songs[k].id)); },
    loading() { SCN.a(); S.sim = "loading"; },
    error() { SCN.a(); compute(); lastGood = result; S.clauses.push(C("custom", "ネタ曲")); S.sim = "error"; },
    long() { SCN.a(); S.open = songs[4].id; S.active = songs[4].id; },
    added() { SCN.a(); S.after = () => { const s = result.find((x) => !x.missing && x.funkot && x.id !== nowPlaying.id); addTo("queue", [s.id], null); }; },
  };

  function scenario(name) {
    tagService.restoreSimulatedReplacements();
    tagService.store_status = "ready";
    Object.assign(S, {
      clauses: [], mode: "all", yearUnset: false, input: "", lens: false, lensView: "add",
      suggKind: "all", suggLimit: 12, focusClause: null, sugIndex: 0,
      sim: "ok", open: null, active: null, selectMode: false, dockOpen: false,
      limit: 60, dest: "queue", lastAdded: null, destList: false, rbMenu: false,
      inspectorTagFilter: "", inspectorTagsExpanded: false, inspectorTechOpen: false,
      tagModal: null, after: null,
    });
    S.selected = new Set();
    (SCN[name] || SCN.base)();
    compute();
    if (S.sim === "ok") lastGood = result;
    if (name === "a" || name === "eight") remember();
    render();
    if (S.after) { const f = S.after; S.after = null; f(); }
    document.querySelectorAll(".demo button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === name)));
  }

  $("#demo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scn]");
    if (b) {
      scenario(b.dataset.scn);
      history.replaceState(null, "", "#" + b.dataset.scn);
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.has("capture")) document.body.classList.add("capture");
  if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme");
  renderNow();
  document.fonts && document.fonts.ready.then(() => renderQuery());
  scenario(params.get("s") || location.hash.slice(1) || "base");

  window.FKP = {
    S,
    L,
    songs,
    byId,
    byPath,
    tagService,
    scenario,
    update,
    render,
    openDetail: (id) => { S.open = id; S.active = id; render(); },
    openTagEditor,
    closeTagEditor,
    saveTagModal,
    reloadTagModal,
    simulateBackgroundScan: () => tagService.simulateBackgroundScan(),
    simulateRescan: () => { tagService.simulateRescan(); update(); },
    simulateFileReplacement: (path) => tagService.simulateFileReplacement(path),
  };
})();
