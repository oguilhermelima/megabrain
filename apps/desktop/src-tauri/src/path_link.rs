//! The `megabrain` command on PATH: where `~/.local/bin/megabrain` points, and linking it to the CLI
//! inside the app. A link that points anywhere else (a development checkout, an older install) is
//! replaced only on an explicit choice, and a regular file there is never touched.

use serde::Serialize;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkKind {
    Missing,
    Ours,
    OtherLink,
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    pub link_path: String,
    pub kind: LinkKind,
    /// Where an existing link points, as written in the link.
    pub points_to: Option<String>,
    pub bundled: String,
    /// Whether `~/.local/bin` is on the PATH the CLI runs with.
    pub dir_on_path: bool,
    /// The real file `megabrain` runs today, following links; none when nothing on PATH answers.
    pub resolves_to: Option<String>,
}

fn link_dir(home: &Path) -> PathBuf {
    home.join(".local/bin")
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn resolve(path_env: &str) -> Option<String> {
    path_env
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("megabrain"))
        .find(|candidate| is_executable_file(candidate))
        .map(|found| found.canonicalize().unwrap_or(found).display().to_string())
}

pub fn inspect(home: &Path, path_env: &str, bundled: &Path) -> LinkState {
    let dir = link_dir(home);
    let link = dir.join("megabrain");
    let (kind, points_to) = match std::fs::symlink_metadata(&link) {
        Err(_) => (LinkKind::Missing, None),
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = std::fs::read_link(&link).ok();
            let ours = target.as_deref() == Some(bundled) || same_file(&link, bundled);
            (if ours { LinkKind::Ours } else { LinkKind::OtherLink }, target.map(|target| target.display().to_string()))
        }
        Ok(_) => (LinkKind::File, None),
    };
    let dir_on_path = path_env.split(':').any(|entry| Path::new(entry) == dir || same_file(Path::new(entry), &dir));
    LinkState {
        link_path: link.display().to_string(),
        kind,
        points_to,
        bundled: bundled.display().to_string(),
        dir_on_path,
        resolves_to: resolve(path_env),
    }
}

/// Points `~/.local/bin/megabrain` at the bundled CLI. `replace` allows replacing a link that points
/// elsewhere; the swap is a rename over the old link, so there is never a moment with no command.
pub fn link(home: &Path, path_env: &str, bundled: &Path, replace: bool) -> Result<LinkState, String> {
    let state = inspect(home, path_env, bundled);
    let link = PathBuf::from(&state.link_path);
    match state.kind {
        LinkKind::Ours => return Ok(state),
        LinkKind::File => {
            return Err(format!("{} is a file, not a link; move it away to let megabrain link its CLI there", state.link_path))
        }
        LinkKind::OtherLink if !replace => {
            return Err(format!(
                "{} already points to {}; choose to replace it",
                state.link_path,
                state.points_to.as_deref().unwrap_or("another file")
            ))
        }
        LinkKind::Missing => {
            let dir = link_dir(home);
            std::fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
            symlink(bundled, &link).map_err(|error| format!("could not link {}: {error}", state.link_path))?;
        }
        LinkKind::OtherLink => {
            let staged = link.with_file_name(format!(".megabrain-link-{}", std::process::id()));
            let _ = std::fs::remove_file(&staged);
            symlink(bundled, &staged).map_err(|error| format!("could not link {}: {error}", staged.display()))?;
            std::fs::rename(&staged, &link).map_err(|error| {
                let _ = std::fs::remove_file(&staged);
                format!("could not replace {}: {error}", state.link_path)
            })?;
        }
    }
    Ok(inspect(home, path_env, bundled))
}
