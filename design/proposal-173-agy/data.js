// Synthetic library and real TagService mock matching docs/track-tags.md,
// src/lib/tauri.ts, src-tauri/src/tag_service.rs, and src-tauri/src/track_tags.rs.
// Every title, artist, hash, and tag is synthetic. Deterministic for repeatable tests.
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
  const MOODS = [
    "多幸感", "疾走感", "泣き", "ネタ曲", "ピアノ", "サイレン", "ベース強め", "ボイスネタ",
    "シンセリード", "サビ早い", "インスト", "コール入り", "ロングイントロ", "ショート", "ドロップ2回", "転調",
  ];
  const EVENT_SEASONS = ["夏", "冬"];
  const WORK_A = ["星屑", "放課後", "電脳", "魔法", "鋼鉄", "南国", "月面", "迷宮", "銀河", "真夜中", "桜色", "疾風", "微熱", "硝子", "虹色", "深海"];
  const WORK_B = ["学園", "少女隊", "交響曲", "探偵団", "行進曲", "ラジオ", "列車", "協奏曲", "物語", "放送局", "商店街", "防衛軍", "喫茶", "図書館", "遊園地", "楽団"];
  const WORK_C = ["", "R", "2", "∞", "Next", "外伝", "Z", "Live"];

  const customPool = new Set();
  ORIGINS.forEach((o) => ROLES.forEach((r) => customPool.add(o + r)));
  MOODS.forEach((m) => customPool.add(m));
  for (let y = 2008; y <= 2026; y++) EVENT_SEASONS.forEach((s) => customPool.add(`${y}${s}頒布`));
  WORK_A.forEach((a) => WORK_B.forEach((b) => WORK_C.forEach((c) => customPool.add(`原曲:${a}${b}${c}`))));
  ["DJ", "MC", "Producer", "Crew"].forEach((p) => {
    for (let i = 0; i < 120; i++) customPool.add(`${p}:${syl(2)}${syl(1)}`);
  });
  customPool.add("日本人トラックメーカー");
  customPool.add("日本人トラックメーカー（旧名義）");
  customPool.add("日本人 trackmaker");
  customPool.add("原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ");
  // Same surface text in custom kind to exercise strict kind disambiguation (docs/track-tags.md)
  customPool.add("2015");
  customPool.add("アニソンremix");
  customPool.add("Funkot");

  function syl(n) {
    const S = ["ka", "ri", "mo", "su", "na", "to", "ya", "ze", "ru", "ko", "mi", "ta", "ra", "pu", "se", "no", "ha", "ji", "ga", "do"];
    let s = "";
    for (let i = 0; i < n; i++) s += pick(S);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const ART_PRE = ["DJ ", "", "", "", "MC ", "", "Kid ", ""];
  const JP_ARTISTS = [
    "夜行性ペンギン", "ねこまたドライブ", "電子レンジ部", "鉄塔ガールズ", "あめふらし工房", "月曜日の象", "ミラーボール商会",
    "そらまめ電機", "灯台守", "三丁目サウンド", "マグカップ団", "ゆうやけ回路", "金魚鉢レコーズ", "白昼夢製作所", "パセリ急行",
  ];
  const artists = [];
  for (let i = 0; i < 720; i++) {
    const r = rnd();
    if (r < 0.25) artists.push(pick(JP_ARTISTS) + (chance(0.5) ? "" : " " + syl(1)));
    else if (r < 0.55) artists.push(pick(ART_PRE) + syl(2 + Math.floor(rnd() * 2)));
    else if (r < 0.8) artists.push(syl(2) + " " + syl(2));
    else artists.push(syl(1) + syl(1) + " feat. " + syl(2));
  }

  const T1 = [
    "夜明けの", "真夏の", "最終電車の", "放課後の", "ネオンの", "雨上がりの", "銀河の", "秘密の", "午前三時の", "屋上の",
    "Midnight ", "Neon ", "Hyper ", "Sunset ", "Kampung ", "Turbo ", "Cosmic ", "Lucky ", "Velvet ", "Rapid ",
  ];
  const T2 = [
    "スピードライン", "ダンスホール", "シグナル", "メロディ", "パレード", "ハイウェイ", "ラブレター", "サイレン", "ステップ", "エンジン",
    "Rush", "Groove", "Signal", "Parade", "Express", "Heartbeat", "Breaker", "Fever", "Rocket", "Shuffle",
  ];
  const MIXES = ["", "", "", " (Funkot Remix)", " (Funkot Edit)", " (180 Mix)", " (Extended)", " (Bootleg)", " (Original Mix)"];
  const FORMATS = ["MP3", "MP3", "MP3", "FLAC", "M4A", "OGG", "WAV"];
  const FOLDERS = ["Music/Funkot", "Music/Funkot/2015", "Music/Downloads", "Music/頒布CD", "Music/Remix", "Music/Old"];
  const customArr = [...customPool];
  const hot = { "日本人トラックメーカー": 0.3, "インドネシア人トラックメーカー": 0.25 };

  // ---- Real Tag Contract Helpers (mirroring src-tauri/src/track_tags.rs) ----
  const CURRENT_UTC_YEAR = 2026;
  const MAX_EFFECTIVE_TAGS = 128;
  const MAX_TAG_SCALARS = 128;

  const asciiFold = (v) => String(v).replace(/[A-Z]/g, (c) => c.toLowerCase());
  const hasControlChar = (v) => /[\x00-\x1F\x7F]/.test(v);
  function normalizeTag(kind, rawValue) {
    if (kind !== "genre" && kind !== "custom") return { error: "invalid_input" };
    const value = String(rawValue ?? "").trim().normalize("NFC");
    if (!value) return { error: "empty" };
    if (hasControlChar(value)) return { error: "control" };
    if ([...value].length > MAX_TAG_SCALARS) return { error: "too_long" };
    return { tag: { kind, value } };
  }
  const tagKey = (tag) => `${tag.kind}:${asciiFold(tag.value)}`;
  const sameTag = (a, b) => a.kind === b.kind && asciiFold(a.value) === asciiFold(b.value);

  function parseCandidateYear(raw) {
    const m = /^(\d{4})(?:$|-(\d{2})(?:-(\d{2})(?:T.*)?)?$)/.exec(String(raw ?? "").trim());
    if (!m) return null;
    const y = Number(m[1]);
    if (y < 1000 || y > 9999) return null;
    if (m[2]) {
      const mo = Number(m[2]);
      if (mo < 1 || mo > 12) return null;
      if (m[3]) {
        const d = Number(m[3]);
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      }
    }
    return y;
  }

  function resolveYearCandidates(candidates, currentYear = CURRENT_UTC_YEAR) {
    if (!candidates.length) return { auto_year: null, year_status: "missing" };
    const byRank = new Map();
    for (const c of candidates) {
      if (c.semantic === "original" || c.rank > 2) continue;
      if (!byRank.has(c.rank)) byRank.set(c.rank, []);
      byRank.get(c.rank).push(c);
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    for (const rank of ranks) {
      const list = byRank.get(rank);
      const parsed = [];
      let sawInvalid = false;
      let sawFuture = false;
      for (const c of list) {
        const parts = String(c.raw_value).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        if (!parts.length) { sawInvalid = true; continue; }
        for (const part of parts) {
          const y = parseCandidateYear(part);
          if (y === null) sawInvalid = true;
          else if (y > currentYear) sawFuture = true;
          else parsed.push(y);
        }
      }
      if (sawInvalid) return { auto_year: null, year_status: "invalid" };
      if (sawFuture) return { auto_year: null, year_status: "future" };
      const uniq = [...new Set(parsed)];
      if (uniq.length > 1) return { auto_year: null, year_status: "conflict" };
      if (uniq.length === 1) return { auto_year: uniq[0], year_status: "resolved" };
    }
    return { auto_year: null, year_status: "missing" };
  }

  function computeEffective(song) {
    const manual = song.manual;
    const embedded = song.embedded;
    const autoGenres = song.metadata_status === "ready" ? embedded.genres : [];
    const suppressed = new Set(manual.suppressed_auto_tags.map(tagKey));
    const map = new Map();
    for (const g of autoGenres) {
      const norm = normalizeTag("genre", g);
      if (!norm.tag) continue;
      const k = tagKey(norm.tag);
      if (!suppressed.has(k)) {
        map.set(k, { key: k, kind: "genre", value: norm.tag.value, origin: "embedded" });
      }
    }
    for (const t of manual.manual_additions) {
      const k = tagKey(t);
      const existing = map.get(k);
      if (existing) {
        existing.origin = "both";
        existing.value = t.value;
      } else {
        map.set(k, { key: k, kind: t.kind, value: t.value, origin: "manual" });
      }
    }
    const items = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    const resYear = resolveYearCandidates(embedded.year_candidates);
    const autoYear = song.metadata_status === "ready" ? resYear.auto_year : null;
    const yearStatus = song.metadata_status === "ready" ? resYear.year_status : "missing";
    let effYear = null;
    let effYearOrigin = "embedded";
    if (manual.year.mode === "set") {
      effYear = manual.year.value;
      effYearOrigin = "manual";
    } else if (manual.year.mode === "auto") {
      effYear = autoYear;
      effYearOrigin = "embedded";
    }
    const effective = effYear !== null
      ? [{ key: `year:${effYear}`, kind: "year", value: String(effYear), origin: effYearOrigin }, ...items]
      : items;

    song.auto_year = autoYear;
    song.year_status = yearStatus;
    song.year = effYear;
    song.yearStatus = manual.year.mode === "set" ? "manual" : manual.year.mode === "unset" ? "unset" : effYear !== null ? "auto" : "missing";
    song.effective = effective;
    song.genres = items.filter((x) => x.kind === "genre").map((x) => x.value);
    song.tags = items.filter((x) => x.kind === "custom").map((x) => x.value);
  }

  function makeHash(id, fmt) {
    const h = ((id * 2654435761) >>> 0).toString(16).padStart(8, "0");
    return `h-${fmt.toLowerCase()}-${h}`;
  }

  function defaultCandidatesFor(year, fmt) {
    if (!year) return [];
    if (fmt === "FLAC" || fmt === "OGG") return [{ raw_key: "DATE", raw_value: String(year), semantic: "generic", rank: 1 }];
    if (fmt === "M4A") return [{ raw_key: "©day", raw_value: String(year), semantic: "release", rank: 2 }];
    if (fmt === "WAV") return [{ raw_key: "ICRD", raw_value: String(year), semantic: "recording", rank: 0 }];
    return [{ raw_key: "TDRC", raw_value: String(year), semantic: "recording", rank: 0 }];
  }

  const usedPaths = new Set();
  function buildSong(raw) {
    const fmt = raw.fmt || "MP3";
    const folder = raw.folder || "Music/Funkot/2015";
    const fileBase = raw.fileBase || (raw.untitled ? raw.title : raw.title.replace(/[\\/:*?"<>|]/g, "_"));
    let path = raw.path || `${folder}/${fileBase}.${fmt.toLowerCase()}`;
    if (usedPaths.has(path)) {
      const dot = path.lastIndexOf(".");
      path = dot >= 0 ? `${path.slice(0, dot)}_${raw.id}${path.slice(dot)}` : `${path}_${raw.id}`;
    }
    usedPaths.add(path);
    const embeddedGenres = [...new Set(raw.genres || [])];
    const yearCandidates = raw.candidates || defaultCandidatesFor(raw.embeddedYear !== undefined ? raw.embeddedYear : raw.year, fmt);
    const manualAdditions = (raw.manualTags || raw.tags || []).map((v) =>
      typeof v === "string" ? { kind: "custom", value: v } : v
    );
    const manualYear = raw.manualYear || (raw.yearStatus === "manual" && raw.year ? { mode: "set", value: raw.year } : { mode: "auto" });
    const song = {
      id: raw.id,
      title: raw.title,
      artist: raw.artist,
      dur: raw.dur,
      fmt,
      folder,
      path,
      plays: raw.plays || 0,
      added: raw.added,
      funkot: raw.funkot !== undefined ? raw.funkot : embeddedGenres.includes("Funkot"),
      analyzed: raw.analyzed !== undefined ? raw.analyzed : true,
      missing: !!raw.missing,
      untitled: !!raw.untitled,
      content_hash: raw.content_hash !== undefined ? raw.content_hash : makeHash(raw.id, fmt),
      fingerprint: raw.fingerprint || `fp-${raw.id}-1`,
      metadata_status: raw.metadata_status || "ready",
      diagnostics: [...(raw.diagnostics || [])],
      embedded: Object.freeze({
        title: raw.title,
        artist: raw.artist,
        genres: Object.freeze([...embeddedGenres]),
        year_candidates: Object.freeze(yearCandidates.map((c) => Object.freeze({ ...c }))),
        byteLength: 4200000 + ((raw.id * 9973) % 18000000),
        mtime: 1735689600000 + raw.id * 1000,
      }),
      candidates: yearCandidates,
      manual: {
        year: manualYear,
        manual_additions: manualAdditions,
        suppressed_auto_tags: [...(raw.suppressed || [])],
      },
      year: null,
      yearStatus: "missing",
      auto_year: null,
      year_status: "missing",
      effective: [],
      genres: [],
      tags: [],
    };
    computeEffective(song);
    return song;
  }

  // ---- Build 24,816 generated songs + special core/stress songs (= 24,823 total) ----
  const songs = [];
  const N = 24808;
  for (let i = 0; i < N; i++) {
    const artist = pick(artists);
    let title = pick(T1) + pick(T2) + pick(MIXES);
    if (chance(0.03)) title = pick(T2) + " " + (i % 97);
    const yr = rnd();
    let year = null, yearStatus = "auto";
    if (yr < 0.07) { year = null; yearStatus = "missing"; }
    else {
      year = 2008 + Math.floor(Math.pow(rnd(), 0.8) * 19);
      if (year > 2026) year = 2026;
      if (chance(0.06)) yearStatus = "manual";
    }
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
    // Ensure custom:"2015", custom:"アニソンremix", custom:"Funkot" appear realistically in the library
    if (i % 1900 === 10 && year !== 2015) tags.push("2015");
    if (i % 2400 === 20 && !genres.includes("アニソンremix")) tags.push("アニソンremix");
    if (i % 2600 === 30) tags.push("Funkot");

    songs.push(buildSong({
      id: i, title, artist, year, yearStatus, genres: [...new Set(genres)], tags,
      dur: 150 + Math.floor(rnd() * 260), fmt: pick(FORMATS), folder: pick(FOLDERS),
      plays: chance(0.4) ? Math.floor(Math.pow(rnd(), 3) * 60) : 0,
      added: i, funkot: genres.includes("Funkot"), missing: false,
    }));
  }

  // 32-tag rich song (4 genres + 28 custom tags, mixing embedded/manual/both + suppressed auto tags)
  const manyCustomTags = [
    "日本人トラックメーカー",
    "原曲がとても長いタイトルのアニメーション作品・第二期オープニング主題歌シリーズ",
    "ネタ曲", "2015夏頒布", "コール入り", "多幸感", "疾走感", "ピアノ", "サイレン",
    "シンセリード", "サビ早い", "ドロップ2回", "転調", "ロングイントロ", "ボイスネタ", "ベース強め",
    "ライブ定番", "2015年ベスト", "深夜帯向け", "後半盛り上げ", "4つ打ち", "BPM180",
    "フロアアンセム", "同人CD収録", "リミックス特集", "掛け声あり", "サンプリング多用", "アニソンremix",
  ];

  // 15 special songs (total library: 24,808 + 15 = 24,823 songs)
  const specialSpecs = [
    // index 0..6 match Overprint Liner's top rows under 3-condition AND
    {
      title: "微熱パレード (Bootleg)", artist: "鉄塔ガールズ", year: 2015,
      genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"],
      fmt: "MP3", dur: 262, plays: 12, missing: true, content_hash: "h-missing-0001",
    },
    {
      title: "track07", artist: "", year: 2015, yearStatus: "auto",
      genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"],
      fmt: "WAV", dur: 233, plays: 1, untitled: true, folder: "Music/頒布CD/disc2", content_hash: "h-track07-0002",
    },
    {
      title: "鋼鉄商店街ダンスホール", artist: "金魚鉢レコーズ", year: 2015,
      genres: ["Funkot", "アニソンremix", "Happy Hardcore"], tags: ["日本人トラックメーカー", "多幸感"],
      fmt: "M4A", dur: 245, plays: 0, content_hash: "h-steel-shared-77b2",
    },
    {
      title: "月面行進曲 (180 Mix)", artist: "夜行性ペンギン", year: 2015,
      genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "疾走感"],
      fmt: "MP3", dur: 274, plays: 18, content_hash: "h-moon-0004",
    },
    {
      title: "星屑ラジオ体操第二 〜真夜中のテレビ放送が終わったあとにだけ流れる幻の三番〜 (Funkot Remix)",
      artist: "電子レンジ部 feat. Sorahana", year: 2015,
      genres: ["Funkot", "アニソンremix", "Happy Hardcore", "J-Core"],
      tags: manyCustomTags,
      manualTags: [
        { kind: "genre", value: "Funkot" }, // origin: both!
        ...manyCustomTags.map((v) => ({ kind: "custom", value: v })),
      ],
      suppressed: [{ kind: "genre", value: "Pop" }, { kind: "genre", value: "Eurobeat" }],
      fmt: "MP3", dur: 352, plays: 7, content_hash: "h-many-tags-32a1",
      candidates: [
        { raw_key: "TDRC", raw_value: "2015-08-16", semantic: "recording", rank: 0 },
        { raw_key: "©day", raw_value: "2015", semantic: "release", rank: 2 },
        { raw_key: "TDOR", raw_value: "2011", semantic: "original", rank: 3 },
      ],
    },
    {
      title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", year: 2015,
      genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー"],
      fmt: "MP3", dur: 298, plays: 3, folder: "Music/Downloads", content_hash: "h-signal-mp3-2c91",
      candidates: [
        { raw_key: "TYER", raw_value: "2015", semantic: "recording", rank: 0 },
        { raw_key: "TDOR", raw_value: "2012", semantic: "original", rank: 3 },
      ],
    },
    {
      title: "放課後シグナル (Funkot Remix)", artist: "ねこまたドライブ", year: 2015,
      genres: ["Funkot", "アニソンremix"], tags: ["日本人トラックメーカー", "2015夏頒布", "コール入り"],
      fmt: "FLAC", dur: 301, plays: 41, folder: "Music/Funkot/2015", content_hash: "h-signal-flac-8a4f",
      candidates: [
        { raw_key: "DATE", raw_value: "2015-08-14", semantic: "generic", rank: 1 },
        { raw_key: "TDOR", raw_value: "2012", semantic: "original", rank: 3 },
      ],
    },
    // Duplicate identical-hash copy sharing content_hash with 鋼鉄商店街ダンスホール
    {
      title: "鋼鉄商店街ダンスホール", artist: "金魚鉢レコーズ", year: 2015,
      genres: ["Funkot", "アニソンremix", "Happy Hardcore"], tags: ["日本人トラックメーカー", "多幸感"],
      fmt: "M4A", dur: 245, plays: 0, folder: "Music/Downloads/backup",
      path: "Music/Downloads/backup/鋼鉄商店街ダンスホール_copy.m4a",
      content_hash: "h-steel-shared-77b2",
    },
    // Year conflict candidate stress track
    {
      title: "迷宮ラジオの夜明け (180 Edit)", artist: "ゆうやけ回路",
      genres: ["Funkot", "電波remix"], tags: ["日本人トラックメーカー", "シンセリード"],
      fmt: "MP3", dur: 288, plays: 9, folder: "Music/Remix", content_hash: "h-conflict-year-01",
      candidates: [
        { raw_key: "TYER", raw_value: "2014", semantic: "recording", rank: 0 },
        { raw_key: "TDRC", raw_value: "2015-08-14", semantic: "recording", rank: 0 },
        { raw_key: "©day", raw_value: "2016", semantic: "release", rank: 2 },
        { raw_key: "TDOR", raw_value: "2009", semantic: "original", rank: 3 },
      ],
      diagnostics: ["year_conflict: rank 0 recording candidates disagree (2014 vs 2015)"],
    },
    // Future & invalid year stress track
    {
      title: "銀河Express 2099 (Future Bootleg)", artist: "白昼夢製作所",
      genres: ["Funkot"], tags: ["ネタ曲"],
      fmt: "FLAC", dur: 266, plays: 4, folder: "Music/Downloads", content_hash: "h-future-year-02",
      candidates: [
        { raw_key: "DATE", raw_value: "2099", semantic: "generic", rank: 1 },
        { raw_key: "YEAR", raw_value: "circa-2018", semantic: "generic", rank: 1 },
        { raw_key: "©day", raw_value: "2018", semantic: "release", rank: 2 },
      ],
      diagnostics: ["year_future: candidate 2099 exceeds UTC year 2026"],
    },
    // Invalid year candidate track
    {
      title: "雨上がりのサイレン", artist: "そらまめ電機",
      genres: ["Funkot", "Breakcore"], tags: ["サイレン"],
      fmt: "FLAC", dur: 241, plays: 2, folder: "Music/Old", content_hash: "h-invalid-year-03",
      candidates: [
        { raw_key: "DATE", raw_value: "999", semantic: "generic", rank: 1 },
        { raw_key: "©day", raw_value: "2017", semantic: "release", rank: 2 },
      ],
      diagnostics: ["year_invalid: rank 1 DATE '999' is outside 1000..9999"],
    },
    // Unresolved identity (content_hash: null, pending metadata)
    {
      title: "真夜中の未スキャン曲", artist: "パセリ急行",
      genres: [], tags: [],
      fmt: "MP3", dur: 215, plays: 0, folder: "Music/Downloads",
      content_hash: null, metadata_status: "pending", analyzed: false, funkot: false,
      candidates: [],
    },
    // Metadata probe error track
    {
      title: "壊れたRIFFヘッダの曲", artist: "三丁目サウンド",
      genres: [], tags: ["2015"],
      fmt: "WAV", dur: 199, plays: 0, folder: "Music/Old",
      content_hash: "h-meta-error-05", metadata_status: "error",
      diagnostics: ["metadata_probe_failed: malformed RIFF INFO chunk size"],
      candidates: [],
    },
    // Pending metadata WITH explicit manual unset year (must remain searchable under yearUnset!)
    {
      title: "年未設定を手動固定した曲", artist: "灯台守",
      genres: [], tags: ["日本人トラックメーカー"],
      fmt: "M4A", dur: 249, plays: 5, folder: "Music/Downloads",
      content_hash: "h-manual-unset-901a", metadata_status: "pending",
      manualYear: { mode: "unset" }, candidates: [],
    },
    // Non-Funkot analyzed track (editable tags, but gated for queue/destination add)
    {
      title: "午後四時のBreakbeat (Non-Funkot)", artist: "ミラーボール商会", year: 2015,
      genres: ["Breakbeat"], tags: ["日本人トラックメーカー", "インスト"],
      fmt: "MP3", dur: 222, plays: 6, folder: "Music/Downloads",
      content_hash: "h-non-funkot-07", funkot: false, analyzed: true,
    },
  ];

  // Reverse unshift so specialSpecs[0] ends up at songs[0] (matching Claude Liner ordering!)
  for (let k = specialSpecs.length - 1; k >= 0; k--) {
    const spec = specialSpecs[k];
    songs.unshift(buildSong({
      id: N + (specialSpecs.length - 1 - k),
      added: N + (specialSpecs.length - 1 - k) + 100,
      ...spec,
    }));
  }

  // Re-ensure songs[0..6] ids are predictable and mirror specialSpecs[0..6]
  const byId = new Map(songs.map((s) => [s.id, s]));
  const byPath = new Map(songs.map((s) => [s.path, s]));

  // Freeze initial embedded snapshots for audio-file immutability proof
  const initialAudioChecksums = new Map(songs.map((s) => [
    s.id,
    JSON.stringify(s.embedded),
  ]));
  const replacedOriginals = new Map();
  let replaceSeq = 0;

  // ---- Dynamic Tag Index (always mirrors committed effective tags) ----
  const tagIndex = new Map();
  function rebuildTagIndex() {
    tagIndex.clear();
    const casingCounts = new Map();
    const bump = (kind, value) => {
      const key = `${kind}:${asciiFold(value)}`;
      let t = tagIndex.get(key);
      if (!t) {
        t = { key, kind, value, count: 0 };
        tagIndex.set(key, t);
        casingCounts.set(key, new Map());
      }
      const vc = casingCounts.get(key);
      vc.set(value, (vc.get(value) || 0) + 1);
      t.count += 1;
    };
    for (const s of songs) {
      const seen = new Set();
      for (const eff of s.effective) {
        if (seen.has(eff.key)) continue;
        seen.add(eff.key);
        bump(eff.kind, eff.value);
      }
    }
    for (const [key, vc] of casingCounts) {
      let bestVal = tagIndex.get(key).value;
      let bestN = -1;
      for (const [val, n] of vc) {
        if (n > bestN || (n === bestN && val < bestVal)) {
          bestVal = val;
          bestN = n;
        }
      }
      tagIndex.get(key).value = bestVal;
    }
    for (const c of customArr) {
      const k = `custom:${asciiFold(c)}`;
      if (!tagIndex.has(k)) tagIndex.set(k, { key: k, kind: "custom", value: c, count: 0 });
    }
  }
  rebuildTagIndex();

  // ---- Mock Tag Service (implements src-tauri/src/tag_service.rs contract) ----
  const tagService = {
    session: "agy-mock-1",
    epoch: 1,
    year: CURRENT_UTC_YEAR,
    generation: 0,
    store_status: "ready", // "ready" | "missing" | "corrupt" | "unsupported_schema" | "io_error"
    nextFailure: null,
    get revision() {
      return `${this.session}/${this.epoch}/${this.year}/${this.generation}`;
    },
    listTrackTags() {
      const tracks = {};
      for (const s of songs) {
        tracks[s.path] = {
          content_hash: s.content_hash,
          effective: s.effective.map((e) => ({ ...e })),
          manual: {
            year: { ...s.manual.year },
            manual_additions: s.manual.manual_additions.map((t) => ({ ...t })),
            suppressed_auto_tags: s.manual.suppressed_auto_tags.map((t) => ({ ...t })),
          },
          auto_year: s.auto_year,
          year_status: s.year_status,
          metadata_status: s.metadata_status,
          candidates: s.candidates.map((c) => ({ ...c })),
          diagnostics: [...s.diagnostics],
        };
      }
      return {
        revision: this.revision,
        ready: true,
        store_status: this.store_status,
        tracks,
      };
    },
    updateTrackTags(request) {
      if (!["ready", "missing"].includes(this.store_status)) {
        throw { code: "store_read_only", message: "store_read_only" };
      }
      if (this.nextFailure) {
        const code = this.nextFailure;
        this.nextFailure = null;
        throw { code, message: code };
      }
      if (!request || request.expected_revision !== this.revision) {
        throw { code: "stale_revision", message: "stale_revision" };
      }
      if (!request.targets || !request.targets.length) {
        throw { code: "invalid_input", message: "invalid_input" };
      }
      const targetHashes = [];
      for (const tgt of request.targets) {
        const s = byPath.get(tgt.path);
        if (!s || !s.content_hash) throw { code: "identity_unavailable", message: "identity_unavailable" };
        if (s.content_hash !== tgt.expected_hash || s.fingerprint !== (tgt.expected_fingerprint || s.fingerprint)) {
          throw { code: "identity_changed", message: "identity_changed" };
        }
        targetHashes.push(s.content_hash);
      }
      const patch = request.patch || {};
      if (patch.year_change && patch.year_change.mode === "set") {
        const y = patch.year_change.value;
        if (!Number.isInteger(y) || y < 1000 || y > 9999) {
          throw { code: "invalid_input", message: "invalid_input" };
        }
      }
      const normAdd = [];
      for (const t of patch.add || []) {
        const r = normalizeTag(t.kind, t.value);
        if (r.error) throw { code: "invalid_input", message: r.error };
        normAdd.push(r.tag);
      }
      const normRemove = [];
      for (const t of patch.remove || []) {
        const r = normalizeTag(t.kind, t.value);
        if (r.error) throw { code: "invalid_input", message: r.error };
        normRemove.push(r.tag);
      }

      const uniqueHashes = [...new Set(targetHashes)];
      const hashToSongs = new Map();
      for (const h of uniqueHashes) {
        hashToSongs.set(h, songs.filter((s) => s.content_hash === h));
      }

      // Compute dry-run changes per unique content hash to detect no-op accurately
      let changedCount = 0;
      const planned = new Map();
      for (const h of uniqueHashes) {
        const group = hashToSongs.get(h);
        const rep = group[0];
        const before = JSON.stringify(rep.manual);
        const nextManual = {
          year: patch.year_change ? { ...patch.year_change } : { ...rep.manual.year },
          manual_additions: rep.manual.manual_additions.map((t) => ({ ...t })),
          suppressed_auto_tags: rep.manual.suppressed_auto_tags.map((t) => ({ ...t })),
        };
        const autoGenres = rep.metadata_status === "ready" ? rep.embedded.genres : [];
        const autoKeys = new Set(autoGenres.map((g) => `genre:${asciiFold(g)}`));

        for (const rem of normRemove) {
          const rk = tagKey(rem);
          nextManual.manual_additions = nextManual.manual_additions.filter((t) => tagKey(t) !== rk);
          if (autoKeys.has(rk) && !nextManual.suppressed_auto_tags.some((t) => tagKey(t) === rk)) {
            nextManual.suppressed_auto_tags.push({ ...rem });
          }
        }
        for (const add of normAdd) {
          const ak = tagKey(add);
          nextManual.suppressed_auto_tags = nextManual.suppressed_auto_tags.filter((t) => tagKey(t) !== ak);
          if (!nextManual.manual_additions.some((t) => tagKey(t) === ak)) {
            nextManual.manual_additions.push({ ...add });
          }
        }
        // Enforce MAX_EFFECTIVE_TAGS (128)
        const testSong = { ...rep, manual: nextManual };
        computeEffective(testSong);
        if (testSong.effective.filter((e) => e.kind !== "year").length > MAX_EFFECTIVE_TAGS) {
          throw { code: "invalid_input", message: "too_many_effective_tags" };
        }
        const after = JSON.stringify(nextManual);
        if (before !== after) changedCount += 1;
        planned.set(h, nextManual);
      }

      if (changedCount === 0) {
        return { snapshot: this.listTrackTags(), changed: 0, no_op: uniqueHashes.length };
      }

      for (const [h, nextManual] of planned) {
        for (const s of hashToSongs.get(h)) {
          s.manual = JSON.parse(JSON.stringify(nextManual));
          computeEffective(s);
        }
      }
      this.generation += 1;
      rebuildTagIndex();
      return {
        snapshot: this.listTrackTags(),
        changed: changedCount,
        no_op: uniqueHashes.length - changedCount,
      };
    },
    simulateBackgroundScan() {
      this.epoch += 1;
    },
    simulateRescan() {
      this.epoch += 1;
      for (const s of songs) computeEffective(s);
      rebuildTagIndex();
    },
    simulateFileReplacement(path, bumpEpoch = false) {
      const s = byPath.get(path);
      if (!s) return false;
      if (!replacedOriginals.has(s.id)) {
        replacedOriginals.set(s.id, { content_hash: s.content_hash, fingerprint: s.fingerprint });
      }
      replaceSeq += 1;
      s.content_hash = `${s.content_hash || "h"}-replaced-${replaceSeq}`;
      s.fingerprint = `fp-replaced-${replaceSeq}`;
      if (bumpEpoch) this.epoch += 1;
      return true;
    },
    restoreSimulatedReplacements() {
      for (const [id, orig] of replacedOriginals) {
        const s = byId.get(id);
        if (s) {
          s.content_hash = orig.content_hash;
          s.fingerprint = orig.fingerprint;
        }
      }
      replacedOriginals.clear();
    },
    verifyAudioFilesUntouched() {
      for (const s of songs) {
        if (JSON.stringify(s.embedded) !== initialAudioChecksums.get(s.id)) {
          return { ok: false, path: s.path };
        }
      }
      return { ok: true, checked: songs.length };
    },
  };

  const playlists = [
    { id: "queue", name: "再生待ち", ink: "blue", kind: "queue" },
    { id: "fri", name: "金曜の夜", ink: "teal", kind: "list" },
    { id: "work", name: "作業用 180", ink: "orange", kind: "list" },
    { id: "anison", name: "アニソン縛り 2015", ink: "violet", kind: "list" },
    { id: "fav", name: "お気に入り", ink: "pink", kind: "fav" },
  ];

  window.FK = {
    songs,
    byId,
    byPath,
    tagIndex,
    playlists,
    artists,
    tagService,
    rebuildTagIndex,
    normalizeTag,
    tagKey,
    sameTag,
    parseCandidateYear,
    computeEffective,
    MAX_EFFECTIVE_TAGS,
    MAX_TAG_SCALARS,
  };
})();
