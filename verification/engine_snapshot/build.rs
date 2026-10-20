use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let production = manifest.join("../../src-tauri/src/engine_observation.rs");
    let allow = std::env::var("ENGINE_OBSERVATION_ALLOW_SUBSTITUTE").ok().as_deref() == Some("1");
    let source = match std::env::var("ENGINE_OBSERVATION_RS") {
        Ok(path) if allow => PathBuf::from(path),
        Ok(_) => panic!("ENGINE_OBSERVATION_RS requires ENGINE_OBSERVATION_ALLOW_SUBSTITUTE=1"),
        Err(_) => production,
    };
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=ENGINE_OBSERVATION_RS");
    println!("cargo:rerun-if-env-changed=ENGINE_OBSERVATION_ALLOW_SUBSTITUTE");
    println!("cargo:warning=observation-source={}", source.display());
    let text = std::fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("read {}: {error}", source.display()));
    let import = "use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};";
    let loom_import = "use loom::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};";
    let swapped = text.replacen(import, loom_import, 1);
    assert_ne!(swapped, text, "production atomic import changed; the Loom substitution no longer matches");
    assert!(!swapped.contains("std::sync::atomic"), "observation code uses atomics outside the substituted import");
    for forbidden in ["Relaxed", "Acquire", "Release", "AcqRel", "compare_exchange", "fetch_or", "fetch_and"] {
        assert!(!swapped.contains(forbidden), "unsupported atomic operation {forbidden}");
    }
    let marker = "\n#[cfg(test)]\n";
    let logic = swapped.find(marker).map(|at| &swapped[..at]).unwrap_or(swapped.as_str());
    // include! does not accept the production module's inner docs.
    let logic = logic.replace("//!", "//");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("engine_observation.rs");
    std::fs::write(out, logic).unwrap();
}
