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
    let git_dir = autodj_dir.join(".git");
    let head_path = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head_path.display());

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

    if let Ok(head) = std::fs::read_to_string(&head_path) {
        let head = head.trim();
        if let Some(ref_name) = head.strip_prefix("ref: ") {
            let ref_path = git_dir.join(ref_name.trim());
            println!("cargo:rerun-if-changed={}", ref_path.display());
        }
    }

    let git_sha = git_sha.unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=FUNKOT_CORE_GIT={git_sha}");
}
