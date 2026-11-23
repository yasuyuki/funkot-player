// Liner Index tag editor. This is a deterministic in-browser fixture: it never
// reaches the filesystem or writes embedded audio metadata.
(function () {
  const FK = window.FK;
  if (!FK || !Array.isArray(FK.songs)) return;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const tagKey = (kind, value) => `${kind}:${value}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const kindName = { genre: "ジャンル", custom: "タグ" };
  const identity = new WeakMap();
  const records = new Map();
  const fixtureSources = new WeakMap();
  const fixtureHashes = new WeakMap();
  let revision = 1;
  let dialog;
  let closeResult;
  let returnFocus;

  function sourceFor(song) {
    const automaticYear = Number.isInteger(song.year) && song.yearStatus !== "manual" ? song.year : null;
    const manualYear = Number.isInteger(song.year) && song.yearStatus === "manual" ? song.year : null;
    const yearStatus = automaticYear ? "valid" : song.yearStatus === "pending" ? "pending" : "missing";
    return {
      automaticYear,
      automaticYearStatus: yearStatus,
      candidates: automaticYear ? [{ key: "year:recording", rank: 0, source: "埋め込み録音日", value: String(automaticYear), status: "valid" }] : [{ key: "year:recording", rank: 0, source: "埋め込みメタデータ", value: "利用できる年がありません", status: yearStatus }],
      genres: [...new Set(song.genres || [])],
      // In this fixture genres and years are embedded. Ordinary custom tags are
      // local/manual records from the beginning, never invented audio metadata.
      custom: [],
      initialCustom: [...new Set(song.tags || [])],
      initialManualYear: manualYear,
      metadataStatus: yearStatus === "pending" ? "pending" : "ready",
    };
  }

  function hashFor(song, number) { return fixtureHashes.get(song) || `fixture-${number.toString(36)}-${String(song.fmt || "audio").toLowerCase()}`; }

  function installFixtureOverlay() {
    // Two distinct synthetic paths deliberately share bytes: same format,
    // duration, and embedded source. Existing same-title MP3/FLAC editions
    // remain independent because they are not content-identical.
    const seen = new Map();
    let copies;
    for (const song of FK.songs) {
      const key = `${song.fmt}|${song.dur}`;
      const first = seen.get(key);
      if (first && first.folder !== song.folder) { copies = [first, song]; break; }
      if (!first) seen.set(key, song);
    }
    if (copies) {
      const [original, copy] = copies;
      const source = sourceFor(original);
      fixtureSources.set(original, source);
      fixtureSources.set(copy, clone(source));
      fixtureHashes.set(original, "fixture-identical-copy");
      fixtureHashes.set(copy, "fixture-identical-copy");
    }
    FK.songs.forEach((song, number) => {
      const source = fixtureSources.get(song) || sourceFor(song);
      if (song.id === 90) { source.automaticYear = null; source.automaticYearStatus = "invalid"; source.initialManualYear = 2015; source.candidates = [{ key: "year:recording", rank: 0, source: "埋め込み録音日", value: "20XX", status: "invalid" }]; }
      if (song.id === 91) { source.automaticYear = null; source.automaticYearStatus = "future"; source.initialManualYear = 2015; source.candidates = [{ key: "year:recording", rank: 0, source: "埋め込み録音日", value: "2099", status: "future" }]; }
      if (song.id === 92) { source.automaticYear = null; source.automaticYearStatus = "conflict"; source.initialManualYear = 2015; source.candidates = [{ key: "year:recording", rank: 0, source: "埋め込み録音日", value: "2014", status: "conflict" }, { key: "year:recording", rank: 0, source: "埋め込み録音日", value: "2016", status: "conflict" }]; }
      if (song.id === 24821) source.initialCustom = Array.from({ length: 112 }, (_, index) => `Crew: Neon Harbor ${String(index + 1).padStart(3, "0")}`);
      if (song.id === 95) {
        source.automaticYear=null; source.initialManualYear=null; source.automaticYearStatus="pending"; source.candidates=[];
      }
      const meta = { resolved:song.id !== 94, hash: hashFor(song, number), fingerprint: `${song.id}|${song.fmt}|${song.dur}`, source };
      identity.set(song, meta);
      if (!records.has(meta.hash)) {
        records.set(meta.hash, {
          hash: meta.hash,
          manualYear: meta.source.initialManualYear == null ? { mode: "auto", value: null } : { mode: "set", value: meta.source.initialManualYear },
          additions: [...meta.source.initialCustom.map((value) => tagKey("custom", value))],
          suppressions: [],
        });
      }
    });
    FK.songs.forEach(refreshSong);
    syncTagIndex();
  }

  function recordFor(song) {
    const meta = identity.get(song);
    return meta && records.get(meta.hash);
  }

  function effectiveTags(song) {
    const meta = identity.get(song);
    const record = recordFor(song);
    if (!meta || !record) return [];
    const out = [];
    [["genre", meta.source.genres], ["custom", meta.source.custom]].forEach(([kind, values]) => values.forEach((value) => {
      const key = tagKey(kind, value);
      if (!record.suppressions.includes(key)) out.push({ kind, value, origin: record.additions.includes(key) ? "both" : "embedded" });
    }));
    record.additions.forEach((key) => {
      const [kind, ...value] = key.split(":");
      if (!out.some((tag) => tagKey(tag.kind, tag.value) === key)) out.push({ kind, value: value.join(":"), origin: "manual" });
    });
    return out;
  }

  function effectiveYear(song) {
    const meta = identity.get(song);
    const record = recordFor(song);
    if (!meta || !record) return { value: null, origin: "none", status: "identity_unavailable" };
    if (record.manualYear.mode === "set") return { value: record.manualYear.value, origin: "manual", status: "valid" };
    if (record.manualYear.mode === "unset") return { value: null, origin: "manual", status: "suppressed" };
    return { value: meta.source.automaticYear, origin: meta.source.automaticYear == null ? "none" : "embedded", status: meta.source.automaticYearStatus };
  }

  function refreshSong(song) {
    const year = effectiveYear(song);
    song.year = year.value;
    song.yearStatus = year.origin === "manual" ? (year.status === "suppressed" ? "unset" : "manual") : year.status;
    song.genres = effectiveTags(song).filter((tag) => tag.kind === "genre").map((tag) => tag.value);
    song.tags = effectiveTags(song).filter((tag) => tag.kind === "custom").map((tag) => tag.value);
    song.funkot = song.genres.includes("Funkot");
  }

  function syncTagIndex() {
    FK.tagIndex.forEach((entry) => { entry.count = 0; });
    FK.songs.forEach((song) => {
      effectiveTags(song).forEach((tag) => {
        const key = tagKey(tag.kind, tag.value);
        let entry = FK.tagIndex.get(key);
        if (!entry) { entry = { key, kind: tag.kind, value: tag.value, count: 0 }; FK.tagIndex.set(key, entry); }
        entry.count++;
      });
      if (song.year) {
        const key = tagKey("year", song.year);
        let entry = FK.tagIndex.get(key);
        if (!entry) { entry = { key, kind: "year", value: String(song.year), count: 0 }; FK.tagIndex.set(key, entry); }
        entry.count++;
      }
    });
  }

  function tagInfo(song) {
    const meta = identity.get(song);
    if (!meta) return { editable: false, reason: "この曲の識別情報を確認できません。" };
    const year = effectiveYear(song);
    return Object.freeze({
      editable: meta.resolved,
      revision: `liner-${revision}`,
      contentHash: meta.resolved ? meta.hash : null,
      identity: Object.freeze({ contentHash: meta.hash, fingerprint: meta.fingerprint }),
      year: Object.freeze({ value: year.value, origin: year.origin, status: year.status, automatic: meta.source.automaticYear, automaticStatus: meta.source.automaticYearStatus, candidates: clone(meta.source.candidates) }),
      tags: Object.freeze(effectiveTags(song).map((tag) => Object.freeze({ ...tag }))),
      metadata: Object.freeze({ status: meta.source.metadataStatus, source: "合成の埋め込みメタデータ。音声ファイルは読み取り専用です。" }),
    });
  }

  function byHash(targets) {
    return [...new Map(targets.map((song) => [identity.get(song).hash, song])).values()];
  }

  function targetNames(targets) {
    if (targets.length === 1) return `${targets[0].title || "無題"} — ${targets[0].artist || "アーティスト不明"}`;
    return `${targets.length} 曲を固定して編集`;
  }

  function suggestionsMarkup(state) {
    const {draft, targets} = state;
    const typed = draft.filter.trim().normalize("NFC");
    if (!typed) return "";
    const needle = typed.toLocaleLowerCase();
    const current = new Map(tagsForTarget(targets).map(tag => [tagKey(tag.kind,tag.value),tag]));
    const matched = [...FK.tagIndex.values()].filter(t => (t.kind === "custom" || t.kind === "genre") && t.value.toLocaleLowerCase().includes(needle));
    matched.sort((a,b) => Number(b.value===typed)-Number(a.value===typed) || Number(current.has(b.key))-Number(current.has(a.key)) || b.count-a.count);
    const choices = matched.slice(0,5);
    for(const kind of ["custom","genre"]) {
      if (!choices.some(t=>t.kind===kind && t.value===typed)) choices.push({kind,value:typed,key:tagKey(kind,typed)});
    }
    return choices.flatMap(tag=>{
      const key=tagKey(tag.kind,tag.value), existing=current.get(key);
      const actions=[];
      if (existing) actions.push(["remove",removalName(existing.origin)]);
      if (!existing || existing.count<targets.length) actions.push(["add",existing ? "残りにも追加" : "追加"]);
      return actions.map(([act,verb]) => {
        const pending=draft[act].includes(key);
        return `<li><button type="button" data-editor-action="${act}" data-key="${esc(key)}" ${pending?"disabled":""}><b>${esc(kindName[tag.kind])}</b><span>${esc(tag.value)}</span><i>${pending?"変更予定":verb}</i></button></li>`;
      });
    }).join("");
  }
  function renderSuggestions(state) {
    dialog.querySelector("#indexEditorSuggestions").innerHTML = suggestionsMarkup(state);
  }
  function dialogMarkup() {
    dialog = document.createElement("dialog");
    dialog.className = "index-editor";
    dialog.setAttribute("aria-labelledby", "indexEditorTitle");
    dialog.innerHTML = '<form method="dialog" class="index-editor-paper"><header class="index-editor-heading"><div><p class="index-editor-kicker">タグ編集</p><h2 id="indexEditorTitle"></h2><p class="index-editor-target" id="indexEditorTarget"></p></div><button class="index-editor-x" type="button" data-editor-action="cancel" aria-label="タグ編集を取り消す">×</button></header><div class="index-editor-body" id="indexEditorBody"></div><footer class="index-editor-actions"><span class="index-editor-pending" id="indexEditorPending" role="status"></span><span class="index-editor-actions-grow"></span><button type="button" class="index-editor-cancel" data-editor-action="cancel">キャンセル</button><button type="button" class="index-editor-save" data-editor-action="save">変更を保存</button></footer></form>';
    dialog.addEventListener("cancel", (event) => {
      if (dialog.dataset.busy === "true") { event.preventDefault(); return; }
      event.preventDefault();
      if (typeof dialog._attemptCancel === "function") dialog._attemptCancel(); else close(false, "cancelled");
    });
    dialog.addEventListener("click", (event) => { if (event.target === dialog && dialog.dataset.busy !== "true") { if (typeof dialog._attemptCancel === "function") dialog._attemptCancel(); else close(false, "cancelled"); } });
    document.body.append(dialog);
  }

  function initialDraft(targets) {
    return {
      year: { mode: "unchanged", value: "" },
      add: [],
      remove: [],
      filter: "",
      notice: "",
      error: "",
      expectedRevision: revision,
      expected: new Map(targets.map((song) => [song, { hash: identity.get(song).hash, fingerprint: identity.get(song).fingerprint }])),
    };
  }

  function changesCount(draft) { return draft.add.length + draft.remove.length + (draft.year.mode === "unchanged" ? 0 : 1); }
  function tagsForTarget(targets) {
    const byKey = new Map();
    targets.forEach((song) => effectiveTags(song).forEach((tag) => {
      const key = tagKey(tag.kind, tag.value);
      const item = byKey.get(key) || { ...tag, count: 0, origins: new Set() };
      item.count++;
      item.origins.add(tag.origin);
      byKey.set(key, item);
    }));
    return [...byKey.values()].map((tag) => ({ ...tag, origin: tag.origins.size === 1 ? [...tag.origins][0] : "mixed" })).sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value));
  }

  function originName(origin) { return ({ embedded: "埋め込み", manual: "手動", both: "埋め込み・手動", mixed: "混在" })[origin] || origin; }
  function removalName(origin) { return origin === "manual" ? "削除" : origin === "embedded" ? "除外" : "対象から外す"; }

  function render(state) {
    const { targets, draft } = state;
    const footer = dialog.querySelector(".index-editor-actions");
    if (!footer.querySelector("#indexEditorPending")) footer.innerHTML = '<span class="index-editor-pending" id="indexEditorPending" role="status"></span><span class="index-editor-actions-grow"></span><button type="button" class="index-editor-cancel" data-editor-action="cancel">キャンセル</button><button type="button" class="index-editor-save" data-editor-action="save">変更を保存</button>';
    footer.querySelector(".index-editor-reload")?.remove();
    const unique = byHash(targets).length;
    const count = changesCount(draft);
    dialog.querySelector("#indexEditorTitle").textContent = targets.length === 1 ? targets[0].title || "無題" : `${targets.length} 曲のタグを編集`;
    dialog.querySelector("#indexEditorTarget").textContent = targets.length === 1 ? targets[0].artist || "アーティスト不明" : `${targetNames(targets)} · ${unique === targets.length ? "別々に保存" : `${unique} 件の共有データとして保存`}`;
    dialog.querySelector("#indexEditorPending").textContent = count ? `未保存の変更 ${count} 件` : "未保存の変更はありません";
    dialog.querySelector(".index-editor-save").disabled = !count || dialog.dataset.busy === "true";
    const tags = tagsForTarget(targets);
    const currentNeedle = draft.filter.trim().toLocaleLowerCase();
    const currentTags = currentNeedle ? tags.filter((tag) => `${tag.value} ${tag.kind}`.toLocaleLowerCase().includes(currentNeedle)) : tags;
    draft.currentLimit ||= 8;
    if (!currentTags.some((tag) => tagKey(tag.kind, tag.value) === draft.selectedKey)) draft.selectedKey = currentTags[0] && tagKey(currentTags[0].kind, currentTags[0].value);
    const current = currentTags.slice(0, draft.currentLimit).map((tag) => {
      const key = tagKey(tag.kind, tag.value);
      const pending = draft.remove.includes(key);
      return `<li class="index-editor-tag${pending ? " is-pending-remove" : ""}"><span><b>${esc(kindName[tag.kind])}</b>${esc(tag.value)} <i>${originName(tag.origin)}</i>${tag.count < targets.length ? `<em>${tag.count}/${targets.length} 曲にあり</em>` : ""}</span></li>`;
    }).join("") || '<li class="index-editor-empty">該当するタグはありません。</li>';
    const pending = [...draft.add.map((key) => ({ key, kind: key.split(":")[0], value: key.split(":").slice(1).join(":") })), ...draft.remove.map((key) => ({ key, remove: true, kind: key.split(":")[0], value: key.split(":").slice(1).join(":") }))]
      .map((tag) => `<li class="${tag.remove ? "pending-remove" : "pending-add"}">${tag.remove ? "除外" : "追加"} ${esc(kindName[tag.kind])}: ${esc(tag.value)} <button type="button" data-editor-action="undo" data-key="${esc(tag.key)}" data-kind="${tag.remove ? "remove" : "add"}" aria-label="${esc(tag.value)} を取り消す">×</button></li>`).join("");
    const source = targets.length === 1 ? tagInfo(targets[0]) : null;
    const years = [...new Set(targets.map((song) => effectiveYear(song).value == null ? "未設定" : String(effectiveYear(song).value)))];
    const yearSummary = source ? source.year.value || (source.year.status === "pending" ? "確認中" : "未設定") : years.length === 1 ? `共通: ${years[0]}` : "混在（変更しない）";
    const selectedTag = currentTags.find((tag) => tagKey(tag.kind, tag.value) === draft.selectedKey);
    const yearsNote={valid:"有効",invalid:"無効な値",future:"未来の年",conflict:"同じ優先度で複数の年",missing:"候補なし"};
    const candidates = source ? source.year.candidates.map((item) => `<li><b>${esc(item.source)}</b><span>${esc(item.value)} · ${esc(yearsNote[item.status] || item.status)}</span>${/^\d{4}$/.test(item.value) ? `<button type="button" data-editor-action="use-year" data-year="${esc(item.value)}">この年を指定</button>` : ""}</li>`).join("") : "<li>曲ごとの候補は保持します。一括編集で共通年を推測することはありません。</li>";
    dialog.querySelector("#indexEditorBody").innerHTML = `
      ${draft.error ? `<p class="index-editor-error" role="alert" tabindex="-1">${esc(draft.error)}</p>` : ""}
      ${draft.notice ? `<p class="index-editor-notice" role="status">${esc(draft.notice)}</p>` : ""}
      <section class="index-editor-section index-editor-find-first"><div class="index-editor-section-head"><h3>タグを探す</h3><span>追加・削除</span></div><label class="index-editor-find"><span class="vh">タグを探す</span><input type="search" data-editor-field="filter" value="${esc(draft.filter)}" placeholder="ジャンルまたはタグを検索" autocomplete="off"></label><ul class="index-editor-suggestions" id="indexEditorSuggestions">${suggestionsMarkup(state)}</ul></section>
      <details class="index-editor-year-drawer"${draft.yearOpen ? " open" : ""}><summary>制作年を変更 <span>現在: ${yearSummary}</span></summary><div class="index-editor-year"><label><span>変更</span><select data-editor-field="year-mode"><option value="unchanged">変更しない</option><option value="auto">自動メタデータを使う</option><option value="set">年を指定する</option><option value="unset">未設定にする</option></select></label><label class="index-editor-year-value${draft.year.mode === "set" ? "" : " is-hidden"}"><span>年</span><input data-editor-field="year-value" inputmode="numeric" pattern="[0-9]{4}" min="1000" max="9999" value="${esc(draft.year.value)}" aria-label="指定する年"></label></div></details>
      <section class="index-editor-section"><div class="index-editor-section-head"><h3>${targets.length===1?"この曲":"選んだ曲"}のタグ</h3><span>${tags.length}件</span></div><ul class="index-editor-tags">${current}</ul>${currentTags.length > draft.currentLimit ? `<button type="button" class="index-editor-show-more" data-editor-action="show-more">さらに ${Math.min(20, currentTags.length - draft.currentLimit)} 件を見る</button>` : ""}<details class="index-editor-organize"><summary>一覧から選んで外す</summary><div class="index-editor-selected-action"><label>選択したタグ <select data-editor-field="selected-tag">${currentTags.map((tag) => { const key = tagKey(tag.kind, tag.value); return `<option value="${esc(key)}"${key === draft.selectedKey ? " selected" : ""}>${esc(kindName[tag.kind])}: ${esc(tag.value)}（${originName(tag.origin)}）</option>`; }).join("")}</select></label><button type="button" data-editor-action="remove-selected" ${draft.selectedKey ? "" : "disabled"}>選択したタグを${removalName(selectedTag?.origin)}</button></div></details></section>
      ${pending ? `<section class="index-editor-section index-editor-draft"><div class="index-editor-section-head"><h3>保存予定の変更</h3><span>すべて保存、または何も保存しません</span></div><ul>${pending}</ul></section>` : ""}
      <details class="index-editor-metadata"><summary>制作年の候補と保存先</summary><p>変更はライブラリに保存します。音声ファイルの埋め込み情報は読み取り専用です。</p><p>リビジョン  liner-${draft.expectedRevision}。保存前に、開いた時点の内容ハッシュと軽量フィンガープリントを確認します。</p><ul>${candidates}</ul></details>
      <details class="index-editor-simulation"><summary>試作のシミュレーション</summary><p>このダイアログの固定対象だけで、再読み込みが必要な状態を確認できます。ファイルは変更しません。</p><div><button type="button" data-editor-action="scan">ライブラリスキャンを再現</button><button type="button" data-editor-action="conflict">リビジョン競合を再現</button><button type="button" data-editor-action="identity">識別変更を再現</button><button type="button" data-editor-action="persist">保存失敗を再現</button><button type="button" data-editor-action="reload">タグを再読み込み</button></div></details>`;
    const mode = dialog.querySelector('[data-editor-field="year-mode"]');
    mode.value = draft.year.mode;
    dialog.querySelector(".index-editor-year-drawer").addEventListener("toggle", (event) => { draft.yearOpen = event.currentTarget.open; });
    const actions = dialog.querySelector(".index-editor-actions");
    if (draft.confirmDiscard) actions.innerHTML = '<span class="index-editor-pending">未保存の変更があります</span><span class="index-editor-actions-grow"></span><button type="button" class="index-editor-cancel" data-editor-action="continue">編集を続ける</button><button type="button" class="index-editor-discard" data-editor-action="discard">変更を破棄</button>';
    else if (draft.recovery) actions.insertAdjacentHTML("beforeend", '<button type="button" class="index-editor-reload" data-editor-action="reload">タグを再読み込み</button>');
  }

  function validateTargets(state) {
    for (const song of state.targets) {
      const expected = state.draft.expected.get(song);
      const current = identity.get(song);
      if (!expected || !current || current.hash !== expected.hash || current.fingerprint !== expected.fingerprint) return "identity_changed";
    }
    return state.draft.expectedRevision === revision ? null : "stale_revision";
  }

  function applyPatch(state) {
    const failure = validateTargets(state);
    if (failure) return failure;
    if (state.draft.year.mode === "set" && !/^[1-9]\d{3}$/.test(state.draft.year.value)) return "invalid_input";
    if (state.draft.failNext) { state.draft.failNext = false; return "persist_failed"; }
    const groups = byHash(state.targets);
    const before = groups.map((song) => clone(recordFor(song)));
    groups.forEach((song) => {
      const record = recordFor(song);
      if (state.draft.year.mode !== "unchanged") record.manualYear = state.draft.year.mode === "set" ? { mode: "set", value: Number(state.draft.year.value) } : { mode: state.draft.year.mode, value: null };
      state.draft.add.forEach((key) => { record.suppressions = record.suppressions.filter((value) => value !== key); if (!record.additions.includes(key)) record.additions.push(key); });
      state.draft.remove.forEach((key) => {
        record.additions = record.additions.filter((value) => value !== key);
        const [kind, ...value] = key.split(":");
        const embedded = (kind === "genre" ? identity.get(song).source.genres : identity.get(song).source.custom).includes(value.join(":"));
        if (embedded && !record.suppressions.includes(key)) record.suppressions.push(key);
        if (!embedded) record.suppressions = record.suppressions.filter((value) => value !== key);
      });
    });
    if (before.every((record, index) => JSON.stringify(record) === JSON.stringify(recordFor(groups[index])))) return "no_op";
    const affected = FK.songs.filter((song) => groups.some((target) => identity.get(target).hash === identity.get(song).hash));
    affected.forEach(refreshSong);
    syncTagIndex();
    revision++;
    return "saved";
  }

  function conflictMessage(code) {
    if (code === "stale_revision") return "この編集画面を開いている間にタグが変わりました。下書きは残したまま、タグを再読み込みして確認してください。";
    if (code === "identity_changed") return "曲の識別情報が変わりました。この下書きを別のファイルへ適用することはありません。";
    if (code === "persist_failed") return "保存できませんでした。どの曲のタグも変更されていません。下書きを確認してもう一度保存できます。";
    return "年は1000以降の4桁で入力してください。";
  }

  function simulateScan(state) {
    // Re-evaluate automatic metadata without changing a manual record. This is a real
    // revision change, so a subsequent save must recover like a scan/load race.
    state.targets.forEach((song) => {
      const meta = identity.get(song);
      if (meta.source.automaticYear) meta.source.candidates = [{ source: "埋め込み録音日", value: String(meta.source.automaticYear), status: "valid" }];
      refreshSong(song);
    });
    revision++;
    syncTagIndex();
    state.draft.notice = "スキャンで新しいタグの状態が確定した想定です。保存前に再読み込みしてください。";
  }

  function simulateConflict(state) {
    revision++;
    state.draft.notice = "別の編集画面で新しい状態が保存された想定です。保存には再読み込みが必要です。";
  }

  function simulateIdentityChange(state) {
    state.targets.forEach((song) => { identity.get(song).fingerprint += "|changed"; });
    state.draft.notice = "対象ファイルが置き換わった想定です。再読み込みも保存も、この下書きを適用しません。";
  }

  function simulatePersistFailure(state) {
    state.draft.failNext = true;
    state.draft.notice = "次の保存だけを失敗させます。失敗後も下書きと表示は残ります。";
  }

  function reload(state) {
    const failure = state.targets.some((song) => {
      const expected = state.draft.expected.get(song);
      const current = identity.get(song);
      return !expected || !current || expected.hash !== current.hash || expected.fingerprint !== current.fingerprint;
    });
    if (failure) { state.draft.error = conflictMessage("identity_changed"); return; }
    state.draft.expectedRevision = revision;
    state.draft.notice = "現在のタグ状態を再読み込みしました。下書きは変更していません。";
    state.draft.error = "";
    state.draft.recovery = "";
  }

  function close(saved, reason) {
    if (!dialog || !dialog.open) return;
    const result = closeResult;
    dialog.close();
    dialog.remove();
    dialog = undefined;
    closeResult = undefined;
    const focus = returnFocus;
    returnFocus = undefined;
    if (focus && document.contains(focus)) focus.focus();
    const detail = { saved, reason, revision: `liner-${revision}` };
    window.dispatchEvent(new CustomEvent("index-editor:close", { detail }));
    if (typeof result === "function") result(detail);
  }

  function open(songObjects, onClose) {
    const requested = Array.isArray(songObjects) ? songObjects : [songObjects];
    const targets = requested.filter((song, index) => requested.indexOf(song) === index);
    // A batch is one transaction. Never silently drop an unresolved row and
    // turn the user's intended target set into a smaller edit.
    if (!targets.length || targets.some((song) => !FK.songs.includes(song) || !identity.get(song)?.resolved)) {
      if (typeof onClose === "function") onClose({ saved: false, reason: "identity_unavailable", revision: `liner-${revision}` });
      return false;
    }
    if (dialog?.open) return false;
    dialogMarkup();
    const state = { targets, draft: initialDraft(targets) };
    dialog._attemptCancel = () => {
      if (!changesCount(state.draft)) { close(false, "cancelled"); return; }
      state.draft.confirmDiscard = true;
      state.draft.notice = "未保存の変更があります。破棄するか、編集を続けてください。";
      render(state);
    };
    dialog.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
    closeResult = onClose;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.addEventListener("input", (event) => {
      const field = event.target.dataset.editorField;
      if (field === "filter") { state.draft.filter = event.target.value; renderSuggestions(state); }
      if (field === "year-value") state.draft.year.value = event.target.value.trim();
    });
    dialog.addEventListener("change", (event) => {
      if (event.target.dataset.editorField === "year-mode") { state.draft.year.mode = event.target.value; state.draft.yearOpen = true; render(state); (state.draft.year.mode === "set" ? dialog.querySelector('[data-editor-field="year-value"]') : dialog.querySelector('[data-editor-field="year-mode"]'))?.focus(); }
      if (event.target.dataset.editorField === "selected-tag") state.draft.selectedKey = event.target.value;
    });
    dialog.addEventListener("click", (event) => {
      const button = event.target.closest("[data-editor-action]");
      if (!button || dialog.dataset.busy === "true") return;
      const { editorAction: action, key, kind } = button.dataset;
      if (action === "cancel") return dialog._attemptCancel();
      if (action === "continue") { state.draft.confirmDiscard = false; state.draft.notice = ""; render(state); return; }
      if (action === "discard") return close(false, "discarded");
      if (action === "add" && !state.draft.add.includes(key)) { state.draft.remove = state.draft.remove.filter((value) => value !== key); state.draft.add.push(key); }
      if (action === "remove" && !state.draft.remove.includes(key)) { state.draft.add = state.draft.add.filter((value) => value !== key); state.draft.remove.push(key); }
      if (action === "remove-selected" && state.draft.selectedKey && !state.draft.remove.includes(state.draft.selectedKey)) { state.draft.add = state.draft.add.filter((value) => value !== state.draft.selectedKey); state.draft.remove.push(state.draft.selectedKey); }
      if (action === "show-more") state.draft.currentLimit += 20;
      if (action === "undo") state.draft[kind] = state.draft[kind].filter((value) => value !== key);
      if (action === "use-year") { state.draft.year={mode:"set",value:button.dataset.year}; state.draft.yearOpen=true; }
      if (action === "scan") simulateScan(state);
      if (action === "conflict") simulateConflict(state);
      if (action === "identity") simulateIdentityChange(state);
      if (action === "persist") simulatePersistFailure(state);
      if (action === "reload") reload(state);
      if (action === "save") {
        const outcome = applyPatch(state);
        if (outcome !== "saved" && outcome !== "no_op") { state.draft.error = conflictMessage(outcome); state.draft.recovery = outcome === "stale_revision" || outcome === "identity_changed" ? outcome : ""; render(state); const alert = dialog.querySelector(".index-editor-error"); alert?.focus({ preventScroll: true }); alert?.scrollIntoView({ block: "center" }); return; }
        close(outcome === "saved", outcome);
        return;
      }
      render(state);
    });
    render(state);
    dialog.showModal();
    dialog.querySelector('[data-editor-field="filter"]')?.focus();
    return true;
  }

  installFixtureOverlay();
  window.indexEditor = Object.freeze({ open, info: tagInfo });
})();
