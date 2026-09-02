// Indonesian catalogue.
import type { Messages } from "./en";

export const id: Messages = {
  // --- App shell / navigation ---
  playTabsLabel: "Tab pemutaran",
  editTabsLabel: "Tab penyuntingan",
  queueHeading: "Diputar berikutnya",
  libraryHeading: "Pustaka",
  tabFlags: "Transisi yang perlu diperbaiki",
  tabAllTracks: "Semua lagu",

  // --- Transport ---
  start: "Mulai",
  pause: "⏸ Jeda",
  resumePlayback: "▶ Lanjutkan",
  nextTrack: "⏭ Lagu berikutnya",
  playbackControlsLabel: "Kontrol pemutaran",
  resumeLabel: "Lanjutkan",
  pauseLabel: "Jeda",
  nextTrackLabel: "Lagu berikutnya",

  // --- Now playing ---
  phaseIdle: "Siaga",
  phaseStarting: "Menyiapkan",
  phasePlaying: "Memutar",
  phasePaused: "Dijeda",
  phaseStalled: "Menyiapkan lagu berikutnya",
  phaseFailed: "Tidak dapat memutar",
  phaseDisconnected: "Menyambungkan ulang keluaran",

  // --- Audition ---
  auditioning: (from, to) => `Mempratinjau “${from}” → “${to}”`,
  autoplayInterrupted: "Pemutaran otomatis dihentikan",
  resumeAction: "〔Lanjutkan〕",
  auditioningShort: "Pratinjau",

  // --- Labels ---
  funkot: "Funkot",
  notFunkot: "Non-Funkot",
  noLabel: "—",
  labeledFunkot: "Dilabeli Funkot",
  labeledNotFunkot: "Dilabeli non-Funkot",
  bulkLabeled: (n, verdict) => `${n} lagu dilabeli ${verdict ? "Funkot" : "non-Funkot"}`,

  // --- Toast / boundary ---
  undo: "Urungkan",
  retry: "Coba lagi",
  changed: "Diubah",
  deleted: "Dihapus",

  // --- New arrivals ---
  queueNewArrivals: (count) => `Taruh ${count} lagu baru di awal antrean`,

  // --- Log panel ---
  logTitle: "Log",
  close: "Tutup",
  musicFolderLabel: "Folder musik",
  cacheLabel: "Cache",
  arrivalsInspect: (listed, gated, banner) =>
    `Baru: terdaftar ${listed} / setelah gate ${gated} / banner ${banner}`,
  historyRevLine: (rev, applied) => `history rev ${rev} / diterapkan ${applied}`,
  arrivalsPathsLabel: "Path baru",
  showLog: "Tampilkan log",

  // --- Transition strip ---
  lastAutoTransition: "Transisi otomatis terakhir",
  secondsAgo: (s) => `${s} dtk lalu`,
  minutesAgo: (m) => `${m} mnt lalu`,
  noTransitionYet: "Belum ada transisi",
  flagBadTransition: "⚑ Transisi ini tidak pas",
  flagRecorded: (from, to) => `${from} → ${to} dicatat`,
  toEditModeLabel: "Ke mode penyuntingan",
  toPlayModeLabel: "Ke mode pemutaran",
  editMode: "Sunting",
  playMode: "Putar",

  // --- Queue ---
  queueEmpty: "Antrean kosong — pemilihan otomatis tetap jalan",
  queuePreparing: "Menyiapkan",
  queuePrepared: "Siap",
  automaticSelection: "Pilihan otomatis",
  transitionIn: (clock) => `Ganti dalam ${clock}`,
  moveUpLabel: "Naikkan",
  moveDownLabel: "Turunkan",
  removeLabel: "Hapus",
  queueErrTooLate: "Sudah terlambat untuk mengubah yang ini",
  queueErrStale: "Antrean sudah berubah",
  queueErrAuditioning: "Tidak bisa diubah saat pratinjau",
  queueErrOriginBoundary: "Lagu manual dan otomatis tidak dapat dipindahkan melewati batasnya",
  queueErrGeneric: "Tidak dapat memperbarui antrean",

  // --- Library ---
  searchPlaceholder: "Cari",
  searchLabel: "Cari di pustaka",
  newOnly: "Hanya yang baru",
  sortRecent: "Terbaru▾",
  sortTitle: "Judul▾",
  sortArtist: "Artis▾",
  scanningWalking: "Memindai…",
  scanningHashing: (found, done) => `Memindai — memeriksa ${found} lagu, ${done}/${found}`,
  analyzing: (done, total, name) => `Menganalisis ${done}/${total}: ${name}`,
  noTracks: "Tidak ada lagu",
  addToQueueLabel: (title) => `Tambahkan ${title} ke antrean`,
  emptyHintDesktop:
    "Buka folder Musik, taruh berkas audio di dalamnya, lalu pilih “Pindai ulang” dari menu ⋮ untuk memasukkannya ke pustaka.",
  emptyHintAndroid:
    "Taruh berkas audio di folder Musik, lalu pilih “Pindai ulang” dari menu ⋮ untuk memasukkannya ke pustaka. Menu ⋮ → “Tampilkan log” menunjukkan letak folder itu.",

  // --- Music folder ---
  pickMusicFolderPrompt: "Pilih folder Musik",
  pickMusicFolder: "Pilih folder Musik",
  changeMusicFolder: "Ganti folder Musik",
  openMusicFolder: "Buka folder Musik",
  musicDirUnchanged: "Tidak ada yang diubah",
  musicDirChanged: (path) => `Folder Musik diganti: ${path}`,
  musicDirChangedRestart: (path) =>
    `Folder Musik diganti: ${path} (pemilihan otomatis beralih setelah aplikasi dimulai ulang)`,
  musicDirUnavailable: (path) => `Tidak dapat membuka folder musik yang disetel: ${path}`,
  musicDirErrNotAbsolute: "Pilih folder dengan path absolut",
  musicDirErrNotFound: "Folder itu tidak ada",
  musicDirErrNotADirectory: "Pilih folder, bukan berkas",
  musicDirErrNotReadable: "Folder itu tidak dapat dibaca",
  musicDirErrContainsAppData: "Folder yang memuat folder data aplikasi tidak bisa dipakai",
  musicDirErrUnsupportedPlatform: "Perangkat ini tidak dapat menggantinya",
  musicDirErrGeneric: "Tidak dapat mengganti folder Musik",

  // --- Overflow menu ---
  rescan: "Pindai ulang",
  scanFound: (count) => `${count} lagu ditemukan`,
  scanBusy: "Pemindaian sedang berjalan",
  allowNonFunkotItem: (on) => `Putar non-Funkot juga: ${on ? "ON" : "OFF"}`,
  allowNonFunkotToast: (on) =>
    on
      ? "Lagu non-Funkot bisa diantrekan dan dipilih otomatis"
      : "Lagu non-Funkot dikecualikan dari antrean dan pemilihan otomatis",
  labelingModeItem: (on, pending) =>
    `Mode pelabelan: ${on ? "ON" : "OFF"}${pending ? " (mulai pemutaran berikutnya)" : ""}`,
  labelingModeToast: (on, pending) =>
    pending
      ? `Mode pelabelan: ${on ? "ON" : "OFF"} (berlaku mulai pemutaran berikutnya)`
      : on
        ? "Mode pelabelan: ON (hanya memutar 20 detik awal)"
        : "Mode pelabelan: OFF",
  clearLabelsItem: "Hapus label dan riwayat putar",
  confirmClearLabels: "Hapus semua label dan riwayat putar?",
  clearedLabels: "Label dan riwayat putar dihapus",
  clearLabelsFailed: "Tidak dapat menghapus label dan riwayat putar",
  sendFeedback: "Kirim masukan",
  languageItem: (name) => `Bahasa: ${name}`,

  // --- Edit: flagged list ---
  roleOutgoing: "Sisi keluar",
  roleIncoming: "Sisi masuk",
  noFlagged: "Tidak ada transisi yang perlu diperbaiki",
  seeAllTracks: "Lihat semua lagu",
  dismissFlag: "〔Singkirkan〕",
  unanalyzed: "Belum dianalisis",
  missingTrack: "Lagu tidak ada di pustaka",

  // --- Edit: flagged detail ---
  backToList: "← Kembali ke daftar",
  flagCount: (n) => `${n}×`,
  listenTransitionTo: (title) => `Dengarkan transisi masuk ke “${title}”`,
  listenTransitionFrom: (title) => `Dengarkan transisi keluar dari “${title}”`,
  listenAgain: "Dengarkan lagi",
  confirmAction: "〔Konfirmasi〕",
  cancelAction: "〔Batal〕",

  // --- Edit: chip editor ---
  intro: "Intro",
  outro: "Outro",
  chipScale: "pendek ←──────→ panjang",
  outroHint: "Makin panjang, pergantian dimulai makin awal",
  introHint: "Makin panjang, makin banyak intro dilewati dan masuk dengan ancang-ancang pendek",

  // --- Edit: all tracks ---
  rootFolder: "(akar)",
  colLabel: "label",

  // --- Share-sheet import (Android) ---
  importedSummary: (tracks, skipped, failed) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`${skipped} tidak didukung`);
    if (failed > 0) notes.push(`${failed} gagal`);
    const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    return `${tracks} lagu diimpor${suffix}`;
  },
  importProblems: (skipped, failed) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`Tidak dapat mengimpor ${skipped} berkas berformat tidak didukung`);
    if (failed > 0) notes.push(`Gagal mengimpor ${failed} berkas`);
    return notes.join(". ");
  },
};
