use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Manager;

pub(super) struct Control {
    input: PathBuf,
    capture: PathBuf,
    data: PathBuf,
    deadline: Instant,
}

fn verified_identifier(actual: &str, expected: &str) -> bool {
    actual == expected
        && actual.rsplit_once(".verified").is_some_and(|(base, suffix)| {
            !base.is_empty() && suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn regular_control(path: &Path, expected: &[u8]) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || std::fs::read(path).map_err(|e| e.to_string())? != expected {
        return Err("invalid capture control file".into());
    }
    Ok(true)
}

pub(super) fn prepare(app: &tauri::AppHandle) -> Result<Option<Control>, String> {
    let Some(input) = std::env::var_os("FUNKOT_NAVIGATION_AUTOMATION_INPUT_DIR") else { return Ok(None); };
    if std::env::var("FUNKOT_NAVIGATION_REQUIRE_START_SIGNAL").as_deref() != Ok("1")
        || std::env::var("FUNKOT_NAVIGATION_SILENT_RENDER").as_deref() != Ok("1") {
        return Err("automated capture requires silent render and START authorization".into());
    }
    let expected = std::env::var("FUNKOT_NAVIGATION_AUTOMATION_APP_ID").map_err(|_| "missing automated capture identifier")?;
    if !verified_identifier(&app.config().identifier, &expected) { return Err("automated capture requires a verified isolated identifier".into()); }
    let capture = std::fs::canonicalize(std::env::var_os("FUNKOT_NAVIGATION_CAPTURE_DIR").ok_or("missing capture directory")?).map_err(|e| e.to_string())?;
    let input = std::fs::canonicalize(input).map_err(|e| e.to_string())?;
    if !input.is_dir() || !capture.is_dir() { return Err("capture and input must be directories".into()); }
    let entries = std::fs::read_dir(&input).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if entries.len() != 2 || entries.iter().any(|entry| entry.file_type().map_or(true, |kind| !kind.is_file() || kind.is_symlink())) {
        return Err("automated capture requires exactly two regular input files".into());
    }
    for name in ["START.json", "NEXT", "STOP", "QUIT", "navigation-complete.json"] {
        if capture.join(name).exists() { return Err("capture control already exists".into()); }
    }
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if data.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) || data.exists() {
        return Err("automated capture profile is not fresh and isolated".into());
    }
    let milliseconds = std::env::var("FUNKOT_NAVIGATION_AUTOMATION_TIMEOUT_MS").map_err(|_| "missing capture deadline")?
        .parse::<u64>().map_err(|_| "invalid capture deadline")?;
    if milliseconds == 0 { return Err("invalid capture deadline".into()); }
    let deadline = Instant::now().checked_add(Duration::from_millis(milliseconds)).ok_or("invalid capture deadline")?;
    Ok(Some(Control { input, capture, data, deadline }))
}

pub(super) fn start(app: tauri::AppHandle, control: Control) -> Result<(), String> {
    std::thread::Builder::new().name("verified-capture-control".into()).spawn(move || {
        if let Err(error) = run(&app, &control) {
            eprintln!("verified capture control: {error}");
            app.exit(1);
        }
    }).map_err(|error| error.to_string())?;
    Ok(())
}

fn run(app: &tauri::AppHandle, control: &Control) -> Result<(), String> {
    super::inspect_picked_music_dir(&control.input, &control.data).map_err(str::to_owned)?;
    super::store_picked_music_dir(&control.data, &control.input)?;
    let cache = control.data.join("funkot-cache");
    let input = control.input.to_str().ok_or("input path is not Unicode")?;
    let cache = cache.to_str().ok_or("cache path is not Unicode")?;
    super::start_impl(input, cache, app, &app.state::<super::AppState>(), false)?;
    let mut next_sent = false;
    while Instant::now() < control.deadline {
        let next = regular_control(&control.capture.join("NEXT"), b"next")?;
        let quit = regular_control(&control.capture.join("QUIT"), b"quit")?;
        let started = control.capture.join("START.json").is_file();
        let complete = control.capture.join("navigation-complete.json").is_file();
        if next && !started { return Err("NEXT preceded START".into()); }
        if quit && (!next_sent || !complete) { return Err("QUIT preceded completed capture".into()); }
        if next && !next_sent && super::NEXT_PREPARED.load(std::sync::atomic::Ordering::Acquire)
            && super::MAIN_FRAMES.load(std::sync::atomic::Ordering::Acquire) > 0 {
            super::request_skip_next()?;
            next_sent = true;
        }
        if quit { app.exit(0); return Ok(()); }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("automated capture deadline expired".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_requires_exact_fresh_identifier() {
        let id = "jp.example.verified0123456789abcdef0123456789abcdef";
        assert!(verified_identifier(id, id));
        assert!(!verified_identifier("jp.example", "jp.example"));
        assert!(!verified_identifier(id, "jp.example"));
        assert!(!verified_identifier("jp.example.verifiedno", "jp.example.verifiedno"));
    }

    #[test]
    fn controls_require_exact_regular_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("NEXT");
        assert!(!regular_control(&file, b"next").unwrap());
        std::fs::write(&file, b"next").unwrap();
        assert!(regular_control(&file, b"next").unwrap());
        std::fs::write(&file, b"other").unwrap();
        assert!(regular_control(&file, b"next").is_err());
    }
}
