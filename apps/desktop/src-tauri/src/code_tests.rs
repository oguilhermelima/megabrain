use crate::code::{branch_base, code_branch_changes, code_branch_diff, merge_base};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Repo {
    dir: PathBuf,
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn write(dir: &Path, path: &str, text: &str) {
    fs::write(dir.join(path), text).expect("write file");
}

/// main holds a, b and d; feature branches off it, then main moves on (d changes) and feature
/// modifies a, deletes b and adds c. The merge base is main's first commit, not its tip.
fn repo() -> (Repo, String) {
    let dir = std::env::temp_dir().join(format!("mb-code-branch-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).expect("create repo dir");
    let dir = dir.canonicalize().expect("canonical repo dir");
    git(&dir, &["init", "--quiet", "--initial-branch=main"]);
    write(&dir, "a.txt", "a1\n");
    write(&dir, "b.txt", "b1\n");
    write(&dir, "d.txt", "d1\n");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "--quiet", "-m", "base"]);
    let fork = git(&dir, &["rev-parse", "HEAD"]);
    git(&dir, &["checkout", "--quiet", "-b", "feature"]);
    git(&dir, &["checkout", "--quiet", "main"]);
    write(&dir, "d.txt", "d2\n");
    git(&dir, &["commit", "--quiet", "-am", "main moves on"]);
    git(&dir, &["checkout", "--quiet", "feature"]);
    write(&dir, "a.txt", "a2\n");
    fs::remove_file(dir.join("b.txt")).expect("remove b");
    write(&dir, "c.txt", "c1\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "--quiet", "-m", "feature work"]);
    (Repo { dir }, fork)
}

/// Gives the repo an origin whose default branch is main, without a network.
fn add_origin(repo: &Repo) {
    let remote = repo.dir.with_extension("origin.git");
    git(
        &repo.dir,
        &[
            "init",
            "--quiet",
            "--bare",
            remote.to_str().expect("utf8 path"),
        ],
    );
    git(
        &repo.dir,
        &[
            "remote",
            "add",
            "origin",
            remote.to_str().expect("utf8 path"),
        ],
    );
    git(&repo.dir, &["push", "--quiet", "origin", "main"]);
    git(&repo.dir, &["remote", "set-head", "origin", "main"]);
}

#[test]
fn the_parent_branch_is_the_base_when_it_resolves() {
    let (repo, _) = repo();
    add_origin(&repo);
    assert_eq!(
        branch_base(&repo.dir, Some("main")).unwrap(),
        Some("main".to_string())
    );
    let _ = fs::remove_dir_all(repo.dir.with_extension("origin.git"));
}

#[test]
fn a_missing_or_option_like_parent_falls_back_to_the_origin_default_branch() {
    let (repo, _) = repo();
    add_origin(&repo);
    assert_eq!(
        branch_base(&repo.dir, Some("gone")).unwrap(),
        Some("origin/main".to_string())
    );
    assert_eq!(
        branch_base(&repo.dir, Some("--all")).unwrap(),
        Some("origin/main".to_string())
    );
    assert_eq!(
        branch_base(&repo.dir, None).unwrap(),
        Some("origin/main".to_string())
    );
    let _ = fs::remove_dir_all(repo.dir.with_extension("origin.git"));
}

#[test]
fn without_a_parent_or_an_origin_there_is_no_base_and_no_branch_changes() {
    let (repo, _) = repo();
    assert_eq!(branch_base(&repo.dir, Some("gone")).unwrap(), None);
    let changes = code_branch_changes(&repo.dir, Some("gone"), &[repo.dir.clone()]).unwrap();
    assert_eq!(changes.base, None);
    assert_eq!(changes.merge_base, None);
    assert!(changes.changes.is_empty());
}

#[test]
fn the_merge_base_is_where_the_branch_left_its_base_not_the_base_tip() {
    let (repo, fork) = repo();
    let main_tip = git(&repo.dir, &["rev-parse", "main"]);
    assert_ne!(main_tip, fork);
    assert_eq!(merge_base(&repo.dir, "main").unwrap(), Some(fork));
}

#[test]
fn branch_changes_list_what_the_branch_committed_and_nothing_else() {
    let (repo, fork) = repo();
    // Uncommitted work and the base's own later commits are not the branch's committed changes.
    write(&repo.dir, "a.txt", "a3 uncommitted\n");
    write(&repo.dir, "e.txt", "untracked\n");
    let changes = code_branch_changes(&repo.dir, Some("main"), &[repo.dir.clone()]).unwrap();
    assert_eq!(changes.base.as_deref(), Some("main"));
    assert_eq!(changes.merge_base.as_deref(), Some(fork.as_str()));
    let listed: Vec<(&str, &str)> = changes
        .changes
        .iter()
        .map(|change| (change.path.as_str(), change.status.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("a.txt", "modified"),
            ("b.txt", "deleted"),
            ("c.txt", "added")
        ]
    );
}

#[test]
fn a_branch_diff_compares_the_merge_base_with_head() {
    let (repo, fork) = repo();
    write(&repo.dir, "a.txt", "a3 uncommitted\n");
    let allowed = [repo.dir.clone()];
    let diff = code_branch_diff(&repo.dir, &fork, "a.txt", &allowed).unwrap();
    assert_eq!(
        (diff.original.as_str(), diff.modified.as_str()),
        ("a1\n", "a2\n")
    );
    let deleted = code_branch_diff(&repo.dir, &fork, "b.txt", &allowed).unwrap();
    assert_eq!(
        (deleted.original.as_str(), deleted.modified.as_str()),
        ("b1\n", "")
    );
    let added = code_branch_diff(&repo.dir, &fork, "c.txt", &allowed).unwrap();
    assert_eq!(
        (added.original.as_str(), added.modified.as_str()),
        ("", "c1\n")
    );
}

#[test]
fn a_branch_diff_refuses_a_ref_that_is_not_a_commit_id_and_a_path_that_escapes() {
    let (repo, fork) = repo();
    let allowed = [repo.dir.clone()];
    assert!(code_branch_diff(&repo.dir, "main", "a.txt", &allowed).is_err());
    assert!(code_branch_diff(&repo.dir, "--output=x", "a.txt", &allowed).is_err());
    assert!(code_branch_diff(&repo.dir, &fork, "../a.txt", &allowed).is_err());
    assert!(code_branch_changes(&repo.dir, None, &[]).is_err());
}
