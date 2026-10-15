use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

pub fn save_attachment_to(
    state_dir: &Path,
    encoded: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let extension = extension.to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "pdf"].contains(&extension.as_str()) {
        return Err("unsupported attachment extension".to_string());
    }
    if encoded.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 4 {
        return Err("attachment exceeds the 20 MB limit".to_string());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "attachment is not valid base64".to_string())?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment exceeds the 20 MB limit".to_string());
    }
    let directory = state_dir.join("attachments");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create attachment directory: {error}"))?;
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("could not inspect attachment directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("attachment directory must be a real directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("could not secure attachment directory: {error}"))?;
    }
    let path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("could not create attachment: {error}"))?;
    if let Err(error) = file.write_all(&bytes) {
        let _ = fs::remove_file(&path);
        return Err(format!("could not write attachment: {error}"));
    }
    fs::canonicalize(&path)
        .map_err(|error| format!("could not resolve saved attachment path: {error}"))
}

#[cfg(test)]
mod tests {
    use super::save_attachment_to;
    use std::fs;

    #[test]
    fn saves_allowed_attachment_with_private_permissions() {
        let root =
            std::env::temp_dir().join(format!("megabrain-attachment-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = save_attachment_to(&root, "aGVsbG8=", "png").expect("attachment saved");
        assert_eq!(fs::read(&path).expect("bytes readable"), b"hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path)
                    .expect("file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().expect("parent"))
                    .expect("directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_extensions_and_oversized_decoded_content() {
        let root = std::env::temp_dir().join(format!(
            "megabrain-attachment-reject-{}",
            std::process::id()
        ));
        assert!(save_attachment_to(&root, "aGVsbG8=", "sh").is_err());
        let too_large = "A".repeat(28_000_000);
        assert!(save_attachment_to(&root, &too_large, "pdf").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
