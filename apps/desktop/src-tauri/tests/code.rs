mod common;

use common::Scratch;
use megabrain_desktop_lib::code::{
    code_changes, code_diff, code_read, code_tree, validate_root, MAX_FILE_SIZE,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Repository {
    _scratch: Scratch,
    root: PathBuf,
}

impl Repository {
    fn new(name: &str) -> Self {
        let scratch = Scratch::new(name);
        let root = scratch.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test"]);
        std::fs::write(root.join("tracked.txt"), "before\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-m", "initial"]);
        Self { root, _scratch: scratch }
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn code_tree_sorts_directories_before_files_and_skips_ignored_build_folders() {
    let repo = Repository::new("code-tree");
    std::fs::create_dir_all(repo.root.join("alpha/inner")).unwrap();
    std::fs::write(repo.root.join("alpha/a.txt"), "a").unwrap();
    std::fs::write(repo.root.join("alpha/inner/b.txt"), "bb").unwrap();
    std::fs::create_dir_all(repo.root.join("zeta")).unwrap();
    std::fs::write(repo.root.join("zeta/c.txt"), "ccc").unwrap();
    std::fs::write(repo.root.join(".gitignore"), "ignored.txt\nnode_modules/\n").unwrap();
    std::fs::write(repo.root.join("ignored.txt"), "ignored").unwrap();
    std::fs::create_dir_all(repo.root.join("node_modules/pkg")).unwrap();
    std::fs::write(repo.root.join("node_modules/pkg/index.js"), "ignored").unwrap();
    std::fs::create_dir_all(repo.root.join("target/debug")).unwrap();
    std::fs::write(repo.root.join("target/debug/app"), "ignored").unwrap();

    let entries = code_tree(&repo.root, &[repo.root.clone()]).unwrap();
    let paths: Vec<_> = entries.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(
        paths,
        ["alpha", "alpha/inner", "alpha/inner/b.txt", "alpha/a.txt", "zeta", "zeta/c.txt", ".gitignore", "tracked.txt"]
    );
    assert!(entries.iter().all(|entry| !entry.path.contains("node_modules") && !entry.path.starts_with("target")));
    assert!(!paths.contains(&"ignored.txt"));
    assert_eq!(entries.iter().find(|entry| entry.path == "alpha/a.txt").unwrap().size, Some(1));
}

#[test]
fn code_read_returns_text_binary_and_too_large_results() {
    let repo = Repository::new("code-read");
    std::fs::write(repo.root.join("text.txt"), "hello\n").unwrap();
    std::fs::write(repo.root.join("binary.bin"), [b'x'; 3].into_iter().chain([0]).collect::<Vec<_>>()).unwrap();
    std::fs::write(repo.root.join("large.txt"), vec![b'x'; MAX_FILE_SIZE + 1]).unwrap();

    let text = code_read(&repo.root, "text.txt", &[repo.root.clone()]).unwrap();
    assert_eq!(text.text.as_deref(), Some("hello\n"));
    assert!(!text.binary && !text.too_large);

    let binary = code_read(&repo.root, "binary.bin", &[repo.root.clone()]).unwrap();
    assert!(binary.binary);
    assert_eq!(binary.text, None);

    let large = code_read(&repo.root, "large.txt", &[repo.root.clone()]).unwrap();
    assert!(large.too_large);
    assert_eq!(large.text, None);
}

#[test]
fn code_read_refuses_traversal_absolute_paths_and_symlinks_outside_root() {
    let repo = Repository::new("code-paths");
    let outside = repo._scratch.path().join("outside.txt");
    std::fs::write(&outside, "outside").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, repo.root.join("outside-link.txt")).unwrap();

    assert!(code_read(&repo.root, "../outside.txt", &[repo.root.clone()]).is_err());
    assert!(code_read(&repo.root, outside.to_str().unwrap(), &[repo.root.clone()]).is_err());
    #[cfg(unix)]
    assert!(code_read(&repo.root, "outside-link.txt", &[repo.root.clone()]).is_err());
}

#[test]
fn code_changes_reports_staged_and_unstaged_statuses_and_new_rename_path() {
    let repo = Repository::new("code-changes");
    std::fs::write(repo.root.join("tracked.txt"), "modified\n").unwrap();
    std::fs::write(repo.root.join("added.txt"), "added\n").unwrap();
    git(&repo.root, &["add", "added.txt"]);
    std::fs::write(repo.root.join("deleted.txt"), "delete\n").unwrap();
    git(&repo.root, &["add", "deleted.txt"]);
    git(&repo.root, &["commit", "-m", "add change fixtures"]);
    std::fs::remove_file(repo.root.join("deleted.txt")).unwrap();
    git(&repo.root, &["add", "-u", "deleted.txt"]);
    git(&repo.root, &["mv", "added.txt", "renamed.txt"]);
    std::fs::write(repo.root.join("untracked.txt"), "new\n").unwrap();

    let changes = code_changes(&repo.root, &[repo.root.clone()]).unwrap();
    let by_path: HashMap<_, _> = changes.iter().map(|change| (change.path.as_str(), change.status.as_str())).collect();
    assert_eq!(by_path.get("tracked.txt"), Some(&"modified"));
    assert_eq!(by_path.get("deleted.txt"), Some(&"deleted"));
    assert_eq!(by_path.get("renamed.txt"), Some(&"renamed"));
    assert_eq!(by_path.get("untracked.txt"), Some(&"untracked"));
}

#[test]
fn code_diff_returns_head_and_working_contents_for_modified_added_and_deleted_files() {
    let repo = Repository::new("code-diff");
    std::fs::write(repo.root.join("tracked.txt"), "after\n").unwrap();
    std::fs::write(repo.root.join("added.txt"), "new\n").unwrap();
    std::fs::write(repo.root.join("deleted.txt"), "gone\n").unwrap();
    git(&repo.root, &["add", "deleted.txt"]);
    git(&repo.root, &["commit", "-m", "add deleted fixture"]);
    std::fs::remove_file(repo.root.join("deleted.txt")).unwrap();

    let modified = code_diff(&repo.root, "tracked.txt", &[repo.root.clone()]).unwrap();
    assert_eq!(modified.original, "before\n");
    assert_eq!(modified.modified, "after\n");
    assert!(!modified.binary && !modified.too_large);

    let added = code_diff(&repo.root, "added.txt", &[repo.root.clone()]).unwrap();
    assert_eq!(added.original, "");
    assert_eq!(added.modified, "new\n");

    let deleted = code_diff(&repo.root, "deleted.txt", &[repo.root.clone()]).unwrap();
    assert_eq!(deleted.original, "gone\n");
    assert_eq!(deleted.modified, "");
}

#[test]
fn code_diff_suppresses_both_sides_for_binary_or_too_large_content() {
    let repo = Repository::new("code-diff-limits");
    std::fs::write(repo.root.join("binary.txt"), "text\n").unwrap();
    std::fs::write(repo.root.join("large.txt"), "small\n").unwrap();
    git(&repo.root, &["add", "binary.txt", "large.txt"]);
    git(&repo.root, &["commit", "-m", "add limit fixtures"]);
    std::fs::write(repo.root.join("binary.txt"), b"now\0binary").unwrap();
    std::fs::write(repo.root.join("large.txt"), vec![b'x'; MAX_FILE_SIZE + 1]).unwrap();

    let binary = code_diff(&repo.root, "binary.txt", &[repo.root.clone()]).unwrap();
    assert!(binary.binary && !binary.too_large);
    assert_eq!((&*binary.original, &*binary.modified), ("", ""));

    let large = code_diff(&repo.root, "large.txt", &[repo.root.clone()]).unwrap();
    assert!(large.too_large && !large.binary);
    assert_eq!((&*large.original, &*large.modified), ("", ""));
}

#[test]
fn code_commands_refuse_roots_missing_from_the_allowlist() {
    let repo = Repository::new("code-root-allowlist");
    let other = repo._scratch.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let allowed = vec![repo.root.clone()];

    assert!(validate_root(&repo.root, &allowed).is_ok());
    assert!(validate_root(&other, &allowed).is_err());
    assert!(code_tree(&other, &allowed).is_err());
}

#[test]
fn code_diff_response_matches_native_contract() {
    let repo = Repository::new("code-diff-shape");
    let value: Value = serde_json::to_value(code_diff(&repo.root, "tracked.txt", &[repo.root.clone()]).unwrap()).unwrap();
    assert_eq!(value["path"], "tracked.txt");
    assert_eq!(value["binary"], false);
    assert_eq!(value["tooLarge"], false);
}
