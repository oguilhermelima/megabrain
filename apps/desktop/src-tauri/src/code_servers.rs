use std::collections::BTreeSet;
use std::sync::Mutex;

/// The roots whose Code server the app started through `megabrain code open` or `code goto`. The window
/// stops one after its grace; quitting the app stops whatever is left.
#[derive(Default)]
pub struct CodeServers(Mutex<BTreeSet<String>>);

impl CodeServers {
    /// Follows a finished CLI call: a successful `code open <root>` or `code goto <root> <path>`
    /// (which opens the server when none runs) adds the root, any `code stop <root>` removes it.
    pub fn note(&self, args: &[String], succeeded: bool) {
        let [command, action, root, ..] = args else { return };
        if command != "code" {
            return;
        }
        let Ok(mut roots) = self.0.lock() else { return };
        match action.as_str() {
            "open" | "goto" if succeeded => {
                roots.insert(root.clone());
            }
            "stop" => {
                roots.remove(root);
            }
            _ => {}
        }
    }

    /// Takes every root still running, leaving none.
    pub fn take(&self) -> Vec<String> {
        self.0.lock().map(|mut roots| std::mem::take(&mut *roots).into_iter().collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::CodeServers;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_successful_open_is_kept_until_stopped() {
        let servers = CodeServers::default();
        servers.note(&args(&["code", "open", "/wt/a", "--json"]), true);
        servers.note(&args(&["code", "open", "/wt/b", "--json"]), true);
        servers.note(&args(&["code", "stop", "/wt/a"]), true);
        assert_eq!(servers.take(), vec!["/wt/b".to_string()]);
        assert!(servers.take().is_empty());
    }

    #[test]
    fn a_successful_goto_starts_a_server_that_is_kept_until_stopped() {
        let servers = CodeServers::default();
        servers.note(&args(&["code", "goto", "/wt/a", "/wt/a/main.ts", "--line", "3", "--json"]), true);
        servers.note(&args(&["code", "goto", "/wt/b", "/wt/b/main.ts", "--json"]), false);
        assert_eq!(servers.take(), vec!["/wt/a".to_string()]);
    }

    #[test]
    fn a_failed_open_or_another_command_is_not_kept() {
        let servers = CodeServers::default();
        servers.note(&args(&["code", "open", "/wt/a", "--json"]), false);
        servers.note(&args(&["terminal", "open", "/wt/b"]), true);
        servers.note(&args(&["status", "--json"]), true);
        assert!(servers.take().is_empty());
    }
}
