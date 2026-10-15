//! The tray (menu bar) icon: how many dispatches have a supervisor finding, the first few of them,
//! a way back to the window, and Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

const TRAY_ID: &str = "main";

fn menu<R: Runtime>(app: &AppHandle<R>, lines: &[String]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open megabrain", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if lines.is_empty() {
        menu.append(&MenuItem::new(app, "No findings", false, None::<&str>)?)?;
    }
    for line in lines {
        menu.append(&MenuItem::new(app, line, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit megabrain", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("megabrain")
        .menu(&menu(app, &[])?)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::show_main(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn update(app: &AppHandle, findings: usize, lines: &[String]) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    tray.set_menu(Some(menu(app, lines)?))?;
    tray.set_title(if findings == 0 { None } else { Some(findings.to_string()) })?;
    tray.set_tooltip(Some(if findings == 0 { "megabrain".to_string() } else { format!("megabrain: {findings} finding(s)") }))?;
    Ok(())
}
