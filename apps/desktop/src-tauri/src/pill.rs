//! The pill: a small window over the notch (top center where there is none) that grows into the
//! assistant. It sits above the menu bar, on every Space and over full-screen apps.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "pill";
const COLLAPSED_WIDTH: f64 = 380.0;
const EXPANDED: (f64, f64) = (580.0, 640.0);
const NO_NOTCH_HEIGHT: f64 = 34.0;

static EXPANDED_NOW: AtomicBool = AtomicBool::new(false);

/// The notch, in points, when the main screen has one: its width and the menu bar height beside it.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub notch_width: Option<f64>,
    pub bar_height: f64,
}

#[cfg(target_os = "macos")]
pub fn geometry() -> Geometry {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    let Some(mtm) = MainThreadMarker::new() else { return Geometry { notch_width: None, bar_height: NO_NOTCH_HEIGHT } };
    let Some(screen) = NSScreen::mainScreen(mtm) else { return Geometry { notch_width: None, bar_height: NO_NOTCH_HEIGHT } };
    let top = screen.safeAreaInsets().top;
    if top <= 0.0 {
        return Geometry { notch_width: None, bar_height: NO_NOTCH_HEIGHT };
    }
    let width = screen.frame().size.width;
    let left = screen.auxiliaryTopLeftArea().size.width;
    let right = screen.auxiliaryTopRightArea().size.width;
    Geometry { notch_width: Some((width - left - right).max(0.0)), bar_height: top }
}

#[cfg(not(target_os = "macos"))]
pub fn geometry() -> Geometry {
    Geometry { notch_width: None, bar_height: NO_NOTCH_HEIGHT }
}

// Above the menu bar (NSMainMenuWindowLevel is 24), on every Space, beside full-screen apps, and
// out of the window cycle.
#[cfg(target_os = "macos")]
fn raise(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(pointer) = window.ns_window() else { return };
    // SAFETY: Tauri hands out the live NSWindow behind this webview window, and setup runs on the
    // main thread, where AppKit must be called.
    let ns_window: &NSWindow = unsafe { &*(pointer as *const NSWindow) };
    ns_window.setLevel(25);
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
}

#[cfg(not(target_os = "macos"))]
fn raise(_window: &WebviewWindow) {}

fn place(window: &WebviewWindow, expanded: bool) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()?.or(window.current_monitor()?) else { return Ok(()) };
    let geometry = geometry();
    let (width, height) = if expanded {
        EXPANDED
    } else {
        (geometry.notch_width.map_or(COLLAPSED_WIDTH, |notch| notch + 2.0 * 130.0), geometry.bar_height)
    };
    window.set_size(LogicalSize::new(width, height))?;
    let scale = monitor.scale_factor();
    let x = monitor.position().x + ((f64::from(monitor.size().width) - width * scale) / 2.0).round() as i32;
    window.set_position(PhysicalPosition::new(x, monitor.position().y))?;
    Ok(())
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    raise(&window);
    place(&window, false)
}

pub fn set_expanded(app: &AppHandle, expanded: bool) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
    EXPANDED_NOW.store(expanded, Ordering::SeqCst);
    place(&window, expanded)?;
    if expanded {
        window.show()?;
        window.set_focus()?;
    }
    app.emit_to(LABEL, "pill-expanded", expanded)?;
    Ok(())
}

pub fn toggle(app: &AppHandle) -> tauri::Result<()> {
    set_expanded(app, !EXPANDED_NOW.load(Ordering::SeqCst))
}

pub fn is_expanded() -> bool {
    EXPANDED_NOW.load(Ordering::SeqCst)
}
