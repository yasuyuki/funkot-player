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
  emptyHintDesktop:
    "Musicフォルダを開いて音声ファイルを入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。",
  emptyHintAndroid:
    "音声ファイルをMusicフォルダへ入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。フォルダの場所は ⋮ メニューの「ログを表示」に出ます。",

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
  clearLabelsItem: "ラベルと再生履歴を消す",
  confirmClearLabels: "ラベルと再生履歴を全部消しますか？",
  clearedLabels: "ラベルと再生履歴を消しました",
  clearLabelsFailed: "ラベルと再生履歴を消せませんでした",
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
