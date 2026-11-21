// Interactive state machine & DOM renderer for Funkot Player Ideal Library UI (Issue #169)
(function () {
  "use strict";

  const DATA = window.FUNKOT_MOCK_DATA;

  // Clone mutable deep structures for interactive prototype
  const state = {
    view: "library", // library | queue | playlists
    searchText: "",
    matchMode: "AND", // AND | OR
    conditions: [], // Array<{ key, kind, category, value }>
    lastRemovedCondition: null,
    overflowDrawerOpen: false,
    facetStudioOpen: false,
    facetCandidateQuery: "",
    facetActiveCategory: "all",
    quickNew: false,
    quickFav: false,
    sortBy: "relevance",
    selectMode: false,
    selectedTrackIds: new Set(),
    expandedTrackIds: new Set(),
    activeDestId: "pl-anison-2015",
    destinations: JSON.parse(JSON.stringify(DATA.destinations)),
    tracks: JSON.parse(JSON.stringify(DATA.tracks)),
    justAddedTrackId: null,
    lastAddedUndo: null, // { destId, uid, trackTitle, destName }
    isPaused: false,
    isPending: false,
    errorBanner: null, // { title, text }
    inspectorTrackId: null,
    inspectorDraft: null,
    inspectorError: null,
    inputKind: window.matchMedia && window.matchMedia("(pointer: coarse)").matches ? "coarse" : "fine",
    zoom: "100",
    preset: "default"
  };

  // DOM refs
  const els = {
    body: document.body,
    html: document.documentElement,
    navLibrary: document.getElementById("navLibrary"),
    navQueue: document.getElementById("navQueue"),
    navPlaylists: document.getElementById("navPlaylists"),
    navQueueCount: document.getElementById("navQueueCount"),
    btnNarrowTools: document.getElementById("btnNarrowTools"),
    headerToolsGroup: document.getElementById("headerToolsGroup"),
    presetSelect: document.getElementById("presetSelect"),
    btnToggleSelectMode: document.getElementById("btnToggleSelectMode"),
    btnInputKindToggle: document.getElementById("btnInputKindToggle"),
    searchInput: document.getElementById("searchInput"),
    btnClearTextSearch: document.getElementById("btnClearTextSearch"),
    btnToggleFacetStudio: document.getElementById("btnToggleFacetStudio"),
    btnModeAnd: document.getElementById("btnModeAnd"),
    btnModeOr: document.getElementById("btnModeOr"),
    conditionStrip: document.getElementById("conditionStrip"),
    conditionPillsRail: document.getElementById("conditionPillsRail"),
    btnOverflowConditions: document.getElementById("btnOverflowConditions"),
    btnRestoreCondition: document.getElementById("btnRestoreCondition"),
    btnClearAllConditions: document.getElementById("btnClearAllConditions"),
    overflowConditionsDrawer: document.getElementById("overflowConditionsDrawer"),
    overflowDrawerTitle: document.getElementById("overflowDrawerTitle"),
    btnCloseOverflowDrawer: document.getElementById("btnCloseOverflowDrawer"),
    overflowPillsGrid: document.getElementById("overflowPillsGrid"),
    facetStudio: document.getElementById("facetStudio"),
    facetCandidateInput: document.getElementById("facetCandidateInput"),
    facetMatchSummary: document.getElementById("facetMatchSummary"),
    btnCloseFacetStudio: document.getElementById("btnCloseFacetStudio"),
    variantHintBar: document.getElementById("variantHintBar"),
    facetColumns: document.getElementById("facetColumns"),
    resultsCount: document.getElementById("resultsCount"),
    resultsScope: document.getElementById("resultsScope"),
    pendingIndicator: document.getElementById("pendingIndicator"),
    btnQuickNew: document.getElementById("btnQuickNew"),
    btnQuickFav: document.getElementById("btnQuickFav"),
    sortSelect: document.getElementById("sortSelect"),
    errorBanner: document.getElementById("errorBanner"),
    errorBannerTitle: document.getElementById("errorBannerTitle"),
    errorBannerText: document.getElementById("errorBannerText"),
    btnReopenDraft: document.getElementById("btnReopenDraft"),
    btnDismissError: document.getElementById("btnDismissError"),
    trackLedger: document.getElementById("trackLedger"),
    emptyDiagnostic: document.getElementById("emptyDiagnostic"),
    emptyReasonText: document.getElementById("emptyReasonText"),
    emptyRecoveryActions: document.getElementById("emptyRecoveryActions"),
    selectionBar: document.getElementById("selectionBar"),
    selectionSummary: document.getElementById("selectionSummary"),
    btnBulkAdd: document.getElementById("btnBulkAdd"),
    btnBulkEditTags: document.getElementById("btnBulkEditTags"),
    btnClearSelection: document.getElementById("btnClearSelection"),
    destinationSelectDesktop: document.getElementById("destinationSelectDesktop"),
    dockDestCount: document.getElementById("dockDestCount"),
    dockItemsScroll: document.getElementById("dockItemsScroll"),
    btnOpenNarrowDestSheet: document.getElementById("btnOpenNarrowDestSheet"),
    narrowDestName: document.getElementById("narrowDestName"),
    playingLed: document.getElementById("playingLed"),
    playingTitle: document.getElementById("playingTitle"),
    playingSource: document.getElementById("playingSource"),
    btnPlayPause: document.getElementById("btnPlayPause"),
    playPauseIcon: document.getElementById("playPauseIcon"),
    btnNextTrack: document.getElementById("btnNextTrack"),
    btnFlagTransition: document.getElementById("btnFlagTransition"),
    studioToast: document.getElementById("studioToast"),
    toastMessage: document.getElementById("toastMessage"),
    btnToastUndo: document.getElementById("btnToastUndo"),
    narrowDestBackdrop: document.getElementById("narrowDestBackdrop"),
    btnCloseNarrowDestSheet: document.getElementById("btnCloseNarrowDestSheet"),
    narrowDestOptions: document.getElementById("narrowDestOptions"),
    narrowSheetPreviewLabel: document.getElementById("narrowSheetPreviewLabel"),
    narrowSheetPreviewList: document.getElementById("narrowSheetPreviewList"),
    inspectorBackdrop: document.getElementById("inspectorBackdrop"),
    inspectorTitle: document.getElementById("inspectorTitle"),
    inspectorSubtitle: document.getElementById("inspectorSubtitle"),
    inspectorIdentityBox: document.getElementById("inspectorIdentityBox"),
    inspectorYearControls: document.getElementById("inspectorYearControls"),
    inspectorTagsWrap: document.getElementById("inspectorTagsWrap"),
    newTagKind: document.getElementById("newTagKind"),
    newTagInput: document.getElementById("newTagInput"),
    btnStageNewTag: document.getElementById("btnStageNewTag"),
    inspectorOverrideControls: document.getElementById("inspectorOverrideControls"),
    inspectorErrorBox: document.getElementById("inspectorErrorBox"),
    inspectorErrorTitle: document.getElementById("inspectorErrorTitle"),
    inspectorErrorDetail: document.getElementById("inspectorErrorDetail"),
    btnReloadSnapshot: document.getElementById("btnReloadSnapshot"),
    btnCloseInspector: document.getElementById("btnCloseInspector"),
    btnInspectorCancel: document.getElementById("btnInspectorCancel"),
    btnSimulateSaveError: document.getElementById("btnSimulateSaveError"),
    btnInspectorSave: document.getElementById("btnInspectorSave")
  };

  let toastTimer = null;

  function showToast(msg, undoPayload) {
    els.toastMessage.textContent = msg;
    state.lastAddedUndo = undoPayload || null;
    els.btnToastUndo.hidden = !undoPayload;
    els.studioToast.hidden = false;
    clearTimeout(toastTimer);
    if (!undoPayload) {
      toastTimer = setTimeout(() => {
        els.studioToast.hidden = true;
      }, 4000);
    }
  }

  function findTagMeta(key) {
    return (
      DATA.tags.find((t) => t.key === key) ||
      DATA.simulatedArchiveTags.find((t) => t.key === key) || {
        key,
        kind: key.split(":")[0],
        category: "creator",
        value: key.split(":").slice(1).join(":"),
        libCount: 1,
        aliases: []
      }
    );
  }

  function trackMatchesTagKey(track, tagKey) {
    if (tagKey === "year:unset") {
      return track.year === null;
    }
    if (tagKey === "status:新着") return track.isNew;
    if (tagKey === "status:お気に入り") return track.isFavorite;
    if (tagKey === "status:重複あり") return Boolean(track.duplicateTitleGroup || track.duplicateHashCount > 1);
    if (tagKey === "status:曲補正あり") return track.hasManualBars || track.manualFunkot !== null;
    if (tagKey === "status:非Funkot判定") return !track.effectiveIsFunkot;
    if (tagKey === "status:タグ10個以上") return track.tags.length >= 10;
    return track.tags.some((t) => t.key === tagKey);
  }

  function filterTracksWith(conditions, mode, searchText, quickNew, quickFav) {
    const q = (searchText || "").trim().toLowerCase();
    return state.tracks.filter((track) => {
      if (quickNew && !track.isNew) return false;
      if (quickFav && !track.isFavorite) return false;
      if (q) {
        const hay = [track.title, track.artist, track.path, track.tags.map((t) => t.value).join(" ")]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (conditions.length === 0) return true;
      if (mode === "AND") {
        return conditions.every((cond) => trackMatchesTagKey(track, cond.key));
      }
      return conditions.some((cond) => trackMatchesTagKey(track, cond.key));
    });
  }

  function getFilteredTracks() {
    let list = filterTracksWith(state.conditions, state.matchMode, state.searchText, state.quickNew, state.quickFav);
    const sortBy = state.sortBy;
    list = list.slice().sort((a, b) => {
      if (sortBy === "title") return a.title.localeCompare(b.title, "ja");
      if (sortBy === "year_desc") return (b.year || 0) - (a.year || 0);
      if (sortBy === "bpm_desc") return b.bpm - a.bpm;
      return 0;
    });
    return list;
  }

  function getActiveDestination() {
    return state.destinations.find((d) => d.id === state.activeDestId) || state.destinations[0];
  }

  function countTrackInDestination(dest, trackId) {
    return dest.items.filter((item) => item.trackId === trackId).length;
  }

  function toggleConditionByKey(key) {
    const idx = state.conditions.findIndex((c) => c.key === key);
    if (idx >= 0) {
      state.lastRemovedCondition = state.conditions[idx];
      state.conditions.splice(idx, 1);
    } else {
      const meta = findTagMeta(key);
      state.conditions.push({
        key: meta.key,
        kind: meta.kind,
        category: meta.category,
        value: meta.value
      });
    }
    render();
  }

  function addTrackToDestination(trackId) {
    const track = state.tracks.find((t) => t.id === trackId);
    const dest = getActiveDestination();
    if (!track || !dest) return;
    if (!track.effectiveIsFunkot) {
      showToast(`「${track.title}」は非Funkot判定のため追加できません（⋯ から手動許可できます）`);
      return;
    }
    if (dest.kind === "favorites" && countTrackInDestination(dest, trackId) > 0) {
      showToast(`「${track.title}」はすでにお気に入りに登録されています`);
      return;
    }
    const uid = "added-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6);
    dest.items.push({ uid, trackId: track.id, note: "追加済" });
    if (dest.kind === "favorites") track.isFavorite = true;
    state.justAddedTrackId = track.id;
    showToast(`「${dest.name}」へ「${track.title}」を追加しました`, {
      destId: dest.id,
      uid,
      trackTitle: track.title,
      destName: dest.name
    });
    render();
  }

  function removeConditionAt(index) {
    const [removed] = state.conditions.splice(index, 1);
    state.lastRemovedCondition = removed;
    render();
  }

  function createConditionPillEl(cond, onRemove) {
    const pill = document.createElement("span");
    pill.className = "condition-pill";
    const kindLabelMap = { year: "年", custom: "枠", genre: "種別", status: "状態" };
    const kSpan = document.createElement("span");
    kSpan.className = "condition-pill-kind";
    kSpan.textContent = kindLabelMap[cond.kind] || cond.kind;

    const vSpan = document.createElement("span");
    vSpan.className = "condition-pill-val";
    vSpan.textContent = cond.value;
    vSpan.title = cond.value;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "condition-pill-remove";
    rm.textContent = "×";
    rm.setAttribute("aria-label", `条件「${cond.value}」を解除`);
    rm.addEventListener("click", onRemove);

    pill.append(kSpan, vSpan, rm);
    return pill;
  }

  function renderConditionStrip() {
    const hasConds = state.conditions.length > 0;
    const canRestore = Boolean(state.lastRemovedCondition);
    els.conditionStrip.hidden = !hasConds && !canRestore;
    els.conditionPillsRail.innerHTML = "";

    // Bounded display: at most 3 pills inline on the strip so toolbar NEVER explodes vertically
    const maxInline = 3;
    const visibleConds = state.conditions.slice(0, maxInline);
    visibleConds.forEach((cond, idx) => {
      els.conditionPillsRail.appendChild(createConditionPillEl(cond, () => removeConditionAt(idx)));
    });

    const hiddenCount = state.conditions.length - visibleConds.length;
    if (hiddenCount > 0) {
      els.btnOverflowConditions.hidden = false;
      els.btnOverflowConditions.textContent = `+他 ${hiddenCount} 条件 (${state.conditions.length}件中)`;
    } else {
      els.btnOverflowConditions.hidden = true;
      state.overflowDrawerOpen = false;
    }

    els.btnRestoreCondition.hidden = !canRestore;
    els.btnClearAllConditions.hidden = !hasConds;

    els.overflowConditionsDrawer.hidden = !state.overflowDrawerOpen || state.conditions.length === 0;
    if (!els.overflowConditionsDrawer.hidden) {
      els.overflowDrawerTitle.textContent = `適用中の全 ${state.conditions.length} 条件（${state.matchMode === "AND" ? "すべて一致" : "いずれか一致"}）`;
      els.overflowPillsGrid.innerHTML = "";
      state.conditions.forEach((cond, idx) => {
        els.overflowPillsGrid.appendChild(createConditionPillEl(cond, () => removeConditionAt(idx)));
      });
    }
  }

  function renderFacetStudio() {
    els.facetStudio.hidden = !state.facetStudioOpen;
    els.btnToggleFacetStudio.setAttribute("aria-expanded", String(state.facetStudioOpen));
    if (!state.facetStudioOpen) return;

    const q = state.facetCandidateQuery.trim().toLowerCase();
    const allTags = DATA.tags.concat(q ? DATA.simulatedArchiveTags : []);

    // Variant / synonym guidance
    const variantHints = [];
    if (q.includes("anime") || q.includes("anisong") || q.includes("アニメ")) {
      variantHints.push({ label: "アニソンremix (原曲・文化)", key: "genre:アニソンremix" });
    }
    if (q.includes("japan") || q.includes("jp") || q.includes("日本")) {
      variantHints.push({ label: "日本人トラックメーカー (制作圏)", key: "custom:日本人トラックメーカー" });
    }
    if (q.includes("2015")) {
      variantHints.push({ label: "2015年 (制作年)", key: "year:2015" });
    }
    if (variantHints.length > 0) {
      els.variantHintBar.hidden = false;
      els.variantHintBar.innerHTML = `<span>表記揺れ・最短候補:</span>`;
      variantHints.forEach((vh) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "variant-pick-btn";
        b.textContent = vh.label;
        b.addEventListener("click", () => toggleConditionByKey(vh.key));
        els.variantHintBar.appendChild(b);
      });
    } else {
      els.variantHintBar.hidden = true;
    }

    // Category tabs active highlight
    document.querySelectorAll(".cat-tab").forEach((btn) => {
      const active = btn.dataset.cat === state.facetActiveCategory;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    const catsToShow =
      state.facetActiveCategory === "all"
        ? DATA.facetCategories
        : DATA.facetCategories.filter((c) => c.id === state.facetActiveCategory);

    els.facetColumns.innerHTML = "";
    let totalMatchedTags = 0;

    catsToShow.forEach((cat) => {
      let tagsInCat = allTags.filter((t) => t.category === cat.id);
      if (q) {
        tagsInCat = tagsInCat.filter(
          (t) =>
            t.value.toLowerCase().includes(q) ||
            t.key.toLowerCase().includes(q) ||
            (t.aliases || []).some((al) => al.toLowerCase().includes(q))
        );
      }
      totalMatchedTags += tagsInCat.length;
      if (q && tagsInCat.length === 0) return;

      const group = document.createElement("div");
      group.className = "facet-group";
      const h3 = document.createElement("h3");
      h3.className = "facet-group-title";
      h3.textContent = cat.label;
      const p = document.createElement("p");
      p.className = "facet-group-hint";
      p.textContent = cat.hint;

      const list = document.createElement("div");
      list.className = "facet-options-list";

      const visibleLimit = q ? 12 : 6;
      tagsInCat.slice(0, visibleLimit).forEach((tag) => {
        const selected = state.conditions.some((c) => c.key === tag.key);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "facet-option-btn" + (selected ? " is-selected" : "");
        btn.dataset.tagKey = tag.key;
        btn.setAttribute("aria-pressed", String(selected));

        const lbl = document.createElement("span");
        lbl.className = "facet-option-label";
        lbl.textContent = tag.value;
        lbl.title = tag.value;

        // Calculate preview hit count if added to current AND query
        const previewConds = selected ? state.conditions : state.conditions.concat([tag]);
        const previewSampleHits = filterTracksWith(
          previewConds,
          state.matchMode,
          state.searchText,
          state.quickNew,
          state.quickFav
        ).length;

        const cnt = document.createElement("span");
        cnt.className = "facet-option-counts";
        cnt.textContent = selected ? `選択中 · ${previewSampleHits}曲` : `${tag.libCount.toLocaleString()} / +で${previewSampleHits}曲`;

        btn.append(lbl, cnt);
        btn.addEventListener("click", () => toggleConditionByKey(tag.key));
        list.appendChild(btn);
      });

      group.append(h3, p, list);
      els.facetColumns.appendChild(group);
    });

    els.facetMatchSummary.textContent = q
      ? `3,420候補から該当 ${totalMatchedTags} 種を表示`
      : `3,420タグを5分類で表示`;
  }

  function renderTracks() {
    const dest = getActiveDestination();
    const matched = getFilteredTracks();

    if (state.view === "queue") {
      const qDest = state.destinations.find((d) => d.id === "queue");
      els.resultsCount.textContent = `${qDest.items.length} 曲`;
      els.resultsScope.textContent = "現在の再生待ち（自動選曲を含む）";
      renderTrackList(
        qDest.items.map((it) => state.tracks.find((t) => t.id === it.trackId)).filter(Boolean),
        dest
      );
      return;
    }

    if (state.view === "playlists") {
      els.resultsCount.textContent = `${dest.items.length} 曲`;
      els.resultsScope.textContent = `表示中のリスト: ${dest.name}`;
      renderTrackList(
        dest.items.map((it) => state.tracks.find((t) => t.id === it.trackId)).filter(Boolean),
        dest
      );
      return;
    }

    // Standard Library view
    els.resultsCount.textContent = `${matched.length} 曲`;
    if (state.conditions.length === 0 && !state.searchText && !state.quickNew && !state.quickFav) {
      els.resultsScope.textContent = `全 ${DATA.scaleStats.totalTracks.toLocaleString()} 曲の代表サンプルを表示`;
    } else {
      els.resultsScope.textContent = `${state.conditions.length} 条件（${state.matchMode}）で絞り込み中`;
    }

    renderTrackList(matched, dest);
  }

  function renderTrackList(tracks, dest) {
    els.trackLedger.innerHTML = "";
    if (tracks.length === 0) {
      els.emptyDiagnostic.hidden = false;
      const yearConds = state.conditions.filter((c) => c.kind === "year");
      if (state.matchMode === "AND" && yearConds.length >= 2) {
        els.emptyReasonText.textContent =
          `「${yearConds.map((c) => c.value).join("」と「")}」を AND（すべて一致）で指定しています。1曲につき制作年は1つのため、両方を同時に満たす曲はありません。`;
      } else if (state.conditions.length > 0) {
        const lastCond = state.conditions[state.conditions.length - 1];
        els.emptyReasonText.textContent =
          `最後の条件「${lastCond.value}」またはテキスト検索「${state.searchText || "なし"}」により一致曲が 0 件になりました。`;
      } else {
        els.emptyReasonText.textContent = "現在のテキスト検索とクイック絞り込みに一致する曲がありません。";
      }

      els.emptyRecoveryActions.innerHTML = "";
      if (state.matchMode === "AND" && state.conditions.length >= 2) {
        const btnOr = document.createElement("button");
        btnOr.type = "button";
        btnOr.className = "diag-btn is-primary";
        btnOr.textContent = "OR（いずれか一致）へ切替";
        btnOr.addEventListener("click", () => {
          state.matchMode = "OR";
          render();
        });
        els.emptyRecoveryActions.appendChild(btnOr);
      }
      if (state.conditions.length > 0) {
        const lastCond = state.conditions[state.conditions.length - 1];
        const btnDropLast = document.createElement("button");
        btnDropLast.type = "button";
        btnDropLast.className = "diag-btn";
        btnDropLast.textContent = `直前の条件「${lastCond.value}」を外す`;
        btnDropLast.addEventListener("click", () => removeConditionAt(state.conditions.length - 1));
        els.emptyRecoveryActions.appendChild(btnDropLast);
      }
      const btnReset = document.createElement("button");
      btnReset.type = "button";
      btnReset.className = "diag-btn";
      btnReset.textContent = "すべての条件をリセット";
      btnReset.addEventListener("click", () => {
        state.conditions = [];
        state.searchText = "";
        els.searchInput.value = "";
        state.quickNew = false;
        state.quickFav = false;
        render();
      });
      els.emptyRecoveryActions.appendChild(btnReset);
      return;
    }

    els.emptyDiagnostic.hidden = true;
    const activeKeys = new Set(state.conditions.map((c) => c.key));

    tracks.forEach((track) => {
      const addedCount = countTrackInDestination(dest, track.id);
      const isSelected = state.selectedTrackIds.has(track.id);
      const isExpanded = state.expandedTrackIds.has(track.id);

      const row = document.createElement("article");
      row.className = "track-row";
      row.setAttribute("role", "listitem");
      row.dataset.trackId = track.id;
      if (track.isNowPlaying) row.classList.add("is-playing");
      if (isSelected) row.classList.add("is-selected");
      if (!track.effectiveIsFunkot) row.classList.add("is-blocked");
      if (isExpanded) row.classList.add("is-expanded");

      // Multi-select checkbox
      const selSlot = document.createElement("div");
      selSlot.className = "row-select-slot";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "row-checkbox";
      cb.checked = isSelected;
      cb.setAttribute("aria-label", `「${track.title}」を選択`);
      cb.addEventListener("change", () => {
        if (cb.checked) state.selectedTrackIds.add(track.id);
        else state.selectedTrackIds.delete(track.id);
        renderSelectionBar();
        row.classList.toggle("is-selected", cb.checked);
      });
      selSlot.appendChild(cb);

      // Center Main Column (Title Hero + Meta + Compact Tags)
      const main = document.createElement("div");
      main.className = "row-main";

      const titleLine = document.createElement("div");
      titleLine.className = "track-title-line";
      const titleEl = document.createElement("h3");
      titleEl.className = "track-title";
      titleEl.textContent = track.title;
      titleLine.appendChild(titleEl);

      if (track.isNowPlaying) {
        const badge = document.createElement("span");
        badge.className = "track-status-inline is-playing";
        badge.textContent = "再生中";
        titleLine.appendChild(badge);
      }
      if (addedCount > 0) {
        const badge = document.createElement("span");
        badge.className = "track-status-inline is-added";
        badge.textContent = addedCount > 1 ? `追加済 ×${addedCount}` : "追加済";
        titleLine.appendChild(badge);
      }
      if (!track.effectiveIsFunkot) {
        const badge = document.createElement("span");
        badge.className = "track-status-inline is-blocked";
        badge.textContent = "非Funkot判定";
        titleLine.appendChild(badge);
      }

      // Meta line: Artist + Year/BPM/Duration + Disambiguation badges
      const metaLine = document.createElement("div");
      metaLine.className = "track-meta-line";

      const artistEl = document.createElement("span");
      artistEl.className = "track-artist" + (!track.artist ? " is-missing" : "");
      artistEl.textContent = track.artist || "アーティスト未設定（ファイル名表示）";
      metaLine.appendChild(artistEl);

      const numEl = document.createElement("span");
      numEl.className = "track-numeric";
      const yrLabel =
        track.yearStatus === "conflict"
          ? "年競合"
          : track.year
          ? String(track.year)
          : "年未設定";
      numEl.textContent = `${yrLabel} · ${track.bpm} BPM · ${track.duration}`;
      metaLine.appendChild(numEl);

      if (track.disambiguationNote) {
        const db = document.createElement("span");
        db.className = "disambiguation-badge";
        db.textContent = track.disambiguationNote;
        metaLine.appendChild(db);
      }
      if (track.duplicateHashCount > 1) {
        const db = document.createElement("span");
        db.className = "disambiguation-badge";
        db.textContent = `同一音源 ${track.duplicateHashCount}ファイル共有`;
        metaLine.appendChild(db);
      }
      if (track.isNew) {
        const db = document.createElement("span");
        db.className = "disambiguation-badge";
        db.textContent = "新着";
        metaLine.appendChild(db);
      }

      // Tags line: Prioritize active matched tags + up to 3 representative tags, plus +N expand button
      const tagsLine = document.createElement("div");
      tagsLine.className = "track-tags-line";
      const sortedTags = track.tags.slice().sort((a, b) => {
        const am = activeKeys.has(a.key) ? 0 : 1;
        const bm = activeKeys.has(b.key) ? 0 : 1;
        return am - bm;
      });
      const shownTags = isExpanded ? sortedTags : sortedTags.slice(0, 4);
      shownTags.forEach((tg) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "row-tag-chip" + (activeKeys.has(tg.key) ? " is-matched" : "");
        chip.textContent = tg.value;
        chip.title = `${tg.value}（タップで絞り込みに追加/解除）`;
        chip.addEventListener("click", () => toggleConditionByKey(tg.key));
        tagsLine.appendChild(chip);
      });

      if (sortedTags.length > 4) {
        const expBtn = document.createElement("button");
        expBtn.type = "button";
        expBtn.className = "row-tags-expand-btn";
        expBtn.textContent = isExpanded ? "折りたたむ" : `+${sortedTags.length - 4}タグ`;
        expBtn.addEventListener("click", () => {
          if (state.expandedTrackIds.has(track.id)) state.expandedTrackIds.delete(track.id);
          else state.expandedTrackIds.add(track.id);
          renderTracks();
        });
        tagsLine.appendChild(expBtn);
      }

      main.append(titleLine, metaLine, tagsLine);

      // Expanded inline details (paths, bars, quick editor trigger)
      if (isExpanded) {
        const drawer = document.createElement("div");
        drawer.className = "row-inline-drawer";
        const pathEl = document.createElement("div");
        pathEl.className = "inline-drawer-path";
        pathEl.textContent = `ファイル: ${track.allPaths.join(" | ")} · hash: ${track.contentHash} · 導入 ${track.introBars}小節 / 終端 ${track.outroBars}小節`;
        const actions = document.createElement("div");
        actions.className = "inline-drawer-actions";
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "diag-btn";
        editBtn.textContent = "タグ・曲補正を編集";
        editBtn.addEventListener("click", () => openInspector(track.id));
        const favBtn = document.createElement("button");
        favBtn.type = "button";
        favBtn.className = "diag-btn";
        favBtn.textContent = track.isFavorite ? "お気に入りから外す" : "お気に入りに登録";
        favBtn.addEventListener("click", () => {
          track.isFavorite = !track.isFavorite;
          render();
        });
        actions.append(editBtn, favBtn);
        drawer.append(pathEl, actions);
        main.appendChild(drawer);
      }

      // Right Actions Slot (Tactile 44x44 target, quiet appearance)
      const actSlot = document.createElement("div");
      actSlot.className = "row-actions-slot";

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "row-add-btn";
      if (!track.effectiveIsFunkot) {
        addBtn.classList.add("is-blocked");
        addBtn.textContent = "⊘";
        addBtn.setAttribute("aria-label", `「${track.title}」は非Funkot判定のため追加不可`);
        addBtn.title = "非Funkot判定（⋯ から手動でFunkotに補正可）";
      } else if (addedCount > 0) {
        addBtn.classList.add("is-added");
        addBtn.textContent = `✓`;
        addBtn.setAttribute("aria-label", `「${track.title}」を「${dest.name}」にもう1回追加`);
        addBtn.title = `${dest.name} に追加済（もう一度押すと追加）`;
      } else {
        addBtn.textContent = "+";
        addBtn.setAttribute("aria-label", `「${track.title}」を「${dest.name}」に追加`);
        addBtn.title = `${dest.name} に追加`;
      }
      addBtn.addEventListener("click", () => addTrackToDestination(track.id));

      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "row-more-btn";
      moreBtn.textContent = "⋯";
      moreBtn.setAttribute("aria-label", `「${track.title}」の詳細とタグ編集`);
      moreBtn.title = "詳細・タグ編集・曲補正";
      moreBtn.addEventListener("click", () => openInspector(track.id));

      actSlot.append(addBtn, moreBtn);
      row.append(selSlot, main, actSlot);
      els.trackLedger.appendChild(row);
    });
  }

  function renderDestinationDock() {
    const dest = getActiveDestination();
    els.destinationSelectDesktop.value = dest.id;
    els.dockDestCount.textContent = `${dest.items.length} 曲登録済`;
    els.narrowDestName.textContent = `${dest.name} (${dest.items.length}曲)`;

    const qDest = state.destinations.find((d) => d.id === "queue");
    els.navQueueCount.textContent = String(qDest ? qDest.items.length : 0);

    els.dockItemsScroll.innerHTML = "";
    dest.items.forEach((item, index) => {
      const track = state.tracks.find((t) => t.id === item.trackId);
      if (!track) return;
      const el = document.createElement("div");
      el.className = "dock-item" + (track.id === state.justAddedTrackId ? " is-just-added" : "");
      el.setAttribute("role", "listitem");

      const main = document.createElement("div");
      main.className = "dock-item-main";
      const t = document.createElement("div");
      t.className = "dock-item-title";
      t.textContent = track.title;
      const s = document.createElement("div");
      s.className = "dock-item-sub";
      s.textContent = `${String(index + 1).padStart(2, "0")} · ${track.artist || "アーティスト未設定"}`;
      main.append(t, s);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "dock-item-remove";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `「${track.title}」を「${dest.name}」から除外`);
      rm.addEventListener("click", () => {
        dest.items.splice(index, 1);
        render();
      });

      el.append(main, rm);
      els.dockItemsScroll.appendChild(el);
    });

    // Update narrow sheet if open
    if (!els.narrowDestBackdrop.hidden) {
      renderNarrowDestSheet();
    }
  }

  function renderNarrowDestSheet() {
    const active = getActiveDestination();
    els.narrowDestOptions.innerHTML = "";
    state.destinations.forEach((d) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet-dest-option" + (d.id === active.id ? " is-active" : "");
      btn.dataset.destId = d.id;
      btn.innerHTML = `<span><strong>${d.name}</strong><br><small style="color:var(--ink-muted)">${d.subtitle}</small></span><span style="font-family:var(--font-mono);font-size:0.8rem">${d.items.length}曲</span>`;
      btn.addEventListener("click", () => {
        state.activeDestId = d.id;
        render();
      });
      els.narrowDestOptions.appendChild(btn);
    });

    els.narrowSheetPreviewLabel.textContent = `「${active.name}」の登録曲 (${active.items.length}曲)`;
    els.narrowSheetPreviewList.innerHTML = "";
    active.items.forEach((item, index) => {
      const track = state.tracks.find((t) => t.id === item.trackId);
      if (!track) return;
      const row = document.createElement("div");
      row.className = "dock-item";
      row.innerHTML = `<div class="dock-item-main"><div class="dock-item-title">${track.title}</div><div class="dock-item-sub">${index + 1} · ${track.artist || "アーティスト未設定"}</div></div>`;
      els.narrowSheetPreviewList.appendChild(row);
    });
  }

  function renderSelectionBar() {
    const count = state.selectedTrackIds.size;
    els.selectionBar.hidden = count === 0;
    if (count > 0) {
      const dest = getActiveDestination();
      els.selectionSummary.textContent = `${count} 曲を選択中（追加先: ${dest.name}）`;
    }
  }

  function renderPlaybackStrip() {
    const playing = state.tracks.find((t) => t.isNowPlaying) || state.tracks[1];
    els.playingTitle.textContent = playing.title;
    els.playingSource.textContent = `再生元: 再生待ち · ${playing.artist || "アーティスト未設定"}`;
    els.playingLed.classList.toggle("is-paused", state.isPaused);
    els.playPauseIcon.textContent = state.isPaused ? "▶" : "⏸";
    els.btnPlayPause.querySelector(".transport-label").textContent = state.isPaused ? "再開" : "一時停止";
  }

  function openInspector(trackId) {
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) return;
    state.inspectorTrackId = trackId;
    state.inspectorError = null;
    state.inspectorDraft = {
      yearMode: track.yearOrigin === "manual" ? "set" : track.yearStatus === "unset" ? "unset" : "auto",
      manualYear: track.year || 2015,
      addedTags: [],
      removedKeys: [],
      manualFunkot: track.manualFunkot,
      introBars: track.introBars,
      outroBars: track.outroBars
    };
    renderInspector();
    els.inspectorBackdrop.hidden = false;
  }

  function renderInspector() {
    const track = state.tracks.find((t) => t.id === state.inspectorTrackId);
    const draft = state.inspectorDraft;
    if (!track || !draft) return;

    els.inspectorTitle.textContent = track.title;
    els.inspectorSubtitle.textContent = `${track.artist || "アーティスト未設定"} · ${track.bpm} BPM · ${track.duration}`;

    els.inspectorIdentityBox.innerHTML = "";
    const lines = [
      `パス: ${track.allPaths.join(" / ")}`,
      `content_hash: ${track.contentHash}${track.duplicateHashCount > 1 ? ` (${track.duplicateHashCount}ファイルで同一レコード共有)` : ""}`,
      `自動メタデータ候補: ${track.rawCandidates.length ? track.rawCandidates.map((c) => `${c.key}=${c.value}`).join(", ") : "なし"} · 年状態: ${track.yearStatus}`
    ];
    lines.forEach((txt) => {
      const div = document.createElement("div");
      div.textContent = txt;
      els.inspectorIdentityBox.appendChild(div);
    });

    // Year mode controls
    els.inspectorYearControls.innerHTML = "";
    [
      { id: "auto", label: "自動（埋め込み優先）" },
      { id: "set", label: "制作年を手動固定 (2015)" },
      { id: "unset", label: "未設定に固定" }
    ].forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "diag-btn" + (draft.yearMode === opt.id ? " is-primary" : "");
      b.textContent = opt.label;
      b.addEventListener("click", () => {
        draft.yearMode = opt.id;
        renderInspector();
      });
      els.inspectorYearControls.appendChild(b);
    });

    // Tags with patch diff visualization
    els.inspectorTagsWrap.innerHTML = "";
    track.tags
      .filter((t) => t.kind !== "year")
      .forEach((tg) => {
        const isRemoved = draft.removedKeys.includes(tg.key);
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "draft-tag-pill" + (isRemoved ? " is-removed" : "");
        pill.textContent = `${tg.value} (${tg.origin}) ${isRemoved ? "戻す" : "×"}`;
        pill.addEventListener("click", () => {
          if (isRemoved) draft.removedKeys = draft.removedKeys.filter((k) => k !== tg.key);
          else draft.removedKeys.push(tg.key);
          renderInspector();
        });
        els.inspectorTagsWrap.appendChild(pill);
      });

    draft.addedTags.forEach((tg, idx) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "draft-tag-pill is-added";
      pill.textContent = `+ ${tg.value} ×`;
      pill.addEventListener("click", () => {
        draft.addedTags.splice(idx, 1);
        renderInspector();
      });
      els.inspectorTagsWrap.appendChild(pill);
    });

    // Bar & Funkot Override controls
    els.inspectorOverrideControls.innerHTML = "";
    [
      { val: null, label: `自動判定 (${track.autoIsFunkot ? "Funkot" : "非Funkot"})` },
      { val: true, label: "手動でFunkotとして許可" },
      { val: false, label: "手動で非Funkotとして除外" }
    ].forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "diag-btn" + (draft.manualFunkot === opt.val ? " is-jade" : "");
      b.textContent = opt.label;
      b.addEventListener("click", () => {
        draft.manualFunkot = opt.val;
        renderInspector();
      });
      els.inspectorOverrideControls.appendChild(b);
    });

    const barStat = document.createElement("span");
    barStat.className = "track-numeric";
    barStat.textContent = `イントロ ${draft.introBars}小節 / アウトロ ${draft.outroBars}小節`;
    els.inspectorOverrideControls.appendChild(barStat);

    // Error state inside modal
    if (state.inspectorError) {
      els.inspectorErrorBox.hidden = false;
      els.inspectorErrorTitle.textContent = state.inspectorError.title;
      els.inspectorErrorDetail.textContent = state.inspectorError.detail;
    } else {
      els.inspectorErrorBox.hidden = true;
    }
  }

  function render() {
    els.body.dataset.inputKind = state.inputKind;
    els.body.dataset.zoom = state.zoom;
    els.html.dataset.zoom = state.zoom;
    els.body.classList.toggle("is-select-mode", state.selectMode);

    els.btnInputKindToggle.textContent = state.inputKind === "coarse" ? "指操作(44px)" : "細操作";
    els.btnToggleSelectMode.setAttribute("aria-pressed", String(state.selectMode));

    // Nav tabs
    [
      [els.navLibrary, "library"],
      [els.navQueue, "queue"],
      [els.navPlaylists, "playlists"]
    ].forEach(([el, v]) => {
      el.classList.toggle("is-active", state.view === v);
    });

    // Logic mode buttons
    els.btnModeAnd.classList.toggle("is-active", state.matchMode === "AND");
    els.btnModeAnd.setAttribute("aria-pressed", String(state.matchMode === "AND"));
    els.btnModeOr.classList.toggle("is-active", state.matchMode === "OR");
    els.btnModeOr.setAttribute("aria-pressed", String(state.matchMode === "OR"));

    els.btnClearTextSearch.hidden = !state.searchText;
    els.btnQuickNew.setAttribute("aria-pressed", String(state.quickNew));
    els.btnQuickFav.setAttribute("aria-pressed", String(state.quickFav));
    els.pendingIndicator.hidden = !state.isPending;

    if (state.errorBanner) {
      els.errorBanner.hidden = false;
      els.errorBannerTitle.textContent = state.errorBanner.title;
      els.errorBannerText.textContent = state.errorBanner.text;
    } else {
      els.errorBanner.hidden = true;
    }

    renderConditionStrip();
    renderFacetStudio();
    renderTracks();
    renderDestinationDock();
    renderSelectionBar();
    renderPlaybackStrip();
  }

  // Preset applicator for reproducible multi-state captures & testing
  function applyPreset(name) {
    state.preset = name || "default";
    els.presetSelect.value = state.preset;
    state.view = "library";
    state.searchText = "";
    els.searchInput.value = "";
    state.matchMode = "AND";
    state.conditions = [];
    state.lastRemovedCondition = null;
    state.overflowDrawerOpen = false;
    state.facetStudioOpen = false;
    state.facetCandidateQuery = "";
    els.facetCandidateInput.value = "";
    state.facetActiveCategory = "all";
    state.quickNew = false;
    state.quickFav = false;
    state.selectMode = false;
    state.selectedTrackIds.clear();
    state.expandedTrackIds.clear();
    state.isPending = false;
    state.errorBanner = null;
    state.zoom = "100";
    els.inspectorBackdrop.hidden = true;
    els.narrowDestBackdrop.hidden = true;
    els.studioToast.hidden = true;

    if (name === "facet-open") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "custom:日本人トラックメーカー", kind: "custom", category: "creator", value: "日本人トラックメーカー" }
      ];
      state.facetStudioOpen = true;
      state.facetCandidateQuery = "アニソン";
      els.facetCandidateInput.value = "アニソン";
    } else if (name === "and-3tags") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "custom:日本人トラックメーカー", kind: "custom", category: "creator", value: "日本人トラックメーカー" },
        { key: "genre:アニソンremix", kind: "genre", category: "culture", value: "アニソンremix" }
      ];
    } else if (name === "add-inspect") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "custom:日本人トラックメーカー", kind: "custom", category: "creator", value: "日本人トラックメーカー" },
        { key: "genre:アニソンremix", kind: "genre", category: "culture", value: "アニソンremix" }
      ];
      state.expandedTrackIds.add("t01");
      const dest = getActiveDestination();
      if (!dest.items.some((i) => i.trackId === "t01")) {
        dest.items.push({ uid: "preset-add-t01", trackId: "t01", note: "追加済" });
      }
      state.justAddedTrackId = "t01";
      showToast("「アニソンFunkot 2015特選」へ「Haruka Kanata...」を追加しました", {
        destId: dest.id,
        uid: "preset-add-t01",
        trackTitle: "Haruka Kanata...",
        destName: dest.name
      });
    } else if (name === "scale-9tags") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "custom:日本人トラックメーカー", kind: "custom", category: "creator", value: "日本人トラックメーカー" },
        { key: "genre:アニソンremix", kind: "genre", category: "culture", value: "アニソンremix" },
        { key: "custom:M3・同人頒布", kind: "custom", category: "creator", value: "M3・同人頒布" },
        { key: "custom:関西Funkot勢", kind: "custom", category: "creator", value: "関西Funkot勢" },
        { key: "genre:王道Dugem", kind: "genre", category: "style", value: "王道Dugem" },
        { key: "genre:高速 190BPM+", kind: "genre", category: "style", value: "高速 190BPM+" },
        { key: "genre:深夜ピーク向け", kind: "genre", category: "style", value: "深夜ピーク向け" },
        {
          key: "custom:2015年M3秋頒布・関西圏同人サークル限定スペシャルブートレグアーカイブ",
          kind: "custom",
          category: "creator",
          value: "2015年M3秋頒布・関西圏同人サークル限定スペシャルブートレグアーカイブ"
        }
      ];
      state.overflowDrawerOpen = false;
    } else if (name === "zero-conflict") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "year:2018", kind: "year", category: "year", value: "2018年" }
      ];
      state.isPending = true;
      state.errorBanner = {
        title: "タグ変更の保存が競合しました (stale_revision)",
        text: "再スキャン中に保存を実行したため中断しました。入力中の下書き（+1タグ）は失われていません。"
      };
    } else if (name === "zoom-200") {
      state.conditions = [
        { key: "year:2015", kind: "year", category: "year", value: "2015年" },
        { key: "custom:日本人トラックメーカー", kind: "custom", category: "creator", value: "日本人トラックメーカー" },
        { key: "genre:アニソンremix", kind: "genre", category: "culture", value: "アニソンremix" }
      ];
      state.zoom = "200";
    }
    render();
  }

  // Event bindings
  els.navLibrary.addEventListener("click", () => {
    state.view = "library";
    render();
  });
  els.navQueue.addEventListener("click", () => {
    state.view = "queue";
    render();
  });
  els.navPlaylists.addEventListener("click", () => {
    state.view = "playlists";
    render();
  });

  els.presetSelect.addEventListener("change", (e) => applyPreset(e.target.value));

  els.btnNarrowTools.addEventListener("click", () => {
    const open = !els.headerToolsGroup.classList.contains("is-open");
    els.headerToolsGroup.classList.toggle("is-open", open);
    els.btnNarrowTools.setAttribute("aria-expanded", String(open));
  });

  els.btnToggleSelectMode.addEventListener("click", () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selectedTrackIds.clear();
    render();
  });

  els.btnInputKindToggle.addEventListener("click", () => {
    state.inputKind = state.inputKind === "coarse" ? "fine" : "coarse";
    render();
  });

  els.searchInput.addEventListener("input", (e) => {
    state.searchText = e.target.value;
    render();
  });
  els.btnClearTextSearch.addEventListener("click", () => {
    state.searchText = "";
    els.searchInput.value = "";
    render();
  });

  els.btnToggleFacetStudio.addEventListener("click", () => {
    state.facetStudioOpen = !state.facetStudioOpen;
    render();
    if (state.facetStudioOpen) els.facetCandidateInput.focus();
  });
  els.btnCloseFacetStudio.addEventListener("click", () => {
    state.facetStudioOpen = false;
    render();
  });

  els.facetCandidateInput.addEventListener("input", (e) => {
    state.facetCandidateQuery = e.target.value;
    renderFacetStudio();
  });

  document.querySelectorAll(".cat-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.facetActiveCategory = btn.dataset.cat;
      renderFacetStudio();
    });
  });

  els.btnModeAnd.addEventListener("click", () => {
    state.matchMode = "AND";
    render();
  });
  els.btnModeOr.addEventListener("click", () => {
    state.matchMode = "OR";
    render();
  });

  els.btnOverflowConditions.addEventListener("click", () => {
    state.overflowDrawerOpen = !state.overflowDrawerOpen;
    renderConditionStrip();
  });
  els.btnCloseOverflowDrawer.addEventListener("click", () => {
    state.overflowDrawerOpen = false;
    renderConditionStrip();
  });

  els.btnRestoreCondition.addEventListener("click", () => {
    if (state.lastRemovedCondition) {
      state.conditions.push(state.lastRemovedCondition);
      state.lastRemovedCondition = null;
      render();
    }
  });

  els.btnClearAllConditions.addEventListener("click", () => {
    state.lastRemovedCondition = state.conditions[state.conditions.length - 1] || null;
    state.conditions = [];
    render();
  });

  els.btnQuickNew.addEventListener("click", () => {
    state.quickNew = !state.quickNew;
    render();
  });
  els.btnQuickFav.addEventListener("click", () => {
    state.quickFav = !state.quickFav;
    render();
  });
  els.sortSelect.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    render();
  });

  els.destinationSelectDesktop.addEventListener("change", (e) => {
    state.activeDestId = e.target.value;
    render();
  });

  els.btnOpenNarrowDestSheet.addEventListener("click", () => {
    els.narrowDestBackdrop.hidden = false;
    renderNarrowDestSheet();
  });
  els.btnCloseNarrowDestSheet.addEventListener("click", () => {
    els.narrowDestBackdrop.hidden = true;
  });

  els.btnBulkAdd.addEventListener("click", () => {
    const dest = getActiveDestination();
    let count = 0;
    state.selectedTrackIds.forEach((id) => {
      const tr = state.tracks.find((t) => t.id === id);
      if (tr && tr.effectiveIsFunkot) {
        dest.items.push({ uid: "bulk-" + id + "-" + Date.now(), trackId: id, note: "一括追加" });
        count++;
      }
    });
    state.selectedTrackIds.clear();
    state.selectMode = false;
    showToast(`「${dest.name}」へ ${count} 曲をまとめて追加しました`);
    render();
  });

  els.btnBulkEditTags.addEventListener("click", () => {
    const firstId = Array.from(state.selectedTrackIds)[0];
    if (firstId) openInspector(firstId);
  });

  els.btnClearSelection.addEventListener("click", () => {
    state.selectedTrackIds.clear();
    render();
  });

  els.btnToastUndo.addEventListener("click", () => {
    if (!state.lastAddedUndo) return;
    const dest = state.destinations.find((d) => d.id === state.lastAddedUndo.destId);
    if (dest) {
      dest.items = dest.items.filter((i) => i.uid !== state.lastAddedUndo.uid);
    }
    state.lastAddedUndo = null;
    els.studioToast.hidden = true;
    render();
  });

  els.btnPlayPause.addEventListener("click", () => {
    state.isPaused = !state.isPaused;
    renderPlaybackStrip();
  });
  els.btnNextTrack.addEventListener("click", () => {
    const currIdx = state.tracks.findIndex((t) => t.isNowPlaying);
    if (currIdx >= 0) state.tracks[currIdx].isNowPlaying = false;
    const nextIdx = (currIdx + 1) % state.tracks.length;
    state.tracks[nextIdx].isNowPlaying = true;
    render();
  });
  els.btnFlagTransition.addEventListener("click", () => {
    showToast("現在のつなぎをフラグ記録しました（意見の送信ZIPに含まれます）");
  });

  els.btnReopenDraft.addEventListener("click", () => {
    state.errorBanner = null;
    openInspector("t01");
    state.inspectorError = {
      title: "stale_revision: ライブラリが更新されました",
      detail: "下書きは保持されています。「最新状態を再読込」後に再度保存できます。"
    };
    renderInspector();
    render();
  });

  els.btnDismissError.addEventListener("click", () => {
    state.errorBanner = null;
    state.isPending = false;
    render();
  });

  // Inspector events
  function closeInspector() {
    els.inspectorBackdrop.hidden = true;
    state.inspectorTrackId = null;
    state.inspectorDraft = null;
    state.inspectorError = null;
  }
  els.btnCloseInspector.addEventListener("click", closeInspector);
  els.btnInspectorCancel.addEventListener("click", closeInspector);

  els.btnStageNewTag.addEventListener("click", () => {
    const val = els.newTagInput.value.trim();
    if (!val || !state.inspectorDraft) return;
    const kind = els.newTagKind.value;
    state.inspectorDraft.addedTags.push({
      key: `${kind}:${val}`,
      kind,
      value: val,
      origin: "manual"
    });
    els.newTagInput.value = "";
    renderInspector();
  });

  els.btnSimulateSaveError.addEventListener("click", () => {
    state.inspectorError = {
      title: "保存失敗 (stale_revision)",
      detail: "保存直前にバックグラウンドスキャンが完了しました。編集中の下書きは破棄されていません。"
    };
    renderInspector();
  });

  els.btnReloadSnapshot.addEventListener("click", () => {
    state.inspectorError = null;
    showToast("最新のライブラリ版数を再読込しました（下書きを保持）");
    renderInspector();
  });

  els.btnInspectorSave.addEventListener("click", () => {
    const track = state.tracks.find((t) => t.id === state.inspectorTrackId);
    const draft = state.inspectorDraft;
    if (!track || !draft) return;

    track.tags = track.tags.filter((t) => !draft.removedKeys.includes(t.key));
    draft.addedTags.forEach((tg) => {
      if (!track.tags.some((e) => e.key === tg.key)) track.tags.push(tg);
    });
    if (draft.yearMode === "unset") {
      track.year = null;
      track.yearStatus = "unset";
    } else if (draft.yearMode === "set") {
      track.year = draft.manualYear;
      track.yearStatus = "resolved";
      track.yearOrigin = "manual";
    }
    track.manualFunkot = draft.manualFunkot;
    track.effectiveIsFunkot = draft.manualFunkot !== null ? draft.manualFunkot : track.autoIsFunkot;

    closeInspector();
    showToast(`「${track.title}」のタグ・補正を保存しました`);
    render();
  });

  // Expose URL preset & keyboard shortcut support
  const params = new URLSearchParams(window.location.search);
  const initialPreset = params.get("preset") || "default";
  applyPreset(initialPreset);
})();
