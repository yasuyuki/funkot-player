use std::path::Path;
use std::process::Command;

fn main() {
    // Android 15+ rejects native libraries that are not 16 KB page aligned
    // (the device shows a compatibility dialog on launch). Emitted here rather
    // than through CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS because the
    // Tauri CLI sets that variable itself, and cargo lets the env var replace
    // config rustflags rather than merge with them. A link-arg from build.rs is
    // additive, so it survives whatever Tauri passes.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    println!("cargo:rerun-if-env-changed=FUNKOT_CORE_CANDIDATE_SHA");
    emit_funkot_build_env();
    tauri_build::build()
}

fn parse_version_code(version: &str) -> u32 {
    let mut parts = version.split('.');
    let major = parts.next().and_then(|s| s.parse::<u32>().ok());
    let minor = parts.next().and_then(|s| s.parse::<u32>().ok());
    let patch = parts.next().and_then(|s| s.parse::<u32>().ok());
    match (major, minor, patch) {
        (Some(major), Some(minor), Some(patch)) => {
            major.saturating_mul(1_000_000)
                + minor.saturating_mul(1_000)
                + patch
        }
        _ => 1,
    }
}

fn emit_funkot_build_env() {
    let version_name =
        std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".to_string());
    println!("cargo:rustc-env=FUNKOT_VERSION_NAME={version_name}");
    println!(
        "cargo:rustc-env=FUNKOT_VERSION_CODE={}",
        parse_version_code(&version_name)
    );

    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set");
    let autodj_dir = Path::new(&manifest_dir).join("../../funkot-autodj-for-ui");
    println!("cargo:rerun-if-changed={}", autodj_dir.display());
    let player_dir = Path::new(&manifest_dir).join("..");
    let pin_path = player_dir.join("funkot-core.commit");
    println!("cargo:rerun-if-changed={}", pin_path.display());
    let git_path = |name: &str| {
        Command::new("git")
            .args([
                "-C",
                autodj_dir
                    .to_str()
                    .expect("funkot-autodj-for-ui path must be UTF-8"),
                "rev-parse",
                "--git-path",
                name,
            ])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|path| autodj_dir.join(path.trim()))
    };
    if let Some(path) = git_path("HEAD") {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    if let Some(path) = git_path("index") {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let git_sha = Command::new("git")
        .args([
            "-C",
            autodj_dir
                .to_str()
                .expect("funkot-autodj-for-ui path must be UTF-8"),
            "rev-parse",
            "HEAD",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8(output.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty());

    if let Some(head_path) = git_path("HEAD") {
        if let Ok(head) = std::fs::read_to_string(&head_path) {
            let head = head.trim();
            if let Some(ref_name) = head.strip_prefix("ref: ") {
                if let Some(ref_path) = git_path(ref_name.trim()) {
                    println!("cargo:rerun-if-changed={}", ref_path.display());
                }
            }
        }
    }

    let git_sha = git_sha.unwrap_or_else(|| "unknown".to_string());
    let core_dirty = Command::new("git")
        .args([
            "-C",
            autodj_dir
                .to_str()
                .expect("funkot-autodj-for-ui path must be UTF-8"),
            "status",
            "--porcelain",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(true);
    if core_dirty {
        panic!("funkot-core checkout is dirty; builds must use a clean commit");
    }
    let pin = std::fs::read_to_string(&pin_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", pin_path.display()));
    let pin = pin.trim();
    if !is_lowercase_git_sha(pin) {
        panic!("tracked funkot-core SHA must be a lowercase 40-character commit ID");
    }
    let candidate = std::env::var("FUNKOT_CORE_CANDIDATE_SHA")
        .ok()
        .filter(|candidate| !candidate.is_empty());
    let expected = candidate.as_deref().unwrap_or(pin);
    let mode = if candidate.is_some() {
        "candidate"
    } else {
        "official"
    };
    if !is_lowercase_git_sha(expected) {
        panic!("{mode} funkot-core SHA must be a lowercase 40-character commit ID");
    }
    if git_sha != expected {
        panic!("{mode} funkot-core SHA is {git_sha}, expected {expected}");
    }
    println!("cargo:rustc-env=FUNKOT_CORE_GIT={git_sha}");
}

fn is_lowercase_git_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
