fn main() {
    link_clang_runtime_on_macos();
    tauri_build::build()
}

/// llama.cpp's Metal backend uses `@available(...)`, which clang compiles into a
/// call to `__isPlatformVersionAtLeast`. That symbol lives in clang's runtime
/// library, which rustc does not link (it passes `-nodefaultlibs`). Recent Rust
/// toolchains ship their own copy in `std`, so a current `stable` links fine —
/// but an older one fails with "Undefined symbols: ___isPlatformVersionAtLeast".
///
/// Linking `libclang_rt.osx.a` covers both: it is a static archive, so the
/// linker only takes the member from it when nothing else has defined the
/// symbol already. Skipped quietly when the library cannot be found, which
/// leaves a current toolchain exactly where it was.
fn link_clang_runtime_on_macos() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let resource_dir = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let archive = std::path::Path::new(&resource_dir)
        .join("lib")
        .join("darwin")
        .join("libclang_rt.osx.a");
    if archive.is_file() {
        // Handed to the linker as a plain archive rather than through
        // `rustc-link-lib`, so it is not bundled into the library's rlib.
        println!("cargo:rustc-link-arg={}", archive.display());
    }
}
