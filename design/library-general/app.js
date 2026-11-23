// ラインナップ — general-audience library. Synthetic data only.
(function () {
  const { songs, tagIndex, playlists } = window.FK;
  const $ = (s, r = document) => r.querySelector(s);
  const app = $("#app");
  const q = $("#q");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtN = (n) => Number(n).toLocaleString("ja-JP");
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const KIND = { year: "制作年", genre: "ジャンル", custom: "タグ", text: "曲名", artist: "アーティスト" };
  const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>';
  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.2 11.2 2.8 7.8l1.2-1.2 2.2 2.2 5.6-5.6 1.2 1.2z"/></svg>';

  let uid = 1;
  const S = {
    clauses: [], mode: "all", input: "", sheet: null, sugIndex: 0, focusClause: null,
    dest: "queue", sim: "ok", sort: "added", limit: 40, open: null, active: null,
    recent: [], selectMode: false, selected: new Set(), toast: null, landed: "",
  };
  const L = { queue: [], fri: [], work: [], anison: [], fav: [] };
  const byId = new Map(songs.map((s) => [s.id, s]));
  const pickIds = (n, off) => Array.from({ length: n }, (_, i) => songs[(off + i * 131) % songs.length].id);
  pickIds(4, 40).forEach((id) => L.queue.push({ id, auto: false }));
  pickIds(3, 900).forEach((id) => L.queue.push({ id, auto: true }));
  pickIds(23, 1200).forEach((id) => L.fri.push({ id }));
  pickIds(61, 5000).forEach((id) => L.work.push({ id }));
  pickIds(11, 7000).forEach((id) => L.anison.push({ id }));
  pickIds(140, 3000).forEach((id) => L.fav.push({ id }));
  const nowPlaying = byId.get(songs[3].id);
  const twinKey = (s) => s.title + "\0" + s.artist;
  const twinCount = new Map();
  songs.forEach((s) => twinCount.set(twinKey(s), (twinCount.get(twinKey(s)) || 0) + 1));
  const tagsArr = [...tagIndex.values()];

  const fold = (s) => String(s).normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/りみっくす/g, "remix").replace(/anison[g]?/g, "あにそん").replace(/nihonjin/g, "日本人")
    .replace(/[\s・:：\-_\/()（）]/g, "");

  const clauseMatch = (c, s) => {
    let hit;
    switch (c.kind) {
      case "year": hit = c.values.includes(String(s.year)); break;
      case "genre": hit = c.values.some((v) => s.genres.includes(v)); break;
      case "custom": hit = c.values.some((v) => s.tags.includes(v)); break;
      case "artist": hit = c.values.includes(s.artist); break;
      case "text": {
        const f = fold(c.values[0]);
        hit = fold(s.title).includes(f) || fold(s.artist).includes(f);
        break;
      }
      default: hit = false;
    }
    return c.not ? !hit : hit;
  };

  let sugg = { out: [] };
  const pendingClause = () => {
    if (S.sheet !== "edit" || !S.input.trim() || S.focusClause) return null;
    const o = sugg.out[S.sugIndex];
    if (!o || o.n === 0) return null;
    return { kind: o.kind, values: o.values.slice(), on: true, not: false };
  };
  const liveClauses = () => {
    const a = S.clauses.filter((c) => c.on);
    const p = pendingClause();
    if (p) a.push(p);
    return a;
  };
  function filter(clauses, mode = S.mode) {
    if (!clauses.length) return songs;
    return mode === "all"
      ? songs.filter((s) => clauses.every((c) => clauseMatch(c, s)))
      : songs.filter((s) => clauses.some((c) => clauseMatch(c, s)));
  }
  const SORTS = {
    added: (a, b) => b.added - a.added,
    title: (a, b) => a.title.localeCompare(b.title, "ja"),
    year: (a, b) => (b.year || 0) - (a.year || 0),
  };
  let result = songs, lastGood = songs;
  function compute() {
    sugg = S.sheet === "edit" && S.input.trim() ? suggestions() : { out: [] };
    if (S.sugIndex >= sugg.out.length) S.sugIndex = 0;
    result = filter(liveClauses()).slice().sort(SORTS[S.sort]);
    if (S.sim === "ok") lastGood = result;
  }

  function suggestions() {
    const raw = S.input.trim();
    const fq = fold(raw);
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    const base = filter(S.clauses.filter((c) => c.on && c !== focus));
    const tags = [];
    for (const t of tagsArr) {
      if (focus && focus.kind !== t.kind) continue;
      if (S.clauses.some((c) => c.on && c.kind === t.kind && c.values.includes(t.value) && c.id !== S.focusClause)) continue;
      if (focus && focus.values.includes(t.value)) continue;
      const f = fold(t.value);
      const at = f.indexOf(fq);
      if (at < 0) continue;
      tags.push({ t, f, score: (at === 0 ? 2 : 0) + (f === fq ? 3 : 0) });
    }
    const countFor = (kind, value) => {
      const c = { kind, values: [value], on: true, not: false };
      let n = 0;
      for (const s of base) if (clauseMatch(c, s)) n++;
      return n;
    };
    const takenFold = new Set(S.clauses.filter((c) => c.on && c.id !== S.focusClause)
      .flatMap((c) => c.values.map((v) => c.kind + "|" + fold(v))));
    tags.sort((a, b) => b.score - a.score || b.t.count - a.t.count);
    const groups = new Map();
    for (const x of tags) {
      const k = x.t.kind + "|" + x.f;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x.t);
    }
    const out = [];
    let shown = 0;
    for (const g of groups.values()) {
      if (shown >= 8) break;
      g.sort((a, b) => b.count - a.count);
      const head = g[0];
      if (takenFold.has(head.kind + "|" + fold(head.value))) continue;
      out.push({
        kind: head.kind,
        values: [head.value],
        label: head.kind === "year" ? head.value + "年" : head.value,
        n: countFor(head.kind, head.value),
        variants: g.slice(1).map((v) => v.value),
      });
      shown++;
    }
    const lead = out.length && tags.length && tags[0].score >= 2 ? 1 : 0;
    const extra = [];
    if (!focus) {
      let n = 0;
      const tc = { kind: "text", values: [raw], on: true, not: false };
      for (const s of base) if (clauseMatch(tc, s)) n++;
      extra.push({ kind: "text", values: [raw], label: `「${raw}」を曲名かアーティストに含む`, n, variants: [] });
    }
    if (!focus || focus.kind === "artist") {
      const arts = new Map();
      for (const s of base) {
        if (s.artist && fold(s.artist).includes(fq)) arts.set(s.artist, (arts.get(s.artist) || 0) + 1);
        if (arts.size > 30) break;
      }
      [...arts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .forEach(([a, n]) => extra.push({ kind: "artist", values: [a], label: a, n, variants: [] }));
    }
    out.splice(Math.min(lead, out.length), 0, ...extra);
    return { out, base, more: Math.max(0, groups.size - shown) };
  }

  const clauseLabel = (c) => {
    const name = c.values.map((v) => (c.kind === "year" ? v + "年" : v)).join(" または ");
    return c.not ? `${name}以外` : name;
  };
  function fullSentence() {
    const join = S.mode === "all" ? "かつ" : "または";
    return S.clauses.map((c) => {
      const flags = [c.on ? "" : "停止"].filter(Boolean);
      const name = clauseLabel(c);
      return flags.length ? `${name}（${flags.join("、")}）` : name;
    }).join(` ${join} `);
  }
  function visibleSentence() {
    if (!S.clauses.length) return "";
    const paused = S.clauses.filter((c) => !c.on).length;
    const full = fullSentence();
    if (S.clauses.length >= 5) {
      const mode = S.mode === "all" ? "すべてに一致" : "どれかに一致";
      const pause = paused ? `、${paused}つは停止` : "";
      return `${S.clauses.length}条件${mode}${pause}`;
    }
    return full;
  }

  function snapshot() {
    return { clauses: JSON.parse(JSON.stringify(S.clauses)), mode: S.mode };
  }
  function remember() {
    if (!S.clauses.length) return;
    const key = JSON.stringify(snapshot());
    S.recent = S.recent.filter((r) => r.key !== key);
    S.recent.unshift({ key, snap: snapshot(), n: result.length });
    S.recent = S.recent.slice(0, 4);
  }
  function restore(snap) {
    S.clauses = JSON.parse(JSON.stringify(snap.clauses));
    S.mode = snap.mode;
    S.input = "";
    update();
  }

  function addValue(kind, values, opts = {}) {
    values = [].concat(values);
    const focus = S.clauses.find((c) => c.id === S.focusClause);
    if (focus && focus.kind === kind && kind !== "text") {
      values.forEach((v) => { if (!focus.values.includes(v)) focus.values.push(v); });
    } else if (kind === "year" && !opts.not) {
      const yc = S.clauses.find((c) => c.kind === "year" && c.on && !c.not);
      if (yc) values.forEach((v) => { if (!yc.values.includes(v)) yc.values.push(v); });
      else S.clauses.push({ id: uid++, kind, values, on: true, not: false });
    } else {
      S.clauses.push({ id: uid++, kind, values, on: true, not: !!opts.not });
    }
    S.input = "";
    S.sugIndex = 0;
    S.focusClause = null;
    S.sheet = "edit";
    update();
    remember();
  }
  function removeClause(id) {
    const i = S.clauses.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [c] = S.clauses.splice(i, 1);
    if (S.focusClause === id) S.focusClause = null;
    update();
    toast(`「${clauseLabel(c)}」を外しました`, "元に戻す", () => {
      S.clauses.splice(i, 0, c);
      update();
    });
  }

  function toast(text, action, fn) {
    S.toast = { text, action, fn, hold: !!S.toastHold };
    renderToast();
    clearTimeout(toast._t);
    if (!S.toastHold) toast._t = setTimeout(() => { S.toast = null; renderToast(); }, 6000);
  }

  function place(id) {
    const song = byId.get(id);
    if (!song) return;
    if (song.missing) return toast("ファイルが見つからないので追加できません");
    if (!song.funkot) return toast("Funkotとして扱われていないので追加できません");
    const name = playlists.find((p) => p.id === S.dest).name;
    const list = L[S.dest];
    if (S.dest === "fav" && list.some((x) => x.id === id)) {
      L.fav = list.filter((x) => x.id !== id);
      S.landed = "";
      update();
      return toast(`「${song.title}」をお気に入りから外しました`);
    }
    let pos;
    if (S.dest === "queue") {
      const at = list.findIndex((x) => x.auto);
      pos = at < 0 ? list.length : at;
      list.splice(pos, 0, { id, auto: false });
      pos += 1;
    } else {
      list.push({ id });
      pos = list.length;
    }
    const removed = S.dest === "queue" ? { id, auto: false } : { id };
    S.landed = `${pos}番目に追加`;
    update();
    toast(`「${song.title}」を${name}の${pos}番目に追加しました`, "元に戻す", () => {
      const i = L[S.dest].findIndex((x) => x.id === id && (S.dest !== "queue" || x.auto === false));
      if (i >= 0) L[S.dest].splice(i, 1);
      S.landed = "";
      update();
    });
    return removed;
  }

  function browseModel() {
    const base = filter(S.clauses.filter((c) => c.on));
    const years = new Map();
    const tags = new Map();
    for (const s of base) {
      if (s.year) years.set(s.year, (years.get(s.year) || 0) + 1);
      s.genres.forEach((g) => tags.set("genre:" + g, (tags.get("genre:" + g) || 0) + 1));
      s.tags.forEach((g) => tags.set("custom:" + g, (tags.get("custom:" + g) || 0) + 1));
    }
    const top = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, n]) => ({ kind: k.slice(0, k.indexOf(":")), value: k.slice(k.indexOf(":") + 1), n }));
    return { years, top, baseCount: base.length };
  }

  function drops() {
    return S.clauses.map((c) => {
      const rest = S.clauses.filter((x) => x !== c && x.on);
      return { id: c.id, label: clauseLabel(c), n: filter(rest).length };
    }).sort((a, b) => b.n - a.n);
  }

  function renderSummary() {
    const box = $("#summary");
    const viewN = S.sim === "error" ? lastGood.length : result.length;
    const count = S.sim === "loading" ? "照合しています" : S.sim === "error" ? "照合できませんでした" : `${fmtN(viewN)}曲`;
    const sentence = visibleSentence();
    const full = S.clauses.length ? fullSentence() : "条件はありません";
    box.innerHTML = (sentence
      ? `<button class="sum-line" id="sumBtn" type="button" aria-expanded="${S.sheet === "edit"}" aria-label="${esc(full)}。条件を編集">${esc(sentence)}</button>`
      : "") + `<p class="count" id="count">${S.sim === "ok" ? `<strong>${esc(count)}</strong>` : esc(count)}</p>`;
  }

  function renderTicket() {
    const d = playlists.find((p) => p.id === S.dest);
    const n = L[S.dest].length;
    const sub = S.landed || `${fmtN(n)}曲`;
    const btn = $("#destBtn");
    btn.classList.toggle("is-landed", !!S.landed);
    btn.setAttribute("aria-expanded", String(S.sheet === "dest"));
    btn.setAttribute("aria-label", `追加先は${d.name}、${sub}。変更する`);
    btn.innerHTML = `<span class="k">追加先</span><span class="nm">${esc(d.name)}</span><span class="sub">${esc(sub)}</span>`;
  }

  function renderNow() {
    $("#now").innerHTML = `
      <p class="now-title"><span class="nm">${esc(nowPlaying.title)}</span></p>
      <p class="now-meta">${esc(nowPlaying.artist)}　再生元 再生待ち</p>
      <div class="now-actions">
        <button type="button" id="pauseBtn" aria-pressed="false" aria-label="一時停止">停止</button>
        <button type="button" id="nextBtn" aria-label="次の曲">次へ</button>
      </div>`;
  }

  function trackHtml(s) {
    const open = S.open === s.id;
    const playing = s.id === nowPlaying.id;
    const twins = twinCount.get(twinKey(s)) || 1;
    const title = s.untitled ? `${s.title}.${s.fmt.toLowerCase()}` : s.title;
    const d = playlists.find((p) => p.id === S.dest);
    const blocked = s.missing || !s.funkot;
    const inFav = S.dest === "fav" && L.fav.some((x) => x.id === s.id);
    const why = [];
    if (playing) why.push(`<span class="playing-word">再生中</span>`);
    if (!s.artist) why.push(`<span class="artist is-missing">アーティスト情報なし</span>`);
    else why.push(`<span class="artist">${esc(s.artist)}</span>`);
    if (twins > 1) why.push(`<span class="twin">同名${twins}件 ${esc(s.fmt)}</span>`);
    if (s.missing) why.push(`<span>ファイルなし</span>`);
    else if (!s.funkot) why.push(`<span>追加できない</span>`);
    why.push(`<span>${s.year || "年なし"}</span>`);
    why.push(`<span>${fmtDur(s.dur)}</span>`);
    const detail = open ? detailHtml(s, twins) : "";
    const label = blocked
      ? (s.missing ? `「${title}」はファイルが見つからない` : `「${title}」は追加できない`)
      : `「${title}」を${d.name}に追加`;
    return `<li class="track${open ? " is-open" : ""}${playing ? " is-on" : ""}" data-id="${s.id}">
      <button class="title" type="button" data-act="open" data-id="${s.id}" aria-expanded="${open}">
        <span class="t${s.untitled ? " is-file" : ""}">${esc(title)}</span>
        <span class="sub">${why.join("")}</span>
      </button>
      <button class="add${blocked ? " is-blocked" : ""}${inFav ? " is-in" : ""}" type="button" data-act="add" data-id="${s.id}" aria-label="${esc(label)}" ${blocked ? 'aria-disabled="true"' : ""}>${inFav ? CHECK : PLUS}</button>
      ${detail}
    </li>`;
  }

  function detailHtml(s, twins) {
    const title = s.untitled ? `${s.title}.${s.fmt.toLowerCase()}` : s.title;
    const tags = [...s.genres.map((t) => ({ t, kind: "genre" })), ...s.tags.map((t) => ({ t, kind: "custom" }))];
    const mates = twins > 1 ? songs.filter((o) => twinKey(o) === twinKey(s) && o.id !== s.id) : [];
    return `<div class="detail">
      <p class="full">${esc(title)}</p>
      <p>${esc(s.folder)} / ${esc(s.fmt)}　再生 ${fmtN(s.plays)} 回${s.yearStatus === "manual" ? "　制作年は手入力" : ""}${s.yearStatus === "missing" ? "　制作年は未設定" : ""}</p>
      ${s.missing ? `<p>ファイルが見つからないので追加できません。</p>` : ""}
      ${!s.funkot ? `<p>Funkotとして扱われていないので追加できません。</p>` : ""}
      <div class="tags">
        ${tags.map((x) => `<button type="button" data-act="tag" data-kind="${x.kind}" data-v="${esc(x.t)}">${esc(x.t)}</button>`).join("")}
        <button type="button" data-act="fav" data-id="${s.id}">${L.fav.some((f) => f.id === s.id) ? "お気に入りを外す" : "お気に入りにする"}</button>
      </div>
      ${mates.map((m) => `<p>もう一つのファイル ${esc(m.fmt)} ${fmtDur(m.dur)}　<button class="textish" type="button" data-act="add" data-id="${m.id}">このファイルを追加</button></p>`).join("")}
    </div>`;
  }

  function renderList() {
    const tracks = $("#tracks");
    const empty = $("#empty");
    const banner = $("#banner");
    $("#list").setAttribute("aria-busy", String(S.sim === "loading"));
    if (S.sim === "loading") {
      banner.hidden = true;
      empty.hidden = true;
      tracks.classList.remove("is-stale");
      tracks.innerHTML = Array.from({ length: 6 }, () => `<li class="sk" aria-hidden="true"></li>`).join("");
      return;
    }
    if (S.sim === "error") {
      banner.hidden = false;
      banner.innerHTML = `<span role="alert">照合できませんでした。条件はそのまま残っています。</span> <button type="button" id="retry">再試行</button><span class="stale">前回の結果</span>`;
      tracks.classList.add("is-stale");
    } else {
      banner.hidden = true;
      tracks.classList.remove("is-stale");
    }
    const view = S.sim === "error" ? lastGood : result;
    if (!view.length && S.sim !== "error") {
      tracks.innerHTML = "";
      empty.hidden = false;
      const alts = drops();
      const flipped = S.mode === "all" ? filter(S.clauses.filter((c) => c.on), "any").length : 0;
      empty.innerHTML = `<p>一致する曲はない</p>` + alts.map((d) =>
        `<button type="button" data-act="drop" data-id="${d.id}">${esc(d.label)}を外すと ${fmtN(d.n)}曲</button>`).join("")
        + (flipped ? `<button type="button" data-act="any">どれかに一致にすると ${fmtN(flipped)}曲</button>` : "");
      return;
    }
    empty.hidden = true;
    tracks.innerHTML = view.slice(0, S.limit).map(trackHtml).join("");
  }

  function renderSheet() {
    const sheet = $("#sheet");
    const scrim = $("#scrim");
    const open = S.sheet === "edit" || S.sheet === "dest";
    sheet.hidden = !open;
    scrim.hidden = !open;
    q.setAttribute("aria-expanded", String(S.sheet === "edit"));
    if (!open) { sheet.innerHTML = ""; return; }
    if (S.sheet === "dest") return renderDest(sheet);
    const modeWord = S.mode === "all" ? "すべてに一致" : "どれかに一致";
    const clauses = S.clauses.map((c) => `
      <div class="clause${c.on ? "" : " is-off"}">
        <p class="clause-name${c.not ? " is-not" : ""}">${esc(clauseLabel(c))}</p>
        <span class="clause-kind">${KIND[c.kind]}</span>
        <div class="clause-acts">
          <button type="button" data-act="pause" data-id="${c.id}" aria-pressed="${!c.on}">${c.on ? "一時停止" : "再開"}</button>
          <button type="button" data-act="not" data-id="${c.id}" aria-pressed="${c.not}">${c.not ? "以外をやめる" : "これ以外"}</button>
          ${c.kind !== "text" ? `<button type="button" data-act="or" data-id="${c.id}">またはを足す</button>` : ""}
          <button type="button" data-act="rm" data-id="${c.id}">外す</button>
        </div>
      </div>`).join("");
    let body;
    if (S.input.trim()) {
      body = `<div id="cands" role="listbox" aria-label="候補">${sugg.out.map((o, i) => `
        <div class="cand-row${i === S.sugIndex ? " is-on" : ""}" id="opt-${i}" role="option" aria-selected="${i === S.sugIndex}">
          <button class="cand${o.n === 0 ? " is-zero" : ""}" type="button" data-act="pick" data-i="${i}">
            <span class="kind">${KIND[o.kind]}</span>
            <span class="val">${esc(o.label)}</span>
            <span class="pred">加えると ${fmtN(o.n)}曲</span>
          </button>
          ${o.variants.length ? `<p class="alts">表記ゆれ ${esc(o.variants.join("、"))}</p><button class="bundle" type="button" data-act="bundle" data-i="${i}">表記ゆれをまとめて加える</button>` : ""}
        </div>`).join("")}
        ${sugg.more ? `<p class="alts">ほか ${fmtN(sugg.more)} 件。文字を足すと狭まる</p>` : ""}
      </div>`;
      const cur = sugg.out[S.sugIndex];
      q.setAttribute("aria-activedescendant", cur ? `opt-${S.sugIndex}` : "");
    } else {
      q.removeAttribute("aria-activedescendant");
      const { years, top } = browseModel();
      const ys = [];
      let max = 1;
      years.forEach((n) => { if (n > max) max = n; });
      for (let y = 2008; y <= 2026; y++) {
        const n = years.get(y) || 0;
        const on = S.clauses.some((c) => c.kind === "year" && c.values.includes(String(y)));
        ys.push(`<button class="year-bar" type="button" data-act="year" data-v="${y}" aria-pressed="${on}" aria-label="${y}年、${fmtN(n)}曲"><i style="height:${Math.max(2, (n / max) * 42)}px"></i><span>${String(y).slice(2)}</span></button>`);
      }
      const hist = S.recent.slice(1).map((r, i) => {
        const label = r.snap.clauses.map(clauseLabel).slice(0, 3).join(" かつ ");
        return `<button class="hist" type="button" data-act="hist" data-i="${i + 1}">${esc(label)} に戻す（${fmtN(r.n)}曲）</button>`;
      }).join("");
      body = `
        <p class="browse-label">制作年</p>
        <div class="years">${ys.join("")}</div>
        <p class="browse-label">いまの結果に多いタグ</p>
        ${top.map((t) => `<button class="hist" type="button" data-act="top" data-kind="${t.kind}" data-v="${esc(t.value)}">${esc(t.value)}　${fmtN(t.n)}曲</button>`).join("")}
        ${hist ? `<p class="browse-label">直前の条件</p>${hist}` : ""}
        <p class="browse-label">並び</p>
        <div class="sorts">
          <button type="button" data-act="sort" data-v="added" aria-pressed="${S.sort === "added"}">新しく追加した順</button>
          <button type="button" data-act="sort" data-v="title" aria-pressed="${S.sort === "title"}">曲名順</button>
          <button type="button" data-act="sort" data-v="year" aria-pressed="${S.sort === "year"}">制作年が新しい順</button>
        </div>`;
    }
    sheet.innerHTML = `
      <div class="sheet-head">
        <button class="mode" type="button" id="modeBtn" data-act="mode" aria-pressed="${S.mode === "all"}">${modeWord}</button>
        <button class="close-sheet" type="button" data-act="close">閉じる</button>
      </div>
      ${clauses}
      ${body}`;
  }

  function renderDest(sheet) {
    const d = playlists.find((p) => p.id === S.dest);
    const list = L[S.dest];
    const last = [...list].reverse().find((x) => !x.auto) || list[list.length - 1];
    const lastName = last ? byId.get(last.id).title : "まだない";
    sheet.innerHTML = `
      <div class="sheet-head"><p style="margin:0;font-weight:700">追加先</p><button class="close-sheet" type="button" data-act="close">閉じる</button></div>
      <p class="tail">${esc(d.name)}の末尾は「${esc(lastName)}」</p>
      ${playlists.map((p) => `<button class="dest-opt" type="button" data-act="dest" data-id="${p.id}" aria-current="${p.id === S.dest}">${esc(p.name)}<span>${fmtN(L[p.id].length)}曲</span></button>`).join("")}`;
  }

  function renderToast() {
    const el = $("#toast");
    if (!S.toast) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = `<span>${esc(S.toast.text)}</span>${S.toast.action ? `<button type="button" id="toastAct">${esc(S.toast.action)}</button>` : ""}`;
  }

  function update() {
    compute();
    if (q.value !== S.input) q.value = S.input;
    renderSummary();
    renderTicket();
    renderList();
    renderSheet();
    renderToast();
    const head = $(".top").offsetHeight;
    document.documentElement.style.setProperty("--head", head + "px");
    app.dataset.sheet = S.sheet || "";
    app.dataset.sim = S.sim;
  }

  function closeSheet() {
    S.sheet = null;
    S.input = "";
    S.focusClause = null;
    update();
  }

  function pickAt(i, bundle) {
    const o = sugg.out[i];
    if (!o) return;
    const values = bundle ? o.values.concat(o.variants) : o.values;
    addValue(o.kind, values);
    q.focus();
  }

  q.addEventListener("input", () => {
    S.input = q.value;
    S.sheet = "edit";
    S.sugIndex = 0;
    update();
  });
  q.addEventListener("focus", () => {
    if (S.sheet !== "dest") { S.sheet = "edit"; update(); }
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!sugg.out.length) return;
      S.sugIndex = (S.sugIndex + (e.key === "ArrowDown" ? 1 : sugg.out.length - 1)) % sugg.out.length;
      update();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sugg.out.length) pickAt(S.sugIndex, false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSheet();
    } else if (e.key === "Backspace" && !q.value && S.clauses.length) {
      removeClause(S.clauses[S.clauses.length - 1].id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && e.target !== q) { e.preventDefault(); q.focus(); }
    if (e.key === "Escape" && e.target !== q) {
      if (S.sheet) closeSheet();
      else if (S.open) { S.open = null; update(); }
    }
    if ((e.key === "a" || e.key === "A") && e.target === document.body && S.active != null) place(S.active);
  });

  $("#app").addEventListener("click", (e) => {
    const scrim = e.target.closest("#scrim");
    if (scrim) return closeSheet();
    if (e.target.closest("#sumBtn")) { S.sheet = S.sheet === "edit" ? null : "edit"; S.input = ""; update(); return; }
    if (e.target.closest("#destBtn")) { S.sheet = S.sheet === "dest" ? null : "dest"; update(); return; }
    if (e.target.closest("#retry")) { S.sim = "ok"; update(); return; }
    if (e.target.closest("#toastAct") && S.toast?.fn) { const fn = S.toast.fn; S.toast = null; fn(); return; }
    if (e.target.closest("#pauseBtn")) {
      const b = $("#pauseBtn");
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b || !b.closest("#sheet, #list, #empty, #tracks")) return;
    const act = b.dataset.act;
    if (act === "close") return closeSheet();
    if (act === "open") {
      const id = Number(b.dataset.id);
      S.active = id;
      S.open = S.open === id ? null : id;
      S.sheet = null;
      S.input = "";
      update();
      return;
    }
    if (act === "add") return place(Number(b.dataset.id));
    if (act === "fav") { S.dest = "fav"; return place(Number(b.dataset.id)); }
    if (act === "tag") { addValue(b.dataset.kind, b.dataset.v); return; }
    if (act === "drop") return removeClause(Number(b.dataset.id));
    if (act === "any") { S.mode = "any"; update(); return; }
    if (act === "pause") {
      const c = S.clauses.find((x) => x.id === Number(b.dataset.id));
      c.on = !c.on; update(); return;
    }
    if (act === "not") {
      const c = S.clauses.find((x) => x.id === Number(b.dataset.id));
      c.not = !c.not; update(); return;
    }
    if (act === "rm") return removeClause(Number(b.dataset.id));
    if (act === "or") { S.focusClause = Number(b.dataset.id); q.focus(); return; }
    if (act === "pick") return pickAt(Number(b.dataset.i), false);
    if (act === "bundle") return pickAt(Number(b.dataset.i), true);
    if (act === "year") return addValue("year", b.dataset.v);
    if (act === "top") return addValue(b.dataset.kind, b.dataset.v);
    if (act === "hist") { restore(S.recent[Number(b.dataset.i)].snap); return; }
    if (act === "sort") { S.sort = b.dataset.v; update(); return; }
    if (act === "dest") { S.dest = b.dataset.id; S.landed = ""; S.sheet = null; update(); return; }
    if (act === "mode") { S.mode = S.mode === "all" ? "any" : "all"; update(); }
  });

  new IntersectionObserver((en) => {
    if (en[0].isIntersecting && result.length > S.limit && S.sim !== "loading") {
      S.limit += 40;
      renderList();
    }
  }, { root: $("#list") }).observe($("#sentinel"));

  const C = (kind, values, extra = {}) => Object.assign({ id: uid++, kind, values: [].concat(values), on: true, not: false }, extra);
  const SCN = {
    base() {},
    a() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix")]; },
    "a-edit"() { SCN.a(); S.sheet = "edit"; S.input = "anison"; },
    added() { SCN.a(); },
    eight() {
      S.clauses = [
        C("year", ["2015", "2016"]), C("custom", "日本人トラックメーカー"),
        C("genre", ["アニソンremix", "アニソンRemix", "anison remix"]),
        C("custom", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", { on: false }),
        C("genre", "Funkot"), C("custom", "コール入り", { not: true }),
        C("custom", "多幸感", { on: false }), C("text", "シグナル"), C("custom", "2015夏頒布", { on: false }),
      ];
    },
    "eight-edit"() { SCN.eight(); S.sheet = "edit"; },
    detail() {
      SCN.a();
      const s = songs.find((x) => x.title.startsWith("星屑ラジオ"));
      S.open = s.id; S.active = s.id;
    },
    zero() { S.clauses = [C("year", "2015"), C("custom", "日本人トラックメーカー"), C("genre", "アニソンremix"), C("custom", "2009冬頒布"), C("custom", "サイレン")]; },
    loading() { SCN.a(); S.sim = "loading"; },
    error() { SCN.a(); },
    zoom() { SCN.a(); document.documentElement.style.fontSize = "32px"; },
  };
  function scenario(name) {
    document.documentElement.style.fontSize = "";
    Object.assign(S, {
      clauses: [], mode: "all", input: "", sheet: null, sugIndex: 0, focusClause: null,
      sim: "ok", sort: "added", limit: 40, open: null, active: null, landed: "", dest: "queue",
    });
    S.toastHold = false;
    S.toast = null;
    (SCN[name] || SCN.base)();
    if (name === "error") { compute(); lastGood = result; S.sim = "error"; }
    S.toastHold = name === "added";
    update();
    if (name === "added") {
      const hit = result.find((s) => s.title === "鋼鉄商店街ダンスホール") || result[0];
      place(hit.id);
    }
    if (name === "a" || name === "eight") remember();
    document.querySelectorAll(".demo button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scn === name)));
  }
  $("#demo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scn]");
    if (b) scenario(b.dataset.scn);
  });
  const params = new URLSearchParams(location.search);
  if (params.has("capture")) document.body.classList.add("capture");
  renderNow();
  scenario(params.get("s") || "base");
  window.FKP = { S, L, scenario, update, place, result: () => result };
})();
