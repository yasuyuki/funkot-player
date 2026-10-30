use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};
use crate::playlists::{Catalog, PlaylistStore, TrackRef};

#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    pub file: PathBuf,
    pub sha256: String,
}

#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Plan {
    pub schema: u32,
    pub run_token: String,
    pub cycle: u64,
    pub inputs: [Input; 2],
    pub occurrences: [usize; 3],
}

pub(super) struct Cycle {
    pub plan: Plan,
    pub plan_sha256: String,
    pub playlist_id: String,
    pub entry_ids: Vec<String>,
    seen: Vec<String>,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut hash = Sha256::new();
    std::io::copy(&mut File::open(path).map_err(|e| e.to_string())?, &mut hash).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    if std::fs::read(path).map_err(|e| e.to_string())? != bytes { return Err("cycle receipt read-back failed".into()); }
    Ok(())
}

pub(super) fn prepare(plan_path: &Path, capture: &Path, input: &Path, data: &Path) -> Result<Cycle, String> {
    let plan_path = std::fs::canonicalize(plan_path).map_err(|e| e.to_string())?;
    if plan_path.parent() != Some(capture) || plan_path.file_name().and_then(|s| s.to_str()) != Some("cycle-plan.json") {
        return Err("cycle plan must belong to this capture".into());
    }
    let bytes = std::fs::read(&plan_path).map_err(|e| e.to_string())?;
    let plan: Plan = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate(&plan, input)?;
    let owner = data.join("diagnostic-cycle-owner.json");
    if data.exists() {
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&owner).map_err(|_| "cycle profile owner is missing")?)
            .map_err(|_| "cycle profile owner is invalid")?;
        if saved != serde_json::json!({ "run_token": plan.run_token }) { return Err("cycle profile has a different owner".into()); }
    } else {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        write_json(&owner, &serde_json::json!({ "run_token": plan.run_token }))?;
    }
    let store = PlaylistStore::load(data);
    let mut catalog = Catalog::default();
    let tracks = plan.occurrences.iter().map(|&index| {
        Ok(TrackRef {
            content_hash: funkot_core::cache::content_hash(&plan.inputs[index].file).map_err(|e| e.to_string())?,
            preferred_path: std::fs::canonicalize(&plan.inputs[index].file).map_err(|e| e.to_string())?,
            title: String::new(), artist: String::new(),
        })
    }).collect::<Result<Vec<_>, String>>()?;
    let playlist_id = catalog.create("Diagnostic A-B180-A", tracks).map_err(|e| format!("{e:?}"))?;
    catalog.select(Some(playlist_id.clone())).map_err(|e| format!("{e:?}"))?;
    store.persist(&catalog).map_err(|e| format!("cycle playlist persistence failed: {e:?}"))?;
    if store.reload().map_err(|e| format!("{e:?}"))? != catalog { return Err("cycle playlist read-back failed".into()); }
    let entry_ids = catalog.definition(&playlist_id).map_err(|e| format!("{e:?}"))?.entries.iter().map(|e| e.entry_id.clone()).collect();
    Ok(Cycle { plan, plan_sha256: format!("{:x}", Sha256::digest(bytes)), playlist_id, entry_ids, seen: Vec::new() })
}

fn validate(plan: &Plan, input: &Path) -> Result<(), String> {
    if plan.schema != 1 || plan.cycle == 0 || !hex(&plan.run_token, 32) || plan.occurrences != [0, 1, 0] {
        return Err("invalid finite A-B180-A cycle plan".into());
    }
    for item in &plan.inputs {
        let metadata = std::fs::symlink_metadata(&item.file).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || !hex(&item.sha256, 64) ||
            std::fs::canonicalize(&item.file).map_err(|e| e.to_string())?.parent() != Some(input) || hash_file(&item.file)? != item.sha256 {
            return Err("cycle input does not match its fixed source".into());
        }
    }
    if plan.inputs[0].file == plan.inputs[1].file || plan.inputs[0].sha256 == plan.inputs[1].sha256 {
        return Err("cycle requires distinct A and B180 sources".into());
    }
    Ok(())
}

impl Cycle {
    pub fn observe(&mut self, details: &crate::playlist_service::Details, data: &Path) -> Result<bool, String> {
        if details.id != self.playlist_id || details.run_id != 0 || details.total != 3 || details.skipped != 0 ||
            details.rows.len() != 3 || details.rows.iter().zip(&self.entry_ids).any(|(row, id)| &row.entry_id != id || row.reason.is_some()) {
            return Err("cycle source occurrence changed or failed".into());
        }
        if let Some(current) = details.rows.iter().find(|row| row.status == "current") {
            if self.seen.last() != Some(&current.entry_id) {
                if self.entry_ids.get(self.seen.len()) != Some(&current.entry_id) { return Err("cycle occurrence order is incomplete".into()); }
                self.seen.push(current.entry_id.clone());
            }
        }
        if !details.ended { return Ok(false); }
        if self.seen != self.entry_ids || details.rows.iter().any(|row| row.status != "played") {
            return Err("cycle natural end lacks all three played occurrences".into());
        }
        let saved = PlaylistStore::load(data).reload().map_err(|e| format!("{e:?}"))?;
        let run = saved.run(&self.playlist_id).map_err(|e| format!("{e:?}"))?;
        if saved.active_id.as_ref() != Some(&self.playlist_id) || saved.current.is_some() || run.run_id != 0 ||
            !run.failures.is_empty() || run.consumed.iter().cloned().collect::<std::collections::BTreeSet<_>>() != self.entry_ids.iter().cloned().collect() {
            return Err("cycle natural end is not durably recorded".into());
        }
        Ok(true)
    }

    pub fn receipt(&self, cancelled: bool) -> serde_json::Value {
        serde_json::json!({ "schema": 1, "cycle": self.plan.cycle, "plan_sha256": self.plan_sha256,
            "process_id": std::process::id(), "playlist_id": self.playlist_id, "playlist_run_id": 0,
            "natural_end": !cancelled, "cancelled": cancelled, "output_closed": true, "observed_entries": self.seen,
            "occurrences": self.entry_ids.iter().enumerate().map(|(ordinal, id)| serde_json::json!({
                "ordinal": ordinal, "entry_id": id, "sha256": self.plan.inputs[self.plan.occurrences[ordinal]].sha256,
                "status": if cancelled { "incomplete" } else { "played" }
            })).collect::<Vec<_>>() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let input = root.join("inputs");
        let capture = root.join("capture");
        std::fs::create_dir(&input).unwrap();
        std::fs::create_dir(&capture).unwrap();
        let input = std::fs::canonicalize(input).unwrap();
        let capture = std::fs::canonicalize(capture).unwrap();
        let a = input.join("A.wav");
        let b = input.join("B180.wav");
        std::fs::write(&a, b"fixed synthetic A").unwrap();
        std::fs::write(&b, b"fixed synthetic B180").unwrap();
        write_json(&capture.join("cycle-plan.json"), &serde_json::json!({
            "schema": 1, "cycle": 1, "run_token": "0123456789abcdef0123456789abcdef",
            "inputs": [{ "file": a, "sha256": hash_file(&a).unwrap() }, { "file": b, "sha256": hash_file(&b).unwrap() }],
            "occurrences": [0, 1, 0]
        })).unwrap();
        (input, capture, root.join("isolated-profile"))
    }

    fn details(cycle: &Cycle, current: Option<usize>, ended: bool) -> crate::playlist_service::Details {
        crate::playlist_service::Details {
            id: cycle.playlist_id.clone(), name: "Diagnostic A-B180-A".into(), revision: 0, run_id: 0,
            total: 3, ended, skipped: 0, rows: cycle.entry_ids.iter().enumerate().map(|(index, id)| crate::playlist_service::EntryView {
                entry_id: id.clone(), path: cycle.plan.inputs[cycle.plan.occurrences[index]].file.to_string_lossy().into(),
                title: String::new(), artist: String::new(), status: if ended || current.is_some_and(|i| index < i) { "played" }
                    else if current == Some(index) { "current" } else { "pending" }.into(), reason: None,
            }).collect(),
        }
    }

    #[test]
    fn finite_source_keeps_duplicate_a_as_distinct_persisted_occurrences() {
        let root = tempfile::tempdir().unwrap();
        let (input, capture, data) = fixture(root.path());
        let cycle = prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).unwrap();
        assert_eq!(cycle.entry_ids.len(), 3);
        assert_ne!(cycle.entry_ids[0], cycle.entry_ids[2]);
        let catalog = PlaylistStore::load(&data).reload().unwrap();
        let entries = &catalog.definition(&cycle.playlist_id).unwrap().entries;
        assert_eq!(entries[0].track, entries[2].track);
        assert_eq!(entries[0].track.preferred_path, std::fs::canonicalize(&cycle.plan.inputs[0].file).unwrap());
        assert_eq!(entries[0].track.content_hash, funkot_core::cache::content_hash(&cycle.plan.inputs[0].file).unwrap());
        assert_ne!(entries[0].track.content_hash, cycle.plan.inputs[0].sha256);
        assert_ne!(entries[0].track, entries[1].track);
        assert_eq!(catalog.active_id, Some(cycle.playlist_id));
    }

    #[test]
    fn natural_end_requires_observed_order_and_durable_progress() {
        let root = tempfile::tempdir().unwrap();
        let (input, capture, data) = fixture(root.path());
        let mut cycle = prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).unwrap();
        for index in 0..3 {
            assert!(!cycle.observe(&details(&cycle, Some(index), false), &data).unwrap());
        }
        assert!(cycle.observe(&details(&cycle, None, true), &data).is_err());
        let store = PlaylistStore::load(&data);
        let mut saved = store.reload().unwrap();
        saved.runs.get_mut(&cycle.playlist_id).unwrap().consumed = cycle.entry_ids.iter().cloned().collect();
        store.persist(&saved).unwrap();
        assert!(cycle.observe(&details(&cycle, None, true), &data).unwrap());
        assert_eq!(cycle.receipt(false)["natural_end"], true);
        assert_eq!(cycle.receipt(true)["natural_end"], false);
        let mut missing = prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).unwrap();
        assert!(missing.observe(&details(&missing, Some(1), false), &data).is_err());
    }

    #[test]
    fn changed_input_owner_or_persistence_never_prepares_a_cycle() {
        let root = tempfile::tempdir().unwrap();
        let (input, capture, data) = fixture(root.path());
        crate::playback_state::set_fail_persist_stage(1);
        assert!(prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).is_err());
        assert!(prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).is_ok());
        std::fs::write(data.join("diagnostic-cycle-owner.json"), b"{}").unwrap();
        assert!(prepare(&capture.join("cycle-plan.json"), &capture, &input, &data).is_err());
        let other = root.path().join("other-profile");
        std::fs::write(input.join("A.wav"), b"changed synthetic A").unwrap();
        assert!(prepare(&capture.join("cycle-plan.json"), &capture, &input, &other).is_err());
        assert!(!other.exists());
    }
}
