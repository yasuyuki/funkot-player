use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let production = manifest.join("../../src-tauri/src/output_guard.rs");
    let allow = std::env::var("OUTPUT_GUARD_ALLOW_SUBSTITUTE").ok().as_deref() == Some("1");
    let source = match std::env::var("OUTPUT_GUARD_RS") {
        Ok(path) if allow => PathBuf::from(path),
        Ok(_) => panic!("OUTPUT_GUARD_RS requires OUTPUT_GUARD_ALLOW_SUBSTITUTE=1"),
        Err(_) => production,
    };
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=OUTPUT_GUARD_RS");
    println!("cargo:rerun-if-env-changed=OUTPUT_GUARD_ALLOW_SUBSTITUTE");
    println!("cargo:warning=guard-source={}", source.display());
    let text = std::fs::read_to_string(&source)
        .unwrap_or_else(|error| panic!("read {}: {error}", source.display()));
    let marker = "\n#[cfg(test)]\n";
    let logic = text.find(marker).map(|at| &text[..at]).unwrap_or(text.as_str());
    // include! does not accept the production module's inner docs.
    let logic = logic.replace("//!", "//");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("output_guard.rs");
    std::fs::write(out, logic).unwrap();
}
