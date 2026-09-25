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
  labelMenuLabel: "Label trek",
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
  playlistNormal: "Antrean",
  playlistLoading: "Memuat daftar putar…",
  playlistTrackCount: (count) => `${count} lagu`,
  playlistDestination: (name) => `Tambahkan ke: ${name}`,
  playlistAddLabel: (title, destination) => `Tambahkan ${title} ke ${destination}`,
  playlistAddResult: (summary, destination) => `Ke ${destination}: ${summary}`,
  playlistChoose: "Pilih yang diputar berikutnya",
  playlistSearch: "Cari daftar putar",
  playlistNewName: "Nama daftar putar baru",
  playlistCreateUse: "Buat dan gunakan",
  playlistCount: (remaining, total) => `${remaining} tersisa / ${total} total`,
  playlistMenu: "Aksi daftar putar",
  playlistEditAll: "Tampilkan dan edit semua lagu",
  playlistShowRemaining: "Tampilkan lagu tersisa",
  playlistRestart: "Mulai dari awal (lagu saat ini tetap diputar)",
  playlistEnded: "Pemutaran selesai",
  playlistEmpty: "Daftar putar ini kosong",
  playlistRemoveLabel: (title) => `Hapus ${title} dari daftar putar ini`,
  playlistRemoved: "Dihapus dari daftar putar",
  playlistError: (code) => ({ stale: "Daftar berubah. Muat ulang sebelum mengedit.", invalid_input: "Periksa nama daftar putar.", not_found: "Daftar putar tidak ditemukan.", active_list: "Pilih sumber lain sebelum menghapus daftar putar ini.", store_read_only: "Daftar putar hanya dapat dibaca.", persist_failed: "Daftar putar tidak dapat disimpan.", busy: "Pengeditan daftar putar sedang sibuk.", transition_in_progress: "Tunggu perubahan lagu selesai, lalu coba lagi.", transition_paused: "Pergantian lagu terhenti saat dijeda. Lanjutkan pemutaran, lalu coba lagi setelah pergantian selesai.", active_upgrade_pending: "Tunggu lagu saat ini selesai disiapkan, lalu coba lagi.", navigation_pending: "Tunggu pergantian lagu berikutnya, lalu coba lagi.", no_runway: "Terlalu dekat dengan pergantian lagu untuk mengubah daftar. Coba lagi setelah lagu berikutnya mulai.", auditioning: "Daftar putar tidak dapat diubah selama pratinjau.", identity_unavailable: "Lagu ini tidak dapat diidentifikasi untuk daftar putar.", identity_changed: "Lagu berubah di penyimpanan. Muat ulang pustaka dan coba lagi.", duplicate_undo: "Penghapusan ini sudah dibatalkan." })[code] ?? "Tidak dapat memperbarui daftar putar",
  playlistBrowse: "Telusuri semua lagu",
  playlistBrowseLabel: (name) => `Telusuri ${name}`,
  playlistRename: "Ganti nama",
  playlistDuplicate: "Duplikat",
  playlistDelete: "Hapus",
  playlistSaveQueue: "Simpan antrean sebagai daftar putar",
  playlistSaveQueueScope: "Menyalin lagu berikutnya yang ditampilkan, termasuk lagu yang siap dan pilihan otomatis. Lagu saat ini tidak disertakan; antrean dan sumber pemutaran tetap.",
  playlistSave: "Simpan",
  playlistConfirmName: (name) => `Ketik “${name}” untuk menghapus daftar putar ini`,
  playlistReadOnly: "Daftar putar hanya dapat dibaca karena data tersimpan tidak dapat dimuat. Antrean tetap dapat diputar.",
  playlistSaveFailedRetry: "Perubahan daftar putar terakhir tidak dapat disimpan. Periksa penyimpanan dan coba lagi.",
  playlistSkipped: (count) => `${count} dilewati`,
  playlistStatus: (status) => ({ pending: "Berikutnya", preparing: "Menyiapkan", prepared: "Siap", missing: "Tidak ditemukan", unplayable: "Tidak dapat diputar", played: "Sudah diputar", current: "Memutar" })[status] ?? status,
  playlistFailureReason: (reason) => ({ missing: "File tidak ditemukan.", non_funkot: "Dikecualikan oleh pengaturan khusus Funkot.", identity_changed: "File berubah sejak ditambahkan.", identity_unavailable: "Lagu ini tidak dapat diidentifikasi.", load_failed: "Lagu tidak dapat dimuat.", loader_failure: "Lagu tidak dapat dimuat." })[reason] ?? "Lagu tidak dapat dimuat.",
  playlistCreateSavedSelectionFailed: (name, reason) => `“${name}” dibuat, tetapi tidak dapat dialihkan: ${reason}`,

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
  tagEditorTitle: (title) => `Sunting tag: ${title}`,
  tagEditorScope: (count) =>
    count === 1 ? "Lagu ini" : `${count} lagu terpilih yang terlihat`,
  tagEdit: "Sunting tag",
  tagEditSelected: "Sunting tag",
  tagEditCount: (count) => `Sunting pilihan terlihat (${count})`,
  tagEnqueueCount: (count) => `Tambahkan ke antrean (${count})`,
  tagIdentityUnavailable:
    "Identitas konten yang sudah terselesaikan diperlukan untuk menyunting tag.",
  tagYear: "Tahun produksi",
  tagNoChange: "Jangan ubah",
  tagYearAuto: "Gunakan tahun otomatis",
  tagYearUnset: "Biarkan tahun kosong",
  tagYearSet: "Atur tahun",
  tagKind: "Jenis",
  tagGenre: "Genre",
  tagCustom: "Kustom",
  tagValue: "Tag",
  tagAdd: "Tambah tag",
  tagSave: "Simpan",
  tagSaving: "Menyimpan…",
  tagReload: "Muat ulang tag",
  tagError: (code) =>
    ({
      stale_revision:
        "Tag berubah di tempat lain. Muat ulang dan periksa target yang sama.",
      store_read_only: "Penyimpanan tag hanya-baca.",
      busy: "Penyuntingan tag sedang sibuk.",
      identity_changed: "Lagu yang dipilih telah berubah.",
      identity_unavailable: "Lagu ini belum siap disunting.",
      persist_failed: "Tidak dapat menyimpan tag.",
      invalid_input: "Periksa nilai tag.",
    })[code] ?? "Tidak dapat menyimpan tag.",
  tagSaved: (count) =>
    count === 1 ? "Tag disimpan" : `Tag disimpan untuk ${count} lagu`,
  tagNoop: "Tidak ada perubahan tag",
  tagFileUntouched:
    "Tag mengelompokkan lagu di pemutar ini. Berkas audio tidak diubah.",
  tagSharedIdentity: (count) => `Salinan audio yang sama berbagi tag; ${count} lagu berbeda akan diperbarui.`,
  tagSnapshotChanged: "Tag berubah",
  tagReloading: "Memuat ulang tag…",
  tagReloaded: "Tag dimuat ulang",
  tagEffectiveYear: "Tahun efektif",
  tagMixed: "Campuran",
  tagUnset: "Kosong",
  tagEmpty: "Tidak ada",
  tagManualMode: (mode) =>
    `Manual: ${{ auto: "otomatis", set: "diatur", unset: "kosong tetap" }[mode] ?? "otomatis"}`,
  tagOrigin: (origin) =>
    `Sumber: ${{ embedded: "metadata tertanam", manual: "manual", both: "keduanya" }[origin] ?? "tidak diketahui"}`,
  tagMetadataStatus: (status) =>
    ({
      pending: "Metadata menunggu",
      ready: "Metadata siap",
      error: "Metadata bermasalah",
    })[status] ?? "Metadata tidak tersedia",
  tagYearStatus: (status) =>
    ({
      resolved: "Tahun ditentukan",
      missing: "Tahun tidak ada",
      invalid: "Tahun tidak valid",
      future: "Tahun masa depan",
      conflict: "Tahun bertentangan",
    })[status] ?? "Tahun tidak tersedia",
  tagSemantic: (semantic) =>
    ({
      recording: "Rekaman",
      generic: "Tanggal/tahun",
      release: "Rilis",
      original: "Rilis asli",
    })[semantic] ?? "Lainnya",
  tagYearCandidates: "Kandidat tahun",
  tagAdoptYear: (year) => `Gunakan ${year}`,
  tagCurrentTags: "Tag saat ini",
  tagPresent: (count, total) =>
    count === total
      ? `Umum untuk semua ${total}`
      : `Ada pada ${count} dari ${total} / campuran`,
  tagRemoveScope:
    "Penghapusan berlaku untuk semua lagu terpilih dan menekan tag otomatis yang sama setelah pemindaian.",
  tagSuppressed: "Ditekan",
  tagRestore: "Pulihkan",
  tagPendingAdds: "Tambahan tertunda",
  tagPendingRemovals: "Penghapusan tertunda",
  tagUndo: "Urungkan",
  tagRemove: (value) => `Hapus ${value}`,
  tagLimits: "128 karakter Unicode per nilai; 128 tag genre/kustom efektif.",
  tagDiagnostics: "Detail metadata",
  tagFilterToggle: "Tag",
  tagFilterTitle: "Filter menurut tag",
  tagFilterCandidate: "Kandidat tag",
  tagFilterPick: "Pilih tag",
  tagFilterAdd: "Tambahkan kondisi",
  tagCandidatePopulation: "Kandidat dan jumlah mencakup seluruh pustaka saat ini sebelum difilter.",
  tagCandidateCount: (count) => `${count} lagu`,
  tagFilterMode: "Cocokkan tag yang dipilih",
  tagMatchAll: "AND — semua tag yang dipilih",
  tagMatchAny: "OR — salah satu tag yang dipilih",
  tagFilterUnset: "Tahun produksi kosong",
  tagSelectedFilters: "Kondisi tag yang dipilih",
  tagFilterClear: "Hapus semua kondisi tag",
  tagFilterChoose: (kind, value) => `Filter menurut ${kind}: ${value}`,
  tagFilterRemove: (kind, value) => `Hapus kondisi ${kind}: ${value}`,
  tagMore: (count) => `Lihat ${count} tag lainnya`,
  tagYearsAllHint: "Satu lagu hanya memiliki satu tahun produksi. Pilih OR untuk mencocokkan salah satu tahun.",
  tagFilterLoadFailed: "Tag tidak dapat dimuat. Hasil mungkin sudah lama; pindai ulang untuk mencoba lagi.",
  tagNoMatches: "Tidak ada lagu yang cocok. Ubah teks, lagu baru, atau kondisi tag.",
  emptyHintDesktop:
    "Buka folder Musik, taruh berkas audio di dalamnya, lalu pilih “Pindai ulang” dari menu ⋮ untuk memasukkannya ke pustaka.",
  emptyHintAndroid:
    "Taruh berkas audio di folder Musik, lalu pilih “Pindai ulang” dari menu ⋮ untuk memasukkannya ke pustaka. Menu ⋮ → “Tampilkan log” menunjukkan letak folder itu.",

  // --- Multi-select / bulk add ---
  selectMode: "Pilih",
  selectModeLabel: "Pilih beberapa lagu",
  selectTrackLabel: (title) => `Pilih ${title}`,
  selectAll: "Pilih semua",
  selectNone: "Kosongkan",
  selectedCount: (n) => `${n} dipilih`,
  addSelected: "Tambahkan ke antrean",
  enqueueManyAdded: (n) => `${n} lagu ditambahkan`,
  enqueueManySkipped: (n) => `${n} sudah di antrean`,
  enqueueManyRejected: (n) => `${n} bukan Funkot`,
  enqueueManyNotes: (notes) => ` (${notes})`,
  listSeparator: ", ",

  // --- History ---
  historyHeading: "Riwayat",
  historyByTrack: "Per lagu",
  historyByTime: "Urutan main",
  historyEmpty: "Belum ada yang diputar",
  historyLogEmpty:
    "Belum ada urutan yang tercatat. Urutan pemutaran disimpan mulai sekarang; jumlah putar sebelumnya ada di tab “Per lagu”.",
  playCount: (n) => `${n}x diputar`,
  playedToday: (time) => `Hari ini ${time}`,
  playedYesterday: (time) => `Kemarin ${time}`,
  clearTrackPlayCountItem: "Hapus jumlah putar lagu ini",
  confirmClearTrackPlayCount: (title) =>
    `Hapus jumlah putar untuk “${title}”? Riwayat urutan putar tetap disimpan. Tindakan ini tidak dapat dibatalkan.`,
  confirmRemovePlayLogEntry: (title, time) =>
    `Hapus satu catatan pemutaran “${title}” pada ${time} dari riwayat urutan putar? Jumlah putar lagu tetap disimpan. Tindakan ini tidak dapat dibatalkan.`,
  clearedTrackPlayCount: "Jumlah putar lagu ini dihapus",
  clearTrackPlayCountFailed: "Tidak dapat menghapus jumlah putar",
  removeTrackFromPlayLogItem: "Hapus lagu ini dari urutan main",
  removedTrackFromPlayLog: "Lagu ini dihapus dari urutan main",
  removeTrackFromPlayLogFailed: "Tidak dapat menghapus dari urutan main",

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
  clearLabelsItem: "Hapus label",
  confirmClearLabels: "Hapus semua label?",
  clearedLabels: "Label telah dihapus",
  clearLabelsFailed: "Tidak dapat menghapus label",
  clearPlayLogItem: "Hapus riwayat urutan putar",
  confirmClearPlayLog: "Hapus riwayat urutan putar?",
  clearedPlayLog: "Riwayat urutan putar telah dihapus",
  clearPlayLogFailed: "Tidak dapat menghapus riwayat urutan putar",
  clearPlayCountsItem: "Hapus jumlah putar lagu",
  confirmClearPlayCounts: "Hapus jumlah pemutaran per lagu?",
  clearedPlayCounts: "Jumlah pemutaran lagu telah dihapus",
  clearPlayCountsFailed: "Tidak dapat menghapus jumlah pemutaran per lagu",
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
