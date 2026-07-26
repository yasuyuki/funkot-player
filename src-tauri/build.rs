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
    tauri_build::build()
}
