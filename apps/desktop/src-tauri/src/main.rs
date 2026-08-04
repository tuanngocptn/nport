//! The desktop binary. Everything lives in the library so tests and the mobile targets can link it.

// Without this a release build on Windows opens a console window behind the app. The `debug_assertions`
// guard keeps `println!` visible while developing, which is the only time anyone wants that console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nport_desktop_lib::run();
}
