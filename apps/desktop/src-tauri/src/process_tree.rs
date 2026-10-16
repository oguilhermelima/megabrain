use std::io;
use std::process::Child;
#[cfg(unix)]
use std::{thread, time::Duration};

/// Stop a command's process group, including grandchildren it started.
pub fn kill(child: &mut Child) -> io::Result<()> {
    let pid = child.id();
    #[cfg(unix)]
    {
        // Commands launched by the desktop app are placed in their own process group.
        // SAFETY: kill only receives the negative process group ID derived from this child.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
        thread::sleep(Duration::from_millis(100));
        // SAFETY: as above, this signal is limited to the child's process group.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
        child.wait().map(|_| ())
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()?;
        if status.success() {
            child.wait().map(|_| ())
        } else {
            child.kill()?;
            child.wait().map(|_| ())
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        child.kill()?;
        child.wait().map(|_| ())
    }
}
