// Synthetic library for the design prototype. Every title, artist and tag is
// generated; none names a real recording. Deterministic so captures repeat.
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
    // spelling variants that really exist side by side in a tag store
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
      added: i, funkot: genres.includes("Funkot"), missing: false,
    });
  }

  // Hand-placed songs that the prototype's scenarios lean on. `raw` lists the
  // embedded date fields as the tag service keeps them (raw_key, raw_value);
  // `manual` is the player's own record for the content hash.
  const special = [
    { key: "after-flac", title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "2015夏頒布", "コール入り"], fmt: "FLAC", dur: 301, plays: 41, hash: "9f2c41d07ab35e18", raw: [["DATE", "2015-08-14"]] },
    { key: "after-mp3", title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "MP3", dur: 298, plays: 3, folder: "Music/Downloads", hash: "4b7e0c92d1f6a385", raw: [["TDRC", "2015"]] },
    { key: "long", title: "星屑ラジオ体操第二 〜真夜中のテレビ放送が終わったあとにだけ流れる幻の三番〜 (Funkot Remix)", artist: "電子レンジ部 feat. Sorahana", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ", "ネタ曲"], fmt: "MP3", dur: 352, plays: 7, raw: [["TDRC", "2015-03-01"]] },
    // two same-rank dates disagree: the automatic year is a conflict, the owner fixed 2015
    { key: "moon", title: "月面行進曲 (180 Mix)", artist: "夜行性ペンギン", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "疾走感"], fmt: "MP3", dur: 274, plays: 18, raw: [["TDRC", "2015\n2016"], ["TDOR", "2009"]], manualYear: { mode: "set", value: 2015 } },
    // the release date is unreadable; the owner fixed 2015
    { key: "steel", title: "鋼鉄商店街ダンスホール", artist: "金魚鉢レコーズ", genres: ["Funkot", "アニソンremix", "Happy Hardcore"], tags: ["日本人トラックメーカー", "多幸感"], fmt: "M4A", dur: 245, plays: 0, hash: "c1d8e2a7740b9f56", raw: [["©day", "20I5"]], manualYear: { mode: "set", value: 2015 } },
    { key: "track07", title: "track07", artist: "", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "WAV", dur: 233, plays: 1, untitled: true, folder: "Music/頒布CD/disc2", raw: [["ICRD", "2015"]], noTitleTag: true },
    { key: "fever", title: "微熱パレード (Bootleg)", artist: "鉄塔ガールズ", genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"], fmt: "MP3", dur: 262, plays: 12, missing: true, raw: [["TDRC", "2015"]] },
    // an identical copy: same bytes, same content hash, so one shared manual record
    { key: "steel-copy", title: "鋼鉄商店街ダンスホール", artist: "金魚鉢レコーズ", genres: ["Funkot", "アニソンremix", "Happy Hardcore"], tags: ["日本人トラックメーカー", "多幸感"], fmt: "M4A", dur: 245, plays: 2, folder: "Music/Old/バックアップ", hash: "c1d8e2a7740b9f56", raw: [["©day", "20I5"]], manualYear: { mode: "set", value: 2015 } },
    // a megamix carries dozens of tags: the stress case for tag editing
    { key: "mega", title: "電脳学園メガミックス 2015 (Funkot Megamix)", artist: "三丁目サウンド", genres: ["Funkot", "アニソンremix", "J-Core", "Happy Hardcore", "Hard House"], suppressed: [["genre", "Hard House"]],
      tags: ["日本人トラックメーカー", "2015夏頒布", "コール入り", "多幸感", "疾走感", "ドロップ2回", "転調", "ロングイントロ", "ボイスネタ", "サビ早い", "ピアノ",
        ...["星屑学園", "放課後少女隊", "電脳交響曲", "魔法探偵団", "鋼鉄行進曲R", "南国ラジオ", "月面列車2", "迷宮協奏曲", "銀河物語", "真夜中放送局", "桜色商店街",
          "疾風防衛軍Z", "微熱喫茶", "硝子図書館", "虹色遊園地", "深海楽団", "星屑放送局", "放課後交響曲", "電脳学園Next", "魔法少女隊外伝", "銀河列車∞", "桜色楽団",
          "真夜中学園Live", "虹色探偵団", "南国行進曲", "迷宮図書館", "月面喫茶", "硝子協奏曲", "深海物語", "疾風ラジオ"].map((w) => "原曲:" + w)],
      fmt: "FLAC", dur: 1488, plays: 9, folder: "Music/Remix", raw: [["DATE", "2015"], ["ORIGINALDATE", "2009-2015"]] },
  ];
  special.forEach((s, k) => {
    const year = 2015;
    songs.unshift(Object.assign({
      id: N + k, year, yearStatus: "auto", folder: "Music/Funkot/2015", added: N + k, funkot: true, missing: false,
    }, s));
  });

  // ---- identity and tag state (second generator so the base data stays identical)
  let seed2 = 173;
  const rnd2 = () => {
    seed2 |= 0; seed2 = (seed2 + 0x6d2b79f5) | 0;
    let t = Math.imul(seed2 ^ (seed2 >>> 15), 1 | seed2);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd2() * 16).toString(16)).join("");
  const RATE = { MP3: 40000, FLAC: 112000, WAV: 176400, M4A: 32000, OGG: 30000 };
  const DATE_KEY = { MP3: ["TDRC", "recording", 0], FLAC: ["DATE", "generic", 1], OGG: ["DATE", "generic", 1], M4A: ["©day", "release", 2], WAV: ["ICRD", "recording", 0] };
  const SEM = { TDRC: ["recording", 0], TYER: ["recording", 0], ICRD: ["recording", 0], DATE: ["generic", 1], YEAR: ["generic", 1], "©day": ["release", 2], TDOR: ["original", 3], ORIGINALDATE: ["original", 3] };
  const TAG_KEYS = { MP3: ["TIT2", "TPE1", "TCON"], FLAC: ["TITLE", "ARTIST", "GENRE"], OGG: ["TITLE", "ARTIST", "GENRE"], M4A: ["©nam", "©ART", "©gen"], WAV: ["INAM", "IART", "IGNR"] };
  const NOW_YEAR = 2026;

  // The resolver of docs/track-tags.md: the best present priority decides;
  // invalid, future and same-rank conflicts keep their diagnostic.
  function resolveYear(cands) {
    const usable = cands.filter((c) => c.semantic !== "original").sort((a, b) => a.rank - b.rank);
    if (!usable.length) return { year: null, status: "missing" };
    const top = usable.filter((c) => c.rank === usable[0].rank);
    const years = new Set();
    for (const c of top) {
      for (const el of String(c.raw_value).split("\n")) {
        const m = el.trim().match(/^(\d{4})(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?(T\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?)?$/);
        if (!m || Number(m[1]) < 1000) return { year: null, status: "invalid" };
        years.add(Number(m[1]));
      }
    }
    if (years.size > 1) return { year: null, status: "conflict" };
    const y = [...years][0];
    if (y > NOW_YEAR) return { year: null, status: "future" };
    return { year: y, status: "resolved" };
  }

  const manual = new Map(); // content hash -> { year, add: [{kind,value}], sup: [{kind,value}] }
  const fileName = (s) => {
    const base = s.untitled ? s.title : s.title.replace(/[\\/:*?"<>|]/g, "");
    return `${base}.${s.fmt.toLowerCase()}`;
  };
  songs.forEach((s, i) => {
    const custom2015 = s.year === 2015 && rnd2() < 0.006;
    const customFunkot = rnd2() < 0.004;
    if (custom2015) s.tags.push("2015");
    if (customFunkot) s.tags.push("Funkot");
    const hash = s.hash || hex(16);
    let raw;
    if (s.raw) raw = s.raw;
    else if (s.yearStatus === "missing") raw = [];
    else {
      const [k] = DATE_KEY[s.fmt];
      const autoYear = s.yearStatus === "manual" ? s.year - 1 - Math.floor(rnd2() * 3) : s.year;
      const v = rnd2() < 0.4 ? `${autoYear}-${String(1 + Math.floor(rnd2() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd2() * 28)).padStart(2, "0")}` : String(autoYear);
      raw = [[s.fmt === "MP3" && rnd2() < 0.3 ? "TYER" : k, v]];
    }
    const candidates = raw.map(([k, v]) => ({ raw_key: k, raw_value: v, semantic: SEM[k][0], rank: SEM[k][1] }));
    const [tk, ak, gk] = TAG_KEYS[s.fmt];
    const fields = [];
    if (!s.noTitleTag) fields.push([tk, s.title]);
    if (s.artist) fields.push([ak, s.artist]);
    s.genres.forEach((g) => fields.push([gk, g]));
    raw.forEach(([k, v]) => fields.push([k, v]));
    const mo = 1 + Math.floor(rnd2() * 12), da = 1 + Math.floor(rnd2() * 28);
    s.file = Object.freeze({
      path: `C:/Users/you/${s.folder}/${fileName(s)}`.replace("C:/Users/you/Music", "~/Music"),
      hash, size: Math.round(s.dur * RATE[s.fmt] * (0.96 + rnd2() * 0.08)),
      mtime: `${2016 + Math.floor(rnd2() * 10)}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`,
      fmt: s.fmt,
      embedded: Object.freeze({ fields: Object.freeze(fields.map((f) => Object.freeze(f))), genres: Object.freeze([...s.genres]), candidates: Object.freeze(candidates.map((c) => Object.freeze(c))) }),
    });
    s.auto = resolveYear(candidates);
    if (!manual.has(hash)) {
      const rec = { year: s.manualYear || (s.yearStatus === "manual" ? { mode: "set", value: s.year } : { mode: "auto" }), add: s.tags.map((v) => ({ kind: "custom", value: v })), sup: (s.suppressed || []).map(([kind, value]) => ({ kind, value })) };
      manual.set(hash, rec);
    }
    delete s.raw; delete s.manualYear; delete s.suppressed; delete s.hash;
  });

  // Effective tags exactly as the tag service derives them. Genre embedded
  // values minus suppressions, plus manual additions; year manual over auto.
  function effective(s) {
    const m = manual.get(s.file.hash);
    const sup = new Set(m.sup.map((t) => t.kind + ":" + t.value));
    const out = [];
    const year = m.year.mode === "set" ? m.year.value : m.year.mode === "unset" ? null : s.auto.year;
    if (year) out.push({ key: "year:" + year, kind: "year", value: String(year), origin: m.year.mode === "set" ? "manual" : "embedded" });
    const seen = new Map();
    s.file.embedded.genres.forEach((g) => { if (!sup.has("genre:" + g)) seen.set("genre:" + g, { key: "genre:" + g, kind: "genre", value: g, origin: "embedded" }); });
    m.add.forEach((t) => {
      const k = t.kind + ":" + t.value;
      if (seen.has(k)) seen.get(k).origin = "both";
      else seen.set(k, { key: k, kind: t.kind, value: t.value, origin: "manual" });
    });
    return out.concat([...seen.values()]);
  }
  function applyEffective(s) {
    const e = effective(s);
    const y = e.find((t) => t.kind === "year");
    s.year = y ? Number(y.value) : null;
    const m = manual.get(s.file.hash);
    s.yearStatus = m.year.mode === "set" ? "manual" : m.year.mode === "unset" ? "unset" : s.auto.status === "resolved" ? "auto" : s.auto.status;
    s.genres = e.filter((t) => t.kind === "genre").map((t) => t.value);
    s.tags = e.filter((t) => t.kind === "custom").map((t) => t.value);
  }
  songs.forEach(applyEffective);

  const tagIndex = new Map(); // key -> {key, kind, value, count}
  function reindex() {
    tagIndex.forEach((t) => (t.count = 0));
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
  }
  reindex();
  customArr.forEach((c) => { if (!tagIndex.has("custom:" + c)) tagIndex.set("custom:" + c, { key: "custom:" + c, kind: "custom", value: c, count: 0 }); });

  const playlists = [
    { id: "queue", name: "再生待ち", ink: "blue", kind: "queue" },
    { id: "fri", name: "金曜の夜", ink: "teal", kind: "list" },
    { id: "work", name: "作業用 180", ink: "orange", kind: "list" },
    { id: "anison", name: "アニソン縛り 2015", ink: "violet", kind: "list" },
    { id: "fav", name: "お気に入り", ink: "pink", kind: "fav" },
  ];

  window.FK = { songs, tagIndex, playlists, artists, manual, effective, applyEffective, reindex, resolveYear, NOW_YEAR };
})();
