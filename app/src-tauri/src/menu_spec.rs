//! Native application menu, built from a spec the frontend sends (bug/C1).
//!
//! The menu used to be hand-built here with two hard-coded languages and the
//! factory accelerators, while the Windows title-bar menubar (Toolbar.vue) was
//! a second, different list. Both now render one tree — `lib/app-menu.ts` —
//! so they cannot drift: same seven menus (File · Edit · Paragraph · Format ·
//! Navigate · View · Help, plus the macOS app and Window menus), labels in
//! all fifteen UI languages, and every accelerator the binding in effect
//! (an unbound or rebound action carries none, so the old chord can never
//! keep firing from the menu — #180).
//!
//! Until the frontend sends its spec (a few hundred ms after launch) a
//! minimal startup menu is installed, so ⌘Q / copy / paste work from the
//! first frame.

// Windows builds no native menu (the title-bar menubar renders the spec).
#![cfg_attr(target_os = "windows", allow(dead_code))]

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PredefinedRole {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Minimize,
    Maximize,
    CloseWindow,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuNode {
    Item {
        id: String,
        text: String,
        #[serde(default)]
        accelerator: Option<String>,
        #[serde(default = "yes")]
        enabled: bool,
    },
    Check {
        id: String,
        text: String,
        #[serde(default)]
        accelerator: Option<String>,
        #[serde(default = "yes")]
        enabled: bool,
        checked: bool,
    },
    Separator,
    Submenu {
        text: String,
        items: Vec<MenuNode>,
    },
    Predefined {
        role: PredefinedRole,
        #[serde(default)]
        text: Option<String>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TopMenu {
    pub text: String,
    pub items: Vec<MenuNode>,
}

/// The menu shown before the frontend's spec arrives: just what the OS needs
/// to behave (app menu with Quit on macOS, a working Edit menu everywhere).
pub fn startup_spec() -> Vec<TopMenu> {
    let p = |role| MenuNode::Predefined { role, text: None };
    let edit = TopMenu {
        text: "Edit".into(),
        items: vec![
            p(PredefinedRole::Undo),
            p(PredefinedRole::Redo),
            MenuNode::Separator,
            p(PredefinedRole::Cut),
            p(PredefinedRole::Copy),
            p(PredefinedRole::Paste),
            p(PredefinedRole::SelectAll),
        ],
    };
    if cfg!(target_os = "macos") {
        vec![
            TopMenu {
                text: "SoloMD".into(),
                items: vec![
                    p(PredefinedRole::About),
                    MenuNode::Separator,
                    p(PredefinedRole::Hide),
                    p(PredefinedRole::HideOthers),
                    p(PredefinedRole::ShowAll),
                    MenuNode::Separator,
                    p(PredefinedRole::Quit),
                ],
            },
            edit,
            TopMenu {
                text: "Window".into(),
                items: vec![
                    p(PredefinedRole::Minimize),
                    p(PredefinedRole::Maximize),
                    MenuNode::Separator,
                    p(PredefinedRole::CloseWindow),
                ],
            },
        ]
    } else {
        vec![edit]
    }
}

/// Muda silently drops an accelerator it cannot parse; check up front so a
/// bad string from the frontend is skipped deliberately (and testably).
pub fn valid_accelerator(accel: &str) -> bool {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        accel.parse::<muda::accelerator::Accelerator>().is_ok()
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = accel;
        false
    }
}

/// Every item id in a spec (tests / diagnostics).
#[allow(dead_code)]
pub fn item_ids(menus: &[TopMenu]) -> Vec<String> {
    fn walk(nodes: &[MenuNode], out: &mut Vec<String>) {
        for n in nodes {
            match n {
                MenuNode::Item { id, .. } | MenuNode::Check { id, .. } => out.push(id.clone()),
                MenuNode::Submenu { items, .. } => walk(items, out),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for m in menus {
        walk(&m.items, &mut out);
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    menus: &[TopMenu],
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        CheckMenuItemBuilder, IsMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu,
        SubmenuBuilder,
    };

    enum Built<R: tauri::Runtime> {
        Item(tauri::menu::MenuItem<R>),
        Check(tauri::menu::CheckMenuItem<R>),
        Sep(PredefinedMenuItem<R>),
        Sub(Submenu<R>),
        Pre(PredefinedMenuItem<R>),
    }
    impl<R: tauri::Runtime> Built<R> {
        fn as_item(&self) -> &dyn IsMenuItem<R> {
            match self {
                Built::Item(i) => i,
                Built::Check(i) => i,
                Built::Sep(i) => i,
                Built::Sub(i) => i,
                Built::Pre(i) => i,
            }
        }
    }

    fn predefined<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        role: &PredefinedRole,
        text: Option<&str>,
    ) -> tauri::Result<PredefinedMenuItem<R>> {
        match role {
            PredefinedRole::Undo => PredefinedMenuItem::undo(app, text),
            PredefinedRole::Redo => PredefinedMenuItem::redo(app, text),
            PredefinedRole::Cut => PredefinedMenuItem::cut(app, text),
            PredefinedRole::Copy => PredefinedMenuItem::copy(app, text),
            PredefinedRole::Paste => PredefinedMenuItem::paste(app, text),
            PredefinedRole::SelectAll => PredefinedMenuItem::select_all(app, text),
            PredefinedRole::About => {
                let meta = tauri::menu::AboutMetadata {
                    name: Some("SoloMD".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    credits: Some("Made by 智通 / xiangdong li".into()),
                    authors: Some(vec!["xiangdong li".into()]),
                    comments: Some("Lightweight, cross-platform Markdown editor.".into()),
                    website: Some("https://solomd.app".into()),
                    website_label: Some("solomd.app".into()),
                    ..Default::default()
                };
                PredefinedMenuItem::about(app, text, Some(meta))
            }
            PredefinedRole::Services => PredefinedMenuItem::services(app, text),
            PredefinedRole::Hide => PredefinedMenuItem::hide(app, text),
            PredefinedRole::HideOthers => PredefinedMenuItem::hide_others(app, text),
            PredefinedRole::ShowAll => PredefinedMenuItem::show_all(app, text),
            PredefinedRole::Quit => PredefinedMenuItem::quit(app, text),
            PredefinedRole::Minimize => PredefinedMenuItem::minimize(app, text),
            PredefinedRole::Maximize => PredefinedMenuItem::maximize(app, text),
            PredefinedRole::CloseWindow => PredefinedMenuItem::close_window(app, text),
        }
    }

    fn build_nodes<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        nodes: &[MenuNode],
    ) -> tauri::Result<Vec<Built<R>>> {
        let mut out = Vec::with_capacity(nodes.len());
        for n in nodes {
            out.push(match n {
                MenuNode::Item { id, text, accelerator, enabled } => {
                    let mut b = MenuItemBuilder::with_id(id.as_str(), text).enabled(*enabled);
                    if let Some(a) = accelerator.as_deref().filter(|a| valid_accelerator(a)) {
                        b = b.accelerator(a);
                    }
                    Built::Item(b.build(app)?)
                }
                MenuNode::Check { id, text, accelerator, enabled, checked } => {
                    let mut b = CheckMenuItemBuilder::with_id(id.as_str(), text)
                        .enabled(*enabled)
                        .checked(*checked);
                    if let Some(a) = accelerator.as_deref().filter(|a| valid_accelerator(a)) {
                        b = b.accelerator(a);
                    }
                    Built::Check(b.build(app)?)
                }
                MenuNode::Separator => Built::Sep(PredefinedMenuItem::separator(app)?),
                MenuNode::Submenu { text, items } => Built::Sub(build_submenu(app, text, items)?),
                MenuNode::Predefined { role, text } => {
                    // Services / Hide / Show All only exist on macOS; elsewhere
                    // muda builds nothing useful for them.
                    if !cfg!(target_os = "macos")
                        && matches!(
                            role,
                            PredefinedRole::Services
                                | PredefinedRole::Hide
                                | PredefinedRole::HideOthers
                                | PredefinedRole::ShowAll
                        )
                    {
                        continue;
                    }
                    Built::Pre(predefined(app, role, text.as_deref())?)
                }
            });
        }
        Ok(out)
    }

    fn build_submenu<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        text: &str,
        items: &[MenuNode],
    ) -> tauri::Result<Submenu<R>> {
        let built = build_nodes(app, items)?;
        let refs: Vec<&dyn IsMenuItem<R>> = built.iter().map(|b| b.as_item()).collect();
        SubmenuBuilder::new(app, text).items(&refs).build()
    }

    let subs = menus
        .iter()
        .map(|m| build_submenu(app, &m.text, &m.items))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn IsMenuItem<R>> = subs.iter().map(|s| s as &dyn IsMenuItem<R>).collect();
    MenuBuilder::new(app).items(&refs).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"text":"SoloMD","items":[{"kind":"predefined","role":"about"},{"kind":"separator"},
        {"kind":"item","id":"settings.open","text":"设置…","accelerator":"CmdOrCtrl+Comma","enabled":true},
        {"kind":"predefined","role":"quit","text":"退出 SoloMD"}]},
      {"text":"文件","items":[
        {"kind":"item","id":"file.new","text":"新建 Markdown","accelerator":"CmdOrCtrl+N","enabled":true},
        {"kind":"check","id":"file.autoSave","text":"自动保存","enabled":true,"checked":false},
        {"kind":"submenu","text":"打开最近","items":[{"kind":"item","id":"recent.none","text":"无","enabled":false}]}]},
      {"text":"段落","items":[{"kind":"item","id":"heading.promote","text":"提升标题级别","accelerator":"CmdOrCtrl+Equal","enabled":true}]}
    ]"#;

    #[test]
    fn parses_the_frontend_spec() {
        let menus: Vec<TopMenu> = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(menus.len(), 3);
        assert_eq!(menus[1].text, "文件");
        assert_eq!(
            item_ids(&menus),
            vec!["settings.open", "file.new", "file.autoSave", "recent.none", "heading.promote"]
        );
        match &menus[1].items[1] {
            MenuNode::Check { checked, .. } => assert!(!checked),
            other => panic!("expected a check item, got {other:?}"),
        }
    }

    #[test]
    fn accelerators_the_frontend_emits_parse() {
        // Every spelling toTauriAccelerator() produces for the shipped and
        // preset bindings (lib/keybindings.ts), plus the fixed preview-zoom one.
        for a in [
            "CmdOrCtrl+N", "CmdOrCtrl+Alt+Shift+N", "CmdOrCtrl+Comma", "CmdOrCtrl+Slash",
            "CmdOrCtrl+Alt+Slash", "CmdOrCtrl+BracketLeft", "CmdOrCtrl+Shift+BracketLeft",
            "CmdOrCtrl+Backslash", "CmdOrCtrl+Shift+Backslash", "CmdOrCtrl+Alt+ArrowRight",
            "CmdOrCtrl+Equal", "CmdOrCtrl+Minus", "CmdOrCtrl+0", "CmdOrCtrl+Shift+Equal",
            "CmdOrCtrl+Shift+0", "CmdOrCtrl+1", "CmdOrCtrl+Alt+8", "F1", "F7", "F8", "F9",
            "Shift+F3", "CmdOrCtrl+Control+=", "CmdOrCtrl+Alt+J", "CmdOrCtrl+Shift+T",
        ] {
            assert!(valid_accelerator(a), "{a} should parse");
        }
        assert!(!valid_accelerator("CmdOrCtrl+NotAKey"));
    }

    #[test]
    fn startup_menu_has_an_edit_menu() {
        let spec = startup_spec();
        assert!(spec.iter().any(|m| m.text == "Edit"));
    }
}
