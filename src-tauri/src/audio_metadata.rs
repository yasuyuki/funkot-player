//! Read-only extraction of the small, stable subset of embedded audio metadata
//! used by the library index.  This module deliberately does not decide how
//! metadata is persisted or how manual tags override it.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use serde::{Deserialize, Serialize};
use crate::track_tags::{Tag as TrackTag, TagKind};
use symphonia::{
    core::{
        formats::{probe::Hint, FormatOptions},
        io::MediaSourceStream,
        meta::{MetadataOptions, StandardTag, Tag},
    },
    default::get_probe,
};

/// The meaning of a date candidate, in decreasing production-year priority.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum YearSemantic {
    #[default]
    Recording,
    Generic,
    Release,
    Original,
}

impl YearSemantic {
    fn rank(self) -> u8 {
        match self {
            Self::Recording => 0,
            Self::Generic => 1,
            Self::Release => 2,
            Self::Original => 3,
        }
    }

    fn is_production_year(self) -> bool {
        matches!(self, Self::Recording | Self::Generic)
    }
}

/// A source value retained so a future resolver can explain its decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct YearCandidate {
    pub raw_key: String,
    pub raw_value: String,
    pub semantic: YearSemantic,
    pub rank: u8,
}

impl YearCandidate {
    fn new(raw_key: String, raw_value: String, semantic: YearSemantic) -> Self {
        Self { raw_key, raw_value, rank: semantic.rank(), semantic }
    }
}

/// The time-dependent outcome of selecting a production year.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum YearResolution {
    Ready { year: u16, semantic: YearSemantic },
    Missing,
    Invalid { candidates: Vec<YearCandidate> },
    Future { candidates: Vec<YearCandidate> },
    Conflict { candidates: Vec<YearCandidate> },
}

impl Default for YearResolution {
    fn default() -> Self {
        Self::Missing
    }
}

/// Data obtained from an audio file without mutating it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Native genre values. They are intentionally neither split nor deduplicated.
    /// The tag-store adapter validates and normalizes each value independently.
    pub genres: Vec<String>,
    pub year_candidates: Vec<YearCandidate>,
    /// Non-fatal extraction observations, deduplicated by their message.
    pub diagnostics: Vec<String>,
}

/// Probe all Symphonia metadata revisions (media and per-track) without decoding
/// audio. A successful probe with no usable tags returns `Metadata::default()`.
pub fn probe(path: &Path) -> Result<Metadata, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|error| error.to_string())?;

    let mut metadata = Metadata::default();
    let mut log = format.metadata();
    while let Some(revision) = log.current() {
        for tag in &revision.media.tags {
            collect_tag(tag, &mut metadata);
        }
        for track in &revision.per_track {
            for tag in &track.metadata.tags {
                collect_tag(tag, &mut metadata);
            }
        }
        if log.pop().is_none() {
            break;
        }
    }
    collect_wav_info_fallback(path, &mut metadata)?;
    Ok(metadata)
}

fn collect_tag(tag: &Tag, metadata: &mut Metadata) {
    let raw_key = tag.raw.key.clone();
    let raw_value = tag.raw.value.to_string();
    match &tag.std {
        Some(StandardTag::TrackTitle(value)) => {
            if let Some(value) = cleaned(value) {
                metadata.title = Some(value);
            }
        }
        Some(StandardTag::Artist(value)) => {
            if let Some(value) = cleaned(value) {
                metadata.artist = Some(value);
            }
        }
        Some(StandardTag::Genre(value)) => push_genre(metadata, value),
        _ => {
            if is_genre_key(&raw_key) {
                push_genre(metadata, &raw_value);
            }
        }
    }

    if let Some(semantic) = year_semantic(tag, &raw_key) {
        push_candidate(metadata, raw_key, raw_value, semantic);
    }
}

/// A defensive per-field budget. RIFF INFO text is ordinary metadata, never
/// audio payload; oversized in-bounds fields are skipped without failing a
/// probe, while malformed lengths still fail the probe.
const MAX_RIFF_INFO_VALUE_BYTES: u64 = 1024 * 1024;

/// Symphonia 0.6's `WavReader` parses local RIFF INFO but discards it when it
/// constructs the reader (`opts.external_data.metadata.unwrap_or_default()`).
/// Read the four documented fields directly as a narrow, read-only fallback.
fn collect_wav_info_fallback(path: &Path, metadata: &mut Metadata) -> Result<(), String> {
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("wav")) {
        return Ok(());
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 12];
    if file.read_exact(&mut header).is_err() || &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Ok(());
    }
    let riff_len = u64::from(u32::from_le_bytes(header[4..8].try_into().expect("four bytes")));
    let riff_end = 8_u64.checked_add(riff_len).ok_or("malformed RIFF size")?;
    if riff_end > file_len { return Err("malformed RIFF: declared size exceeds file".into()); }

    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            return Ok(());
        }
        let size = u64::from(u32::from_le_bytes(chunk[4..].try_into().expect("four bytes")));
        let chunk_start = file.stream_position().map_err(|error| error.to_string())?;
        let padded_size = size.checked_add(size % 2).ok_or("malformed RIFF chunk size")?;
        if !matches!(chunk_start.checked_add(padded_size), Some(end) if end <= riff_end) {
            return Err("malformed RIFF: chunk exceeds declared bounds".into());
        }
        if &chunk[..4] != b"LIST" || size < 4 {
            skip_riff_bytes(&mut file, size).map_err(|error| error.to_string())?;
            continue;
        }
        let mut form = [0_u8; 4];
        file.read_exact(&mut form).map_err(|_| "malformed RIFF LIST form")?;
        if &form != b"INFO" {
            skip_riff_bytes(&mut file, size - 4).map_err(|error| error.to_string())?;
            continue;
        }
        let mut remaining = size - 4;
        while remaining >= 8 {
            let mut field = [0_u8; 8];
            file.read_exact(&mut field).map_err(|_| "malformed RIFF INFO field")?;
            remaining -= 8;
            let value_len = u64::from(u32::from_le_bytes(field[4..].try_into().expect("four bytes")));
            let padding = value_len % 2;
            if !matches!(value_len.checked_add(padding), Some(len) if len <= remaining) {
                return Err("malformed RIFF INFO field length".into());
            }
            let key: &[u8; 4] = field[..4].try_into().expect("four bytes");
            if matches!(key, b"INAM" | b"IART" | b"ICRD" | b"IGNR") {
                if value_len > MAX_RIFF_INFO_VALUE_BYTES {
                    seek_riff_bytes(&mut file, value_len).map_err(|error| error.to_string())?;
                    diagnostic_once(metadata, format!("ignored oversized RIFF INFO value: {}", String::from_utf8_lossy(key)));
                    remaining -= value_len;
                    if padding == 1 {
                        file.seek(SeekFrom::Current(1)).map_err(|error| error.to_string())?;
                        remaining -= 1;
                    }
                    continue;
                }
                let value_len_usize = usize::try_from(value_len).map_err(|_| "RIFF INFO value too large")?;
                let mut value = vec![0_u8; value_len_usize];
                file.read_exact(&mut value).map_err(|_| "truncated RIFF INFO value")?;
                let value = String::from_utf8_lossy(&value);
                collect_riff_info(key, &value, metadata);
            } else {
                seek_riff_bytes(&mut file, value_len).map_err(|error| error.to_string())?;
            }
            remaining -= value_len;
            if padding == 1 {
                file.seek(SeekFrom::Current(1)).map_err(|error| error.to_string())?;
                remaining -= 1;
            }
        }
        if remaining != 0 { return Err("malformed RIFF INFO trailing bytes".into()); }
        return Ok(());
    }
}

fn skip_riff_bytes(file: &mut File, bytes: u64) -> std::io::Result<()> {
    let padded = bytes.checked_add(bytes % 2).ok_or_else(|| std::io::Error::other("RIFF chunk too large"))?;
    seek_riff_bytes(file, padded)
}

fn seek_riff_bytes(file: &mut File, bytes: u64) -> std::io::Result<()> {
    let offset = i64::try_from(bytes).map_err(|_| std::io::Error::other("RIFF chunk too large"))?;
    file.seek(SeekFrom::Current(offset)).map(|_| ())
}

fn collect_riff_info(key: &[u8; 4], value: &str, metadata: &mut Metadata) {
    let value = value.trim_matches('\0');
    match key {
        b"INAM" => if let Some(value) = cleaned(value) { metadata.title = Some(value) },
        b"IART" => if let Some(value) = cleaned(value) { metadata.artist = Some(value) },
        b"IGNR" => push_genre(metadata, value),
        b"ICRD" => push_candidate(metadata, "ICRD".into(), value.to_owned(), YearSemantic::Recording),
        _ => {}
    }
}

fn push_candidate(metadata: &mut Metadata, raw_key: String, raw_value: String, semantic: YearSemantic) {
    let candidate = YearCandidate::new(raw_key, raw_value, semantic);
    if !metadata.year_candidates.contains(&candidate) {
        metadata.year_candidates.push(candidate);
    }
}

fn cleaned(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

fn push_genre(metadata: &mut Metadata, value: &str) {
    match TrackTag::new(TagKind::Genre, value) {
        Ok(tag) => metadata.genres.push(tag.value),
        Err(_) => diagnostic_once(metadata, "ignored invalid genre value".into()),
    }
}

fn diagnostic_once(metadata: &mut Metadata, message: String) {
    if !metadata.diagnostics.iter().any(|diagnostic| diagnostic == &message) {
        metadata.diagnostics.push(message);
    }
}

fn is_genre_key(key: &str) -> bool {
    matches!(key.to_ascii_uppercase().as_str(), "TCON" | "GENRE" | "IGNR" | "©GEN")
}

fn year_semantic(tag: &Tag, raw_key: &str) -> Option<YearSemantic> {
    // Raw field semantics take precedence over Symphonia's convenient standard
    // mapping: DATE means generic for Vorbis, while an MP4 `©day` is release.
    // TDAT/TDA and TIME/TIM are explicitly not years even if a reader assigns
    // them a date-related StandardTag.
    match raw_key.to_ascii_uppercase().as_str() {
        "TDAT" | "TDA" | "TIME" | "TIM" | "IDIT" => return None,
        "TDRC" | "TYER" | "TYE" | "RECORDINGDATE" | "RECORDINGYEAR" | "ICRD" => {
            return Some(YearSemantic::Recording)
        }
        "DATE" | "YEAR" => return Some(YearSemantic::Generic),
        "TDRL" | "RELEASEDATE" | "RELEASEYEAR" | "©DAY" => {
            return Some(YearSemantic::Release)
        }
        "TDOR" | "TORY" | "TOR" | "ORIGINALDATE" | "ORIGINALYEAR" | "ORIGINALRECORDINGDATE" | "ORIGINALRECORDINGYEAR" => {
            return Some(YearSemantic::Original)
        }
        _ => {}
    }
    match tag.std.as_ref() {
        Some(StandardTag::RecordingDate(_))
        | Some(StandardTag::RecordingTime(_))
        | Some(StandardTag::RecordingYear(_)) => Some(YearSemantic::Recording),
        Some(StandardTag::ReleaseDate(_))
        | Some(StandardTag::ReleaseTime(_))
        | Some(StandardTag::ReleaseYear(_)) => Some(YearSemantic::Release),
        Some(StandardTag::OriginalRecordingDate(_))
        | Some(StandardTag::OriginalRecordingTime(_))
        | Some(StandardTag::OriginalRecordingYear(_))
        | Some(StandardTag::OriginalReleaseDate(_))
        | Some(StandardTag::OriginalReleaseTime(_))
        | Some(StandardTag::OriginalReleaseYear(_)) => Some(YearSemantic::Original),
        _ => None,
    }
}

/// Resolve production year with an injected clock. Release/original values are
/// preserved as candidates but never silently promoted to production years.
pub fn resolve_year(candidates: &[YearCandidate], current_year: u16) -> YearResolution {
    let production: Vec<_> = candidates
        .iter()
        .filter(|candidate| candidate.semantic.is_production_year())
        .cloned()
        .collect();
    if production.is_empty() {
        return YearResolution::Missing;
    }

    // `rank` is persisted for diagnostics, but resolution derives priority from
    // the semantic enum so malformed old data cannot elevate a release date.
    let best_rank = production.iter().map(|candidate| candidate.semantic.rank()).min().unwrap();
    let best_candidates: Vec<_> = production
        .into_iter()
        .filter(|candidate| candidate.semantic.rank() == best_rank)
        .collect();
    let best: Vec<_> = best_candidates
        .iter()
        .filter_map(|candidate| parse_year(&candidate.raw_value).map(|year| (candidate, year)))
        .collect();
    if best.len() != best_candidates.len() {
        return YearResolution::Invalid { candidates: best_candidates };
    }
    let values: Vec<u16> = best.iter().map(|(_, year)| *year).collect();
    if values.iter().any(|year| *year != values[0]) {
        return YearResolution::Conflict {
            candidates: best.into_iter().map(|(candidate, _)| candidate.clone()).collect(),
        };
    }
    if values[0] > current_year {
        return YearResolution::Future {
            candidates: best.into_iter().map(|(candidate, _)| candidate.clone()).collect(),
        };
    }
    YearResolution::Ready { year: best[0].1, semantic: best[0].0.semantic }
}

fn parse_year(value: &str) -> Option<u16> {
    let value = value.trim();
    let (date, has_time) = match value.split_once('T') {
        Some((date, time)) if valid_iso_time(time) => (date, true),
        Some(_) => return None,
        None => (value, false),
    };
    let mut parts = date.split('-');
    let year = parts.next()?;
    if year.len() != 4 || !year.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = year.parse::<u16>().ok()?;
    if year < 1000 {
        return None;
    }
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) if !has_time => Some(year),
        (Some(month), None, None) if !has_time && valid_month(month) => Some(year),
        (Some(month), Some(day), None) if valid_date(year, month, day) => Some(year),
        _ => None,
    }
}

fn valid_iso_time(value: &str) -> bool {
    let (time, offset) = if let Some(time) = value.strip_suffix('Z') {
        (time, None)
    } else if let Some(index) = value.char_indices().skip(1).find_map(|(index, ch)| {
        matches!(ch, '+' | '-').then_some(index)
    }) {
        (&value[..index], Some(&value[index..]))
    } else {
        (value, None)
    };
    if let Some(offset) = offset {
        if !offset.is_ascii() {
            return false;
        }
        let Some((sign, offset)) = offset.chars().next().map(|sign| (sign, &offset[1..])) else {
            return false;
        };
        if !matches!(sign, '+' | '-') || offset.len() != 5 || &offset[2..3] != ":"
            || !valid_range(&offset[..2], 0, 23) || !valid_range(&offset[3..], 0, 59)
        {
            return false;
        }
    }
    let mut parts = time.split(':');
    let Some(hour) = parts.next() else { return false };
    if !valid_range(hour, 0, 23) {
        return false;
    }
    let Some(minute) = parts.next() else { return true };
    if !valid_range(minute, 0, 59) { return false; }
    match parts.next() {
        None => true,
        Some(second) => {
            let (second, fraction) = second.split_once('.').map_or((second, None), |(second, fraction)| {
                (second, Some(fraction))
            });
            valid_range(second, 0, 59)
                && (match fraction {
                    None => true,
                    Some(fraction) => !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()),
                })
                && parts.next().is_none()
        }
    }
}

fn valid_month(value: &str) -> bool { valid_range(value, 1, 12) }
fn valid_range(value: &str, min: u8, max: u8) -> bool {
    value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u8>().is_ok_and(|value| (min..=max).contains(&value))
}
fn valid_date(year: u16, month: &str, day: &str) -> bool {
    if !valid_month(month) || !valid_range(day, 1, 31) {
        return false;
    }
    let month = month.parse::<u8>().expect("validated month");
    let day = day.parse::<u8>().expect("validated day");
    let max_day = match month {
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= max_day
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Arc};

    fn candidate(value: &str, semantic: YearSemantic) -> YearCandidate {
        YearCandidate::new("DATE".into(), value.into(), semantic)
    }

    #[test]
    fn strict_year_syntax_rejects_id3_partial_dates_and_bad_calendar_dates() {
        assert_eq!(parse_year("2024"), Some(2024));
        assert_eq!(parse_year("2024-02-29T23:59:59Z"), Some(2024));
        assert_eq!(parse_year("2024-02-29T23"), Some(2024));
        assert_eq!(parse_year("2023-02-29"), None);
        assert_eq!(parse_year("1806"), Some(1806)); // only a permitted year key decides this.
        assert_eq!(parse_year("2024-13"), None);
        assert_eq!(parse_year("2024-01-01T24:00"), None);
        assert_eq!(parse_year("2024T12:00"), None);
        assert_eq!(parse_year("2024-01-01T12+あ:a"), None);
    }

    #[test]
    fn only_recording_and_generic_candidates_can_resolve_production_year() {
        assert_eq!(resolve_year(&[candidate("1999", YearSemantic::Release)], 2026), YearResolution::Missing);
        assert_eq!(resolve_year(&[candidate("2000", YearSemantic::Original)], 2026), YearResolution::Missing);
        assert_eq!(
            resolve_year(&[candidate("2024", YearSemantic::Recording)], 2026),
            YearResolution::Ready { year: 2024, semantic: YearSemantic::Recording }
        );
    }

    #[test]
    fn future_conflict_and_invalid_are_distinct() {
        assert!(matches!(resolve_year(&[candidate("2027", YearSemantic::Recording)], 2026), YearResolution::Future { .. }));
        assert!(matches!(resolve_year(&[candidate("bad", YearSemantic::Recording)], 2026), YearResolution::Invalid { .. }));
        assert!(matches!(
            resolve_year(&[candidate("2023", YearSemantic::Recording), candidate("2024", YearSemantic::Recording)], 2026),
            YearResolution::Conflict { .. }
        ));
    }

    #[test]
    fn time_and_partial_date_keys_are_not_year_keys() {
        let time = Tag::new_from_parts(
            "TIME",
            "2024",
            Some(StandardTag::RecordingDate(Arc::new("2024".into()))),
        );
        let date = Tag::new_from_parts("TDAT", "1806", None);
        let digitized = Tag::new_from_parts(
            "IDIT",
            "2024",
            Some(StandardTag::RecordingDate(Arc::new("2024".into()))),
        );
        assert_eq!(year_semantic(&time, &time.raw.key), None);
        assert_eq!(year_semantic(&date, &date.raw.key), None);
        assert_eq!(year_semantic(&digitized, &digitized.raw.key), None);
    }

    #[test]
    fn raw_date_meaning_overrides_a_reader_release_mapping() {
        let date = Tag::new_from_parts(
            "DATE",
            "2024",
            Some(StandardTag::ReleaseDate(Arc::new("2024".into()))),
        );
        assert_eq!(year_semantic(&date, &date.raw.key), Some(YearSemantic::Generic));
    }

    #[test]
    fn real_synthetic_fixtures_probe_without_writing_bytes_or_mtime() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/metadata");
        for (name, title) in [
            ("id3v23.mp3", "Synthetic 3"),
            ("id3v24.mp3", "Synthetic 4"),
            ("vorbis.flac", "Synthetic FLAC"),
            ("vorbis.ogg", "Synthetic Ogg"),
            ("release-only.m4a", "Synthetic M4A"),
            ("riff-info.wav", "Synthetic WAV"),
        ] {
            let path = fixtures.join(name);
            let before_bytes = fs::read(&path).unwrap();
            let before_mtime = fs::metadata(&path).unwrap().modified().unwrap();
            let metadata = probe(&path).unwrap();
            assert_eq!(metadata.title.as_deref(), Some(title), "{name}");
            assert_eq!(metadata.artist.as_deref(), Some("Fixture Artist"), "{name}");
            assert_eq!(fs::read(&path).unwrap(), before_bytes, "{name}");
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before_mtime, "{name}");
        }
    }

    #[test]
    fn synthetic_fixture_year_states_and_repeated_genres_are_observable() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/metadata");
        let flac = probe(&fixtures.join("vorbis.flac")).unwrap();
        assert_eq!(flac.genres, vec!["Funkot", "Breakbeat"]);
        assert!(matches!(resolve_year(&flac.year_candidates, 2026), YearResolution::Ready { year: 2024, .. }));
        assert!(matches!(resolve_year(&probe(&fixtures.join("future.mp3")).unwrap().year_candidates, 2026), YearResolution::Future { .. }));
        assert!(matches!(resolve_year(&probe(&fixtures.join("invalid.flac")).unwrap().year_candidates, 2026), YearResolution::Invalid { .. }));
        assert!(matches!(resolve_year(&probe(&fixtures.join("conflicting.flac")).unwrap().year_candidates, 2026), YearResolution::Conflict { .. }));
        assert_eq!(resolve_year(&probe(&fixtures.join("release-only.m4a")).unwrap().year_candidates, 2026), YearResolution::Missing);
        assert_eq!(resolve_year(&probe(&fixtures.join("original-only.mp3")).unwrap().year_candidates, 2026), YearResolution::Missing);
        assert_eq!(resolve_year(&probe(&fixtures.join("id3-time-only.mp3")).unwrap().year_candidates, 2026), YearResolution::Missing);
        assert_eq!(probe(&fixtures.join("tagless.wav")).unwrap(), Metadata::default());
    }

    #[test]
    fn malformed_riff_info_length_is_an_error_before_any_large_allocation() {
        let path = std::env::temp_dir().join(format!("funkot-malformed-riff-info-{}.wav", std::process::id()));
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&24_u32.to_le_bytes()); // file length is 8 + 24.
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"LIST");
        bytes.extend_from_slice(&12_u32.to_le_bytes());
        bytes.extend_from_slice(b"INFOINAM");
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let mut metadata = Metadata::default();
        let result = collect_wav_info_fallback(&path, &mut metadata);
        fs::remove_file(&path).unwrap();
        assert!(matches!(result, Err(ref error) if error.contains("field length")), "{result:?}");
        assert_eq!(metadata, Metadata::default());
    }

    #[test]
    fn in_bounds_oversized_riff_title_and_date_are_skipped_with_diagnostics() {
        let path = std::env::temp_dir().join(format!("funkot-oversized-riff-info-{}.wav", std::process::id()));
        let value_len = (MAX_RIFF_INFO_VALUE_BYTES + 1) as u32;
        let value = vec![b'x'; value_len as usize];
        let list_size = 4_u64 + 8 + u64::from(value_len) + (u64::from(value_len) % 2) + 8 + u64::from(value_len) + (u64::from(value_len) % 2);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"LIST");
        bytes.extend_from_slice(&(list_size as u32).to_le_bytes());
        bytes.extend_from_slice(b"INFO");
        for key in [b"INAM", b"ICRD"] {
            bytes.extend_from_slice(key);
            bytes.extend_from_slice(&value_len.to_le_bytes());
            bytes.extend_from_slice(&value);
            if value_len % 2 == 1 { bytes.push(0); }
        }
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        let mut metadata = Metadata::default();
        let result = collect_wav_info_fallback(&path, &mut metadata);
        fs::remove_file(&path).unwrap();
        assert_eq!(result, Ok(()));
        assert_eq!(metadata.title, None);
        assert!(metadata.year_candidates.is_empty());
        assert!(metadata.diagnostics.iter().any(|message| message.contains("INAM")));
        assert!(metadata.diagnostics.iter().any(|message| message.contains("ICRD")));
    }

    #[test]
    fn invalid_genre_does_not_discard_valid_sibling_or_normalized_metadata() {
        let mut metadata = Metadata::default();
        collect_riff_info(b"INAM", "  Metadata title\0", &mut metadata);
        push_genre(&mut metadata, "\0invalid");
        push_genre(&mut metadata, "  e\u{301}  ");
        push_genre(&mut metadata, "Funkot");
        push_genre(&mut metadata, &"x".repeat(129));
        push_genre(&mut metadata, &format!("  {}  ", "e\u{301}".repeat(128)));
        assert_eq!(metadata.title.as_deref(), Some("Metadata title"));
        assert_eq!(metadata.genres, vec!["é".into(), "Funkot".into(), "é".repeat(128)]);
        assert_eq!(metadata.diagnostics, vec!["ignored invalid genre value"]);
    }
}
