// Japanese catalogue. The wording here is exactly what was hard-coded in the
// components before this file existed -- moving the strings out must not
// change what a Japanese-speaking listener sees.
import type { Messages } from "./en";

export const ja: Messages = {
  // --- App shell / navigation ---
  playTabsLabel: "再生サブタブ",
  editTabsLabel: "編集サブタブ",
  queueHeading: "次に再生",
  libraryHeading: "ライブラリ",
  tabFlags: "直すべきつなぎ",
  tabAllTracks: "すべての曲",

  // --- Transport ---
  start: "開始",
  pause: "⏸ 一時停止",
  resumePlayback: "▶ 再開",
  nextTrack: "⏭ 次の曲",
  playbackControlsLabel: "再生コントロール",
  resumeLabel: "再開",
  pauseLabel: "一時停止",
  nextTrackLabel: "次の曲",

  // --- Now playing ---
  phaseIdle: "待機中",
  phaseStarting: "準備中",
  phasePlaying: "再生中",
  phasePaused: "一時停止",
  phaseStalled: "次の曲を準備中",
  phaseFailed: "再生できません",
  phaseDisconnected: "出力先を再接続中",

  // --- Audition ---
  auditioning: (from, to) => `「${from}」→「${to}」を試聴中`,
  autoplayInterrupted: "自動再生を中断しました",
  resumeAction: "〔再開〕",
  auditioningShort: "試聴中",

  // --- Labels ---
  funkot: "Funkot",
  notFunkot: "非Funkot",
  noLabel: "—",
  labeledFunkot: "Funkot に登録",
  labeledNotFunkot: "非Funkot に登録",
  labelMenuLabel: "トラックの分類",
  bulkLabeled: (n, verdict) => `${n}曲を ${verdict ? "Funkot" : "非Funkot"} に登録`,

  // --- Toast / boundary ---
  undo: "取消",
  retry: "再試行",
  changed: "変更しました",
  deleted: "削除しました",

  // --- New arrivals ---
  queueNewArrivals: (count) => `新着 ${count} 曲をキューの先頭に入れる`,

  // --- Log panel ---
  logTitle: "ログ",
  close: "閉じる",
  musicFolderLabel: "音楽フォルダ",
  cacheLabel: "キャッシュ",
  arrivalsInspect: (listed, gated, banner) =>
    `新着: 抽出 ${listed} / gate後 ${gated} / バナー ${banner}`,
  historyRevLine: (rev, applied) => `history rev ${rev} / 適用 ${applied}`,
  arrivalsPathsLabel: "新着path",
  showLog: "ログを表示",

  // --- Transition strip ---
  lastAutoTransition: "直前の自動つなぎ",
  secondsAgo: (s) => `${s}秒前`,
  minutesAgo: (m) => `${m}分前`,
  noTransitionYet: "まだつなぎがありません",
  flagBadTransition: "⚑ このつなぎは不適切",
  flagRecorded: (from, to) => `${from} → ${to} を記録`,
  toEditModeLabel: "編集モードへ",
  toPlayModeLabel: "再生モードへ",
  editMode: "編集",
  playMode: "再生",

  // --- Queue ---
  queueEmpty: "キューは空 — 自動選曲で継続",
  queuePreparing: "準備中",
  queuePrepared: "準備済み",
  automaticSelection: "自動選曲",
  transitionIn: (clock) => `切替まで ${clock}`,
  moveUpLabel: "上へ",
  moveDownLabel: "下へ",
  removeLabel: "削除",
  queueErrTooLate: "もう切り替えに間に合いません",
  queueErrStale: "キューが更新されました",
  queueErrAuditioning: "試聴中は変更できません",
  queueErrOriginBoundary: "手動追加曲と自動選曲の境界を越えて並べ替えできません",
  queueErrGeneric: "キューを更新できませんでした",

  // --- Library ---
  searchPlaceholder: "検索",
  searchLabel: "ライブラリを検索",
  newOnly: "新着のみ",
  sortRecent: "新着順▾",
  sortTitle: "曲名順▾",
  sortArtist: "アーティスト順▾",
  scanningWalking: "スキャン中…",
  scanningHashing: (found, done) => `スキャン中 ${found}曲を確認中 ${done}/${found}`,
  analyzing: (done, total, name) => `解析中 ${done}/${total}: ${name}`,
  noTracks: "曲がありません",
  addToQueueLabel: (title) => `${title} をキューに追加`,
  tagEditorTitle: (title) => `タグを編集: ${title}`,
  tagEditorScope: (count) =>
    count === 1 ? "この曲" : `表示中かつ選択中の${count}曲`,
  tagEdit: "タグを編集",
  tagEditSelected: "タグを編集",
  tagEditCount: (count) => `表示中の選択${count}曲を編集`,
  tagEnqueueCount: (count) => `キューに追加 (${count})`,
  tagIdentityUnavailable: "この曲はまだタグを編集できません。スキャン完了後に確認してください。",
  tagYear: "制作年",
  tagNoChange: "変更しない",
  tagYearAuto: "自動の年を使う",
  tagYearUnset: "年を未設定に固定",
  tagYearSet: "年を指定",
  tagKind: "種類",
  tagGenre: "ジャンル",
  tagCustom: "任意",
  tagValue: "タグ",
  tagAdd: "タグを追加",
  tagSave: "保存",
  tagSaving: "保存中…",
  tagReload: "タグを再読込",
  tagError: (code) =>
    ({
      stale_revision:
        "タグが変更されました。同じ対象を再読込して確認してください。",
      store_read_only: "タグ保存領域は読み取り専用です。",
      busy: "タグ編集は処理中です。",
      identity_changed: "選択した曲が置き換わりました。",
      identity_unavailable: "この曲はまだタグ編集できません。",
      persist_failed: "タグを保存できませんでした。",
      invalid_input: "タグの値を確認してください。",
    })[code] ?? "タグを保存できませんでした。",
  tagSaved: (count) =>
    count === 1 ? "タグを保存しました" : `${count}曲のタグを保存しました`,
  tagNoop: "タグは変更されませんでした",
  tagFileUntouched:
    "タグはプレイヤー内で曲を分類します。音源ファイルは変更しません。",
  tagSharedIdentity: (count) => `同じ音源のコピーをまとめ、${count}曲として保存します。`,
  tagSnapshotChanged: "タグが変更されました",
  tagReloading: "タグを再読込中…",
  tagReloaded: "タグを再読込しました",
  tagEffectiveYear: "現在の制作年",
  tagMixed: "混在",
  tagUnset: "未設定",
  tagEmpty: "なし",
  tagManualMode: (mode) =>
    `年の設定: ${{ auto: "自動", set: "指定", unset: "未設定固定" }[mode] ?? "自動"}`,
  tagOrigin: (origin) =>
    `由来: ${{ embedded: "埋め込みメタデータ", manual: "手動", both: "両方" }[origin] ?? "不明"}`,
  tagMetadataStatus: (status) =>
    ({
      pending: "メタデータ取得中",
      ready: "メタデータ取得済み",
      error: "メタデータエラー",
    })[status] ?? "メタデータ不明",
  tagYearStatus: (status) =>
    ({
      resolved: "年を決定",
      missing: "年なし",
      invalid: "年が不正",
      future: "未来年",
      conflict: "年が競合",
    })[status] ?? "年は不明",
  tagSemantic: (semantic) =>
    ({
      recording: "録音",
      generic: "日付・年",
      release: "発売",
      original: "元の録音・発売",
    })[semantic] ?? "その他",
  tagYearCandidates: "年の候補",
  tagAdoptYear: (year) => `${year}年を使う`,
  tagCurrentTags: "現在のタグ",
  tagPresent: (count, total) =>
    count === total
      ? `${total}曲すべてに共通`
      : `${total}曲中${count}曲 / 混在`,
  tagRemoveScope:
    "削除は選択中の全曲に適用され、再スキャン後の同じ自動タグも抑止します。",
  tagSuppressed: "除外済み",
  tagRestore: "戻す",
  tagPendingAdds: "追加予定",
  tagPendingRemovals: "削除予定",
  tagUndo: "取消",
  tagRemove: (value) => `${value} を削除`,
  tagLimits: "値は128 Unicode文字まで、ジャンルと任意タグの合計は128件までです。",
  tagDiagnostics: "メタデータ詳細",
  tagFilterTitle: "タグで絞り込む",
  tagFilterCandidate: "タグ候補",
  tagFilterPick: "タグを選ぶ",
  tagFilterAdd: "条件に追加",
  tagCandidatePopulation: "候補と件数は、絞り込み前の現在のライブラリ全体が対象です。",
  tagCandidateCount: (count) => `${count}曲`,
  tagFilterMode: "選んだタグの条件",
  tagMatchAll: "AND — すべてのタグに一致",
  tagMatchAny: "OR — いずれかのタグに一致",
  tagFilterUnset: "制作年が未設定",
  tagSelectedFilters: "選択中のタグ条件",
  tagFilterClear: "タグ条件を全解除",
  tagFilterChoose: (kind, value) => `${kind}: ${value} で絞り込む`,
  tagFilterRemove: (kind, value) => `${kind}: ${value} の条件を外す`,
  tagMore: (count) => `残り${count}件のタグを見る`,
  tagYearsAllHint: "1曲に制作年は1つです。どちらかの年に一致させるにはORを選んでください。",
  tagFilterLoadFailed: "タグを読み込めませんでした。表示は古い可能性があります。再スキャンで再試行できます。",
  tagNoMatches: "一致する曲がありません。文字列・新着・タグの条件を変更してください。",
  emptyHintDesktop:
    "Musicフォルダを開いて音声ファイルを入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。",
  emptyHintAndroid:
    "音声ファイルをMusicフォルダへ入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。フォルダの場所は ⋮ メニューの「ログを表示」に出ます。",

  // --- Multi-select / bulk add ---
  selectMode: "選択",
  selectModeLabel: "複数の曲を選ぶ",
  selectTrackLabel: (title) => `${title} を選択`,
  selectAll: "すべて選択",
  selectNone: "選択解除",
  selectedCount: (n) => `${n}曲を選択中`,
  addSelected: "キューに追加",
  enqueueManyAdded: (n) => `${n}曲を追加しました`,
  enqueueManySkipped: (n) => `${n}曲は既にキューにあります`,
  enqueueManyRejected: (n) => `${n}曲は非Funkotです`,
  enqueueManyNotes: (notes) => `（${notes}）`,
  listSeparator: "、",

  // --- History ---
  historyHeading: "履歴",
  historyByTrack: "曲ごと",
  historyByTime: "再生順",
  historyEmpty: "まだ何も再生していません",
  historyLogEmpty:
    "再生順の記録はまだありません。これ以降の再生順が残ります。それ以前の再生回数は「曲ごと」にあります。",
  playCount: (n) => `${n}回`,
  playedToday: (time) => `今日 ${time}`,
  playedYesterday: (time) => `昨日 ${time}`,
  clearTrackPlayCountItem: "この曲の再生回数を消す",
  confirmClearTrackPlayCount: (title) =>
    `「${title}」の再生回数を消しますか？再生順の履歴は残ります。この操作は取り消せません。`,
  confirmRemovePlayLogEntry: (title, time) =>
    `「${title}」の ${time} の再生記録1件を再生順から消しますか？曲の再生回数は残ります。この操作は取り消せません。`,
  clearedTrackPlayCount: "この曲の再生回数を消しました",
  clearTrackPlayCountFailed: "再生回数を消せませんでした",
  removeTrackFromPlayLogItem: "この曲を再生順から消す",
  removedTrackFromPlayLog: "この曲を再生順から消しました",
  removeTrackFromPlayLogFailed: "再生順から消せませんでした",

  // --- Music folder ---
  pickMusicFolderPrompt: "Musicフォルダを選んでください",
  pickMusicFolder: "Musicフォルダを選ぶ",
  changeMusicFolder: "Musicフォルダを変更",
  openMusicFolder: "Musicフォルダを開く",
  musicDirUnchanged: "変更しませんでした",
  musicDirChanged: (path) => `Musicフォルダを変更しました: ${path}`,
  musicDirChangedRestart: (path) =>
    `Musicフォルダを変更しました: ${path}（自動選曲は再起動後に切り替わります）`,
  musicDirUnavailable: (path) => `指定した音楽フォルダを開けません: ${path}`,
  musicDirErrNotAbsolute: "絶対パスのフォルダを選んでください",
  musicDirErrNotFound: "そのフォルダが見つかりません",
  musicDirErrNotADirectory: "フォルダを選んでください",
  musicDirErrNotReadable: "そのフォルダを読み取れません",
  musicDirErrContainsAppData: "アプリのデータフォルダを含むフォルダは選べません",
  musicDirErrUnsupportedPlatform: "この端末では変更できません",
  musicDirErrGeneric: "Musicフォルダを変更できませんでした",

  // --- Overflow menu ---
  rescan: "再スキャン",
  scanFound: (count) => `${count}曲見つかりました`,
  scanBusy: "スキャン中です",
  allowNonFunkotItem: (on) => `非Funkotも再生: ${on ? "ON" : "OFF"}`,
  allowNonFunkotToast: (on) =>
    on ? "非Funkotも追加・自動選曲できます" : "非Funkotは追加・自動選曲から除外します",
  labelingModeItem: (on, pending) =>
    `ラベリングモード: ${on ? "ON" : "OFF"}${pending ? "（次回の再生開始から）" : ""}`,
  labelingModeToast: (on, pending) =>
    pending
      ? `ラベリングモード: ${on ? "ON" : "OFF"}（次回の再生開始から有効）`
      : on
        ? "ラベリングモード: ON（頭20秒だけ再生）"
        : "ラベリングモード: OFF",
  clearLabelsItem: "ラベルを消す",
  confirmClearLabels: "ラベルを全部消しますか？",
  clearedLabels: "ラベルを消しました",
  clearLabelsFailed: "ラベルを消せませんでした",
  clearPlayLogItem: "過去の再生順を消す",
  confirmClearPlayLog: "過去の再生順を消しますか？",
  clearedPlayLog: "過去の再生順を消しました",
  clearPlayLogFailed: "過去の再生順を消せませんでした",
  clearPlayCountsItem: "曲別の再生回数を消す",
  confirmClearPlayCounts: "曲別の再生回数を消しますか？",
  clearedPlayCounts: "曲別の再生回数を消しました",
  clearPlayCountsFailed: "曲別の再生回数を消せませんでした",
  sendFeedback: "意見を送る",
  languageItem: (name) => `言語: ${name}`,

  // --- Edit: flagged list ---
  roleOutgoing: "出る側",
  roleIncoming: "入る側",
  noFlagged: "直すべきつなぎはありません",
  seeAllTracks: "すべての曲を見る",
  dismissFlag: "〔外す〕",
  unanalyzed: "未解析",
  missingTrack: "ライブラリにない曲",

  // --- Edit: flagged detail ---
  backToList: "← 一覧へ",
  flagCount: (n) => `${n}回`,
  listenTransitionTo: (title) => `「${title}」へのつなぎを聴く`,
  listenTransitionFrom: (title) => `「${title}」からのつなぎを聴く`,
  listenAgain: "もう一度聴く",
  confirmAction: "〔確定〕",
  cancelAction: "〔キャンセル〕",

  // --- Edit: chip editor ---
  intro: "イントロ",
  outro: "アウトロ",
  chipScale: "短い ←──────→ 長い",
  outroHint: "長くすると切り替わりが早くなる",
  introHint: "長くするほどイントロを飛ばし、短い前振りで入る",

  // --- Edit: all tracks ---
  rootFolder: "（ルート）",
  colLabel: "ラベル",

  // --- Share-sheet import (Android) ---
  importedSummary: (tracks, skipped, failed) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`非対応${skipped}件`);
    if (failed > 0) notes.push(`失敗${failed}件`);
    const suffix = notes.length > 0 ? `（${notes.join("・")}）` : "";
    return `${tracks}曲を取り込みました${suffix}`;
  },
  importProblems: (skipped, failed) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`対応していない形式のため${skipped}件を取り込めませんでした`);
    if (failed > 0) notes.push(`${failed}件の取り込みに失敗しました`);
    return notes.join("、");
  },
};
