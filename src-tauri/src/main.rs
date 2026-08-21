// Hide the extra console window on Windows release builds. Dev builds keep
// the console so env_logger / panic output stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point; Android enters through tauri::mobile_entry_point in lib.rs.
fn main() {
    funkot_player_lib::run()
}
