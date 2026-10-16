use crate::cli;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_FILE_SIZE: usize = 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 20_000;
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".build",
    ".next",
    ".turbo",
    "coverage",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeEntry {
    pub path: String,
    pub kind: &'static str,
    pub size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    pub path: String,
    pub text: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChange {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDiff {
    pub path: String,
    pub original: String,
    pub modified: String,
    pub binary: bool,
    pub too_large: bool,
}

/// What the branch committed since it left its base: the base ref, the merge base and the files.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchChanges {
    /// The ref the branch is measured against, or None when neither candidate resolves.
    pub base: Option<String>,
    /// The commit HEAD and the base share; None when there is no base or no shared history.
    pub merge_base: Option<String>,
    pub changes: Vec<CodeChange>,
}

#[derive(Default)]
struct TreeNode {
    dirs: BTreeMap<String, TreeNode>,
    files: BTreeMap<String, u64>,
}

type WorktreeCache = Mutex<Option<(Instant, Vec<PathBuf>)>>;
static WORKTREE_CACHE: OnceLock<WorktreeCache> = OnceLock::new();

/// Canonicalize the requested root and accept it only when it matches a canonical allowlisted root.
pub fn validate_root(root: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("could not resolve repository root: {error}"))?;
    if allowed_roots.iter().any(|allowed| {
        allowed
            .canonicalize()
            .is_ok_and(|resolved| resolved == canonical)
    }) {
        Ok(canonical)
    } else {
        Err("repository root is not a registered megabrain worktree or checkout".into())
    }
}

/// Runs the bundled CLI once per 30-second window and caches its registered repository roots.
pub fn allowed_roots(
    executable: &Path,
    megabrain_root: &Path,
    path: &str,
) -> Result<Vec<PathBuf>, String> {
    let cache = WORKTREE_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache
        .lock()
        .map_err(|_| "worktree allowlist cache is unavailable".to_string())?;
    if let Some((loaded_at, roots)) = cached.as_ref() {
        if loaded_at.elapsed() < Duration::from_secs(30) {
            return Ok(roots.clone());
        }
    }

    let mut command = cli::cli_command(
        executable,
        megabrain_root,
        path,
        &["worktree", "list", "--json"],
    );
    let output = command
        .output()
        .map_err(|error| format!("could not list registered worktrees: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not list registered worktrees: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let records: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid worktree list: {error}"))?;
    let mut roots = Vec::new();
    for record in records {
        for path in [
            record.get("path"),
            record
                .get("repository")
                .and_then(|repository| repository.get("path")),
        ]
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        {
            let root = PathBuf::from(path);
            if let Ok(canonical) = root.canonicalize() {
                if !roots.contains(&canonical) {
                    roots.push(canonical);
                }
            }
        }
    }
    *cached = Some((Instant::now(), roots.clone()));
    Ok(roots)
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|error| format!("could not run git: {error}"))
}

fn is_skipped(path: &Path) -> bool {
    let components: Vec<_> = path.components().collect();
    components
        .iter()
        .take(components.len().saturating_sub(1))
        .any(|component| match component {
            Component::Normal(name) => SKIPPED_DIRS.iter().any(|skipped| name.to_str() == Some(*skipped)),
            _ => false,
        })
}

fn insert_path(tree: &mut TreeNode, path: &str, size: u64) {
    let mut components = path.split('/').peekable();
    let mut node = tree;
    while let Some(component) = components.next() {
        if components.peek().is_some() {
            node = node.dirs.entry(component.to_string()).or_default();
        } else {
            node.files.insert(component.to_string(), size);
        }
    }
}

fn flatten_tree(node: &TreeNode, prefix: &str, entries: &mut Vec<CodeEntry>) {
    for (name, child) in &node.dirs {
        if entries.len() >= MAX_TREE_ENTRIES {
            return;
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        entries.push(CodeEntry {
            path: path.clone(),
            kind: "dir",
            size: None,
        });
        flatten_tree(child, &path, entries);
    }
    for (name, size) in &node.files {
        if entries.len() >= MAX_TREE_ENTRIES {
            return;
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        entries.push(CodeEntry {
            path,
            kind: "file",
            size: Some(*size),
        });
    }
}

pub fn code_tree(root: &Path, allowed_roots: &[PathBuf]) -> Result<Vec<CodeEntry>, String> {
    let root = validate_root(root, allowed_roots)?;
    let output = git(
        &root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Err(format!(
            "could not list repository files: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut tree = TreeNode::default();
    for bytes in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let Ok(relative) = std::str::from_utf8(bytes) else {
            continue;
        };
        let relative_path = Path::new(relative);
        if is_skipped(relative_path) {
            continue;
        }
        let absolute = root.join(relative_path);
        let Ok(metadata) = fs::symlink_metadata(&absolute) else {
            continue;
        };
        if metadata.is_file() || metadata.file_type().is_symlink() {
            insert_path(&mut tree, relative, metadata.len());
        }
    }
    let mut entries = Vec::new();
    flatten_tree(&tree, "", &mut entries);
    Ok(entries)
}

/// A non-empty relative path with no traversal, outside the skipped directories.
fn check_relative(path: &str) -> Result<&Path, String> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("file path must be a non-empty relative path without traversal".into());
    }
    if is_skipped(relative) {
        return Err("file path is inside a skipped directory".into());
    }
    Ok(relative)
}

fn resolve_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = check_relative(path)?;
    let candidate = root.join(relative);
    if let Ok(canonical) = candidate.canonicalize() {
        if !canonical.starts_with(root) {
            return Err("file path resolves outside the repository root".into());
        }
        return Ok(canonical);
    }
    if fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("file symlink cannot be resolved safely".into());
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "file path has no parent".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("could not resolve file path: {error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("file path resolves outside the repository root".into());
    }
    Ok(candidate)
}

fn read_limited(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read file metadata: {error}")),
    };
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    if metadata.len() > MAX_FILE_SIZE as u64 {
        return Ok(Some(vec![0; MAX_FILE_SIZE + 1]));
    }
    let file = fs::File::open(path).map_err(|error| format!("could not read file: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_FILE_SIZE + 1);
    file.take((MAX_FILE_SIZE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read file: {error}"))?;
    if bytes.len() > MAX_FILE_SIZE {
        return Ok(Some(vec![0; MAX_FILE_SIZE + 1]));
    }
    Ok(Some(bytes))
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0)
}

pub fn code_read(root: &Path, path: &str, allowed_roots: &[PathBuf]) -> Result<CodeFile, String> {
    let root = validate_root(root, allowed_roots)?;
    let absolute = resolve_file(&root, path)?;
    let Some(bytes) = read_limited(&absolute)? else {
        return Ok(CodeFile {
            path: path.to_string(),
            text: None,
            binary: false,
            too_large: false,
        });
    };
    if bytes.len() > MAX_FILE_SIZE {
        return Ok(CodeFile {
            path: path.to_string(),
            text: None,
            binary: false,
            too_large: true,
        });
    }
    if is_binary(&bytes) {
        return Ok(CodeFile {
            path: path.to_string(),
            text: None,
            binary: true,
            too_large: false,
        });
    }
    Ok(CodeFile {
        path: path.to_string(),
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        binary: false,
        too_large: false,
    })
}

pub fn code_changes(root: &Path, allowed_roots: &[PathBuf]) -> Result<Vec<CodeChange>, String> {
    let root = validate_root(root, allowed_roots)?;
    let output = git(&root, &["status", "--porcelain=v1", "-z"])?;
    if !output.status.success() {
        return Err(format!(
            "could not read repository status: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut fields = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let status = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let status = if status == b"??" {
            "untracked"
        } else if status.contains(&b'R') || status.contains(&b'C') {
            let _ = fields.next();
            "renamed"
        } else if status.contains(&b'D') {
            "deleted"
        } else if status.contains(&b'A') {
            "added"
        } else {
            "modified"
        };
        changes.push(CodeChange {
            path,
            status: status.to_string(),
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

fn head_file(root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
    committed_file(root, "HEAD", path)
}

/// A file as commit `rev` holds it; None when the commit has no such file.
fn committed_file(root: &Path, rev: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let spec = format!("{rev}:{path}");
    let size = git(root, &["cat-file", "-s", &spec])?;
    if !size.status.success() {
        return Ok(None);
    }
    let size = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("invalid git object size: {error}"))?;
    if size > MAX_FILE_SIZE as u64 {
        return Ok(Some(vec![0; MAX_FILE_SIZE + 1]));
    }
    let output = git(root, &["show", &spec])?;
    if !output.status.success() {
        return Err(format!(
            "could not read file from {rev}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > MAX_FILE_SIZE {
        return Ok(Some(vec![0; MAX_FILE_SIZE + 1]));
    }
    Ok(Some(output.stdout))
}

pub fn code_diff(root: &Path, path: &str, allowed_roots: &[PathBuf]) -> Result<CodeDiff, String> {
    let root = validate_root(root, allowed_roots)?;
    let absolute = resolve_file(&root, path)?;
    let original = head_file(&root, path)?;
    let modified = read_limited(&absolute)?;
    let too_large = original
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_FILE_SIZE)
        || modified
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_FILE_SIZE);
    if too_large {
        return Ok(CodeDiff {
            path: path.to_string(),
            original: String::new(),
            modified: String::new(),
            binary: false,
            too_large: true,
        });
    }
    let original = original.unwrap_or_default();
    let modified = modified.unwrap_or_default();
    let binary = is_binary(&original) || is_binary(&modified);
    if binary {
        return Ok(CodeDiff {
            path: path.to_string(),
            original: String::new(),
            modified: String::new(),
            binary: true,
            too_large: false,
        });
    }
    Ok(CodeDiff {
        path: path.to_string(),
        original: String::from_utf8_lossy(&original).into_owned(),
        modified: String::from_utf8_lossy(&modified).into_owned(),
        binary: false,
        too_large: false,
    })
}

fn resolves(root: &Path, rev: &str) -> Result<bool, String> {
    let spec = format!("{rev}^{{commit}}");
    Ok(git(root, &["rev-parse", "--verify", "--quiet", &spec])?
        .status
        .success())
}

/// The ref a branch's changes are measured against: the worktree's parent branch when it names a
/// commit, else origin's default branch (refs/remotes/origin/HEAD), else none. A name that git
/// would read as an option is never passed to it.
pub fn branch_base(root: &Path, parent: Option<&str>) -> Result<Option<String>, String> {
    if let Some(parent) = parent.filter(|name| !name.is_empty() && !name.starts_with('-')) {
        if resolves(root, parent)? {
            return Ok(Some(parent.to_string()));
        }
    }
    let output = git(
        root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    if output.status.success() {
        let default = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !default.is_empty() && resolves(root, &default)? {
            return Ok(Some(default));
        }
    }
    Ok(None)
}

/// The commit HEAD and `base` share; None when they share no history.
pub fn merge_base(root: &Path, base: &str) -> Result<Option<String>, String> {
    let output = git(root, &["merge-base", "HEAD", base])?;
    if !output.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

fn is_commit_id(rev: &str) -> bool {
    (rev.len() == 40 || rev.len() == 64) && rev.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The files HEAD changed since its merge base with the branch's base, committed changes only.
pub fn code_branch_changes(
    root: &Path,
    parent: Option<&str>,
    allowed_roots: &[PathBuf],
) -> Result<BranchChanges, String> {
    let root = validate_root(root, allowed_roots)?;
    let base = branch_base(&root, parent)?;
    let merge = match &base {
        Some(base) => merge_base(&root, base)?,
        None => None,
    };
    let Some(sha) = merge.clone() else {
        return Ok(BranchChanges {
            base,
            merge_base: merge,
            changes: Vec::new(),
        });
    };
    let output = git(
        &root,
        &[
            "diff",
            "--name-status",
            "--no-renames",
            "-z",
            &sha,
            "HEAD",
            "--",
        ],
    )?;
    if !output.status.success() {
        return Err(format!(
            "could not read branch changes: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut fields = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        let status = match status.first() {
            Some(b'A') => "added",
            Some(b'D') => "deleted",
            _ => "modified",
        };
        changes.push(CodeChange {
            path: String::from_utf8_lossy(path).into_owned(),
            status: status.to_string(),
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(BranchChanges {
        base,
        merge_base: merge,
        changes,
    })
}

/// One file as the merge base held it beside HEAD's version: what the branch committed to it.
pub fn code_branch_diff(
    root: &Path,
    merge_base: &str,
    path: &str,
    allowed_roots: &[PathBuf],
) -> Result<CodeDiff, String> {
    let root = validate_root(root, allowed_roots)?;
    if !is_commit_id(merge_base) {
        return Err("merge base must be a full commit id".into());
    }
    // Both sides come from git objects, so the file need not exist on disk.
    check_relative(path)?;
    let original = committed_file(&root, merge_base, path)?.unwrap_or_default();
    let modified = committed_file(&root, "HEAD", path)?.unwrap_or_default();
    if original.len() > MAX_FILE_SIZE || modified.len() > MAX_FILE_SIZE {
        return Ok(CodeDiff {
            path: path.to_string(),
            original: String::new(),
            modified: String::new(),
            binary: false,
            too_large: true,
        });
    }
    if is_binary(&original) || is_binary(&modified) {
        return Ok(CodeDiff {
            path: path.to_string(),
            original: String::new(),
            modified: String::new(),
            binary: true,
            too_large: false,
        });
    }
    Ok(CodeDiff {
        path: path.to_string(),
        original: String::from_utf8_lossy(&original).into_owned(),
        modified: String::from_utf8_lossy(&modified).into_owned(),
        binary: false,
        too_large: false,
    })
}
