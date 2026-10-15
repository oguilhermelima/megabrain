mod common;

use common::{executable, Scratch};
use megabrain_desktop_lib::path_link::{inspect, link, LinkKind};
use std::os::unix::fs::symlink;

struct Setup {
    _scratch: Scratch,
    home: std::path::PathBuf,
    bundled: std::path::PathBuf,
    bin: std::path::PathBuf,
}

fn setup(name: &str) -> Setup {
    let scratch = Scratch::new(name);
    let home = scratch.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let bundled = scratch.path().join("megabrain.app/Contents/MacOS/megabrain-cli");
    executable(&bundled);
    let bin = home.join(".local/bin");
    Setup { home, bundled, bin, _scratch: scratch }
}

fn path_with(dirs: &[&std::path::Path]) -> String {
    dirs.iter().map(|dir| dir.display().to_string()).collect::<Vec<_>>().join(":")
}

#[test]
fn missing_link_is_reported_and_created_with_its_directory() {
    let s = setup("missing");
    let path = path_with(&[&s.bin, std::path::Path::new("/usr/bin")]);
    let state = inspect(&s.home, &path, &s.bundled);
    assert_eq!(state.kind, LinkKind::Missing);
    assert_eq!(state.link_path, s.bin.join("megabrain").display().to_string());
    assert!(state.dir_on_path);

    let linked = link(&s.home, &path, &s.bundled, false).unwrap();
    assert_eq!(linked.kind, LinkKind::Ours);
    assert_eq!(std::fs::read_link(s.bin.join("megabrain")).unwrap(), s.bundled);
}

#[test]
fn a_link_to_the_bundled_cli_is_ours_and_linking_again_changes_nothing() {
    let s = setup("ours");
    std::fs::create_dir_all(&s.bin).unwrap();
    symlink(&s.bundled, s.bin.join("megabrain")).unwrap();
    let path = path_with(&[&s.bin]);
    assert_eq!(inspect(&s.home, &path, &s.bundled).kind, LinkKind::Ours);
    assert_eq!(link(&s.home, &path, &s.bundled, false).unwrap().kind, LinkKind::Ours);
}

#[test]
fn a_link_elsewhere_is_shown_and_kept_without_an_explicit_choice() {
    let s = setup("other");
    let checkout = s._scratch.path().join("checkout/.build/megabrain");
    executable(&checkout);
    std::fs::create_dir_all(&s.bin).unwrap();
    symlink(&checkout, s.bin.join("megabrain")).unwrap();
    let path = path_with(&[&s.bin]);

    let state = inspect(&s.home, &path, &s.bundled);
    assert_eq!(state.kind, LinkKind::OtherLink);
    assert_eq!(state.points_to.as_deref(), Some(checkout.display().to_string().as_str()));

    assert!(link(&s.home, &path, &s.bundled, false).is_err());
    assert_eq!(std::fs::read_link(s.bin.join("megabrain")).unwrap(), checkout);

    assert_eq!(link(&s.home, &path, &s.bundled, true).unwrap().kind, LinkKind::Ours);
    assert_eq!(std::fs::read_link(s.bin.join("megabrain")).unwrap(), s.bundled);
}

#[test]
fn a_dangling_link_is_another_link_not_a_missing_one() {
    let s = setup("dangling");
    std::fs::create_dir_all(&s.bin).unwrap();
    symlink(s._scratch.path().join("gone"), s.bin.join("megabrain")).unwrap();
    let state = inspect(&s.home, &path_with(&[&s.bin]), &s.bundled);
    assert_eq!(state.kind, LinkKind::OtherLink);
    assert!(link(&s.home, &path_with(&[&s.bin]), &s.bundled, false).is_err());
}

#[test]
fn a_regular_file_is_never_replaced() {
    let s = setup("file");
    executable(&s.bin.join("megabrain"));
    let path = path_with(&[&s.bin]);
    assert_eq!(inspect(&s.home, &path, &s.bundled).kind, LinkKind::File);
    assert!(link(&s.home, &path, &s.bundled, true).is_err());
    assert!(std::fs::symlink_metadata(s.bin.join("megabrain")).unwrap().file_type().is_file());
}

#[test]
fn reports_when_local_bin_is_not_on_path_and_what_megabrain_resolves_to() {
    let s = setup("path");
    let other = s._scratch.path().join("opt/bin");
    executable(&other.join("megabrain"));
    let path = path_with(&[&other, std::path::Path::new("/usr/bin")]);

    let state = inspect(&s.home, &path, &s.bundled);
    assert!(!state.dir_on_path);
    assert_eq!(state.resolves_to.as_deref(), Some(other.join("megabrain").display().to_string().as_str()));
}

#[test]
fn resolves_to_follows_symlinks_to_the_real_file() {
    let s = setup("resolve");
    std::fs::create_dir_all(&s.bin).unwrap();
    symlink(&s.bundled, s.bin.join("megabrain")).unwrap();
    let state = inspect(&s.home, &path_with(&[&s.bin]), &s.bundled);
    assert_eq!(state.resolves_to.as_deref(), Some(s.bundled.display().to_string().as_str()));
}

#[test]
fn nothing_on_path_resolves_to_none() {
    let s = setup("none");
    let state = inspect(&s.home, "/nonexistent-dir", &s.bundled);
    assert_eq!(state.resolves_to, None);
}
