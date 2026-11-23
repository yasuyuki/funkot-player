// Synthetic library for Issue #170 integrated prototype ("Overprint Quiet").
// Reuses the deterministic 24,823-track / 2,600+-tag corpus from Claude Original
// so quantitative comparisons and search counts are 100% comparable, while adding
// lightweight facet classification metadata for structured tag browsing.
(function () {
  let seed = 169;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;

  // ---- tags -------------------------------------------------------------
  const GENRES = [
    "Funkot", "アニソンremix", "電波remix", "ボカロremix", "Happy Hardcore", "Breakbeat",
    "Jungle", "Hard House", "Dangdut Koplo", "Jedag Jedug", "Trance", "Eurobeat",
    "Hardstyle", "Drum & Bass", "Future Bass", "Nu Disco", "Speed Garage", "Hi-NRG",
    "J-Core", "Bubblegum Bass", "Footwork", "Ghetto House", "Big Room", "Moombahton",
    "Breakcore", "UK Hardcore", "Kawaii Future Bass", "Gabber", "Electro House", "Tech House",
    "アニソンRemix", "anison remix", "アニソンリミックス",
  ];
  const ORIGINS = ["日本人", "インドネシア人", "マレーシア人", "韓国人", "台湾人", "フィリピン人", "タイ人", "ブラジル人"];
  const ROLES = ["トラックメーカー", "ボーカル", "MC", "リミキサー"];
  const MOODS = ["多幸感", "疾走感", "泣き", "ネタ曲", "ピアノ", "サイレン", "ベース強め", "ボイスネタ",
    "シンセリード", "サビ早い", "インスト", "コール入り", "ロングイントロ", "ショート", "ドロップ2回", "転調"];
  const EVENT_SEASONS = ["夏", "冬"];
  const WORK_A = ["星屑", "放課後", "電脳", "魔法", "鋼鉄", "南国", "月面", "迷宮", "銀河", "真夜中", "桜色", "疾風", "微熱", "硝子", "虹色", "深海"];
  const WORK_B = ["学園", "少女隊", "交響曲", "探偵団", "行進曲", "ラジオ", "列車", "協奏曲", "物語", "放送局", "商店街", "防衛軍", "喫茶", "図書館", "遊園地", "楽団"];
  const WORK_C = ["", "R", "2", "∞", "Next", "外伝", "Z", "Live"];

  const custom = new Set();
  ORIGINS.forEach((o) => ROLES.forEach((r) => custom.add(o + r)));
  MOODS.forEach((m) => custom.add(m));
  for (let y = 2008; y <= 2026; y++) EVENT_SEASONS.forEach((s) => custom.add(`${y}${s}頒布`));
  WORK_A.forEach((a) => WORK_B.forEach((b) => WORK_C.forEach((c) => custom.add(`原曲:${a}${b}${c}`))));
  ["DJ", "MC", "Producer", "Crew"].forEach((p) => {
    for (let i = 0; i < 120; i++) custom.add(`${p}:${syl(2)}${syl(1)}`);
  });
  custom.add("日本人トラックメーカー");
  custom.add("日本人トラックメーカー（旧名義）");
  custom.add("日本人 trackmaker");
  custom.add("原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ");

  function syl(n) {
    const S = ["ka", "ri", "mo", "su", "na", "to", "ya", "ze", "ru", "ko", "mi", "ta", "ra", "pu", "se", "no", "ha", "ji", "ga", "do"];
    let s = ""; for (let i = 0; i < n; i++) s += pick(S);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---- artists ----------------------------------------------------------
  const ART_PRE = ["DJ ", "", "", "", "MC ", "", "Kid ", ""];
  const JP_ARTISTS = ["夜行性ペンギン", "ねこまたドライブ", "電子レンジ部", "鉄塔ガールズ", "あめふらし工房", "月曜日の象", "ミラーボール商会",
    "そらまめ電機", "灯台守", "三丁目サウンド", "マグカップ団", "ゆうやけ回路", "金魚鉢レコーズ", "白昼夢製作所", "パセリ急行"];
  const artists = [];
  for (let i = 0; i < 720; i++) {
    const r = rnd();
    if (r < 0.25) artists.push(pick(JP_ARTISTS) + (chance(0.5) ? "" : " " + syl(1)));
    else if (r < 0.55) artists.push(pick(ART_PRE) + syl(2 + Math.floor(rnd() * 2)));
    else if (r < 0.8) artists.push(syl(2) + " " + syl(2));
    else artists.push(syl(1) + syl(1) + " feat. " + syl(2));
  }

  // ---- titles -----------------------------------------------------------
  const T1 = ["夜明けの", "真夏の", "最終電車の", "放課後の", "ネオンの", "雨上がりの", "銀河の", "秘密の", "午前三時の", "屋上の",
    "Midnight ", "Neon ", "Hyper ", "Sunset ", "Kampung ", "Turbo ", "Cosmic ", "Lucky ", "Velvet ", "Rapid "];
  const T2 = ["スピードライン", "ダンスホール", "シグナル", "メロディ", "パレード", "ハイウェイ", "ラブレター", "サイレン", "ステップ", "エンジン",
    "Rush", "Groove", "Signal", "Parade", "Express", "Heartbeat", "Breaker", "Fever", "Rocket", "Shuffle"];
  const MIXES = ["", "", "", " (Funkot Remix)", " (Funkot Edit)", " (180 Mix)", " (Extended)", " (Bootleg)", " (Original Mix)"];

  const FORMATS = ["MP3", "MP3", "MP3", "FLAC", "M4A", "OGG", "WAV"];
  const FOLDERS = ["Music/Funkot", "Music/Funkot/2015", "Music/Downloads", "Music/頒布CD", "Music/Remix", "Music/Old"];

  const customArr = [...custom];
  const hot = {
    "日本人トラックメーカー": 0.3,
    "インドネシア人トラックメーカー": 0.25,
  };
  const songs = [];
  const N = 24816;
  for (let i = 0; i < N; i++) {
    const artist = pick(artists);
    let title = pick(T1) + pick(T2) + pick(MIXES);
    if (chance(0.03)) title = pick(T2) + " " + (i % 97);
    const yr = rnd();
    let year = null, yearStatus = "auto";
    if (yr < 0.07) { year = null; yearStatus = "missing"; }
    else { year = 2008 + Math.floor(Math.pow(rnd(), 0.8) * 19); if (year > 2026) year = 2026; if (chance(0.06)) yearStatus = "manual"; }
    const genres = [];
    if (chance(0.82)) genres.push("Funkot");
    if (chance(0.13)) genres.push("アニソンremix");
    else if (chance(0.03)) genres.push(pick(["アニソンRemix", "anison remix", "アニソンリミックス"]));
    if (chance(0.25)) genres.push(pick(GENRES.slice(2, 30)));
    const tags = [];
    Object.entries(hot).forEach(([t, p]) => { if (tags.length === 0 && chance(p)) tags.push(t); });
    const nt = Math.floor(rnd() * 5);
    for (let k = 0; k < nt; k++) { const t = pick(customArr); if (!tags.includes(t)) tags.push(t); }
    if (year && chance(0.3)) tags.push(`${year}${pick(EVENT_SEASONS)}頒布`);
    songs.push({
      id: i, title, artist, year, yearStatus, genres: [...new Set(genres)], tags,
      dur: 150 + Math.floor(rnd() * 260), fmt: pick(FORMATS), folder: pick(FOLDERS),
      plays: chance(0.4) ? Math.floor(Math.pow(rnd(), 3) * 60) : 0,
      added: i, funkot: genres.includes("Funkot"), missing: false, rev: 1,
    });
  }

  // Hand-placed songs that the prototype's scenarios lean on.
  const special = [
    { title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", year: 2015, genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "2015夏頒布", "コール入り"], fmt: "FLAC", dur: 301, plays: 41 },
    { title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", year: 2015, genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "MP3", dur: 298, plays: 3, folder: "Music/Downloads" },
    { title: "星屑ラジオ体操第二 〜真夜中のテレビ放送が終わったあとにだけ流れる幻の三番〜 (Funkot Remix)", artist: "電子レンジ部 feat. Sorahana", year: 2015, genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", "ネタ曲"], fmt: "MP3", dur: 352, plays: 7 },
    { title: "月面行進曲 (180 Mix)", artist: "夜行性ペンギン", year: 2015, genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "疾走感"], fmt: "MP3", dur: 274, plays: 18 },
    { title: "鋼鉄商店街ダンスホール", artist: "金魚鉢レコーズ", year: 2015, genres: ["Funkot", "アニソンremix", "Happy Hardcore"], tags: ["日本人トラックメーカー", "多幸感"], fmt: "M4A", dur: 245, plays: 0 },
    { title: "track07", artist: "", year: 2015, yearStatus: "auto", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "WAV", dur: 233, plays: 1, untitled: true, folder: "Music/頒布CD/disc2" },
    { title: "微熱パレード (Bootleg)", artist: "鉄塔ガールズ", year: 2015, genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "MP3", dur: 262, plays: 12, missing: true },
  ];
  special.forEach((s, k) => songs.unshift(Object.assign({
    id: N + k, yearStatus: "auto", folder: "Music/Funkot/2015", added: N + k, funkot: true, missing: false, rev: 1,
  }, s)));

  const tagIndex = new Map(); // key -> {key, kind, value, count}
  const add = (kind, value) => {
    const key = kind + ":" + value;
    let t = tagIndex.get(key);
    if (!t) { t = { key, kind, value, count: 0 }; tagIndex.set(key, t); }
    t.count++;
  };
  songs.forEach((s) => {
    if (s.year) add("year", String(s.year));
    s.genres.forEach((g) => add("genre", g));
    s.tags.forEach((g) => add("custom", g));
  });
  customArr.forEach((c) => { if (!tagIndex.has("custom:" + c)) tagIndex.set("custom:" + c, { key: "custom:" + c, kind: "custom", value: c, count: 0 }); });

  const moodSet = new Set(MOODS);
  function tagCategory(kind, value) {
    if (kind === "year") return "year";
    if (kind === "genre") return "genre";
    if (/^\d{4}[夏冬]頒布$/.test(value)) return "release";
    if (moodSet.has(value)) return "mood";
    if (/^(日本人|インドネシア人|マレーシア人|韓国人|台湾人|フィリピン人|タイ人|ブラジル人)/.test(value) || /^(DJ|MC|Producer|Crew):/.test(value)) return "origin";
    return "work";
  }

  const playlists = [
    { id: "queue", name: "再生待ち", ink: "blue", kind: "queue" },
    { id: "fri", name: "金曜の夜", ink: "teal", kind: "list" },
    { id: "work", name: "作業用 180", ink: "orange", kind: "list" },
    { id: "anison", name: "アニソン縛り 2015", ink: "violet", kind: "list" },
    { id: "fav", name: "お気に入り", ink: "pink", kind: "fav" },
  ];

  window.FK = { songs, tagIndex, playlists, artists, tagCategory };
})();
