//! Tauri 后端 - clipboard。
//!
//! 实现 clipboard 相关的后端能力，连接 Tauri 命令、系统资源和本地数据持久化。
//! 注释重点标明命令入口、数据持久化边界、线程/锁使用和与前端交互的风险点。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use arboard::{Clipboard, ImageData};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::Db;

/// 粘贴板条目新增或更新后广播；前端 store 收到后 upsert 到本地列表。
pub const CLIPBOARD_UPDATED_EVENT: &str = "steno:clipboard-updated";
/// 单条粘贴板条目被删除后广播；前端收到后从列表移除对应卡片。
pub const CLIPBOARD_REMOVED_EVENT: &str = "steno:clipboard-removed";
/// 清空全部非置顶条目后广播；前端据此重置列表。
pub const CLIPBOARD_CLEARED_EVENT: &str = "steno:clipboard-cleared";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    pub content_type: String,
    pub content: String,
    #[serde(default)]
    pub html_content: Option<String>,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub pinned_at: Option<String>,
    /// 最近一次"使用"（复制 / 粘贴 / 编辑 / 新建）的时间，用于列表排序与卡片时间显示。
    /// 与 `updated_at`（内容修改时间，决定"已修改"标记）解耦：复制/粘贴只刷新它。
    #[serde(default)]
    pub last_used_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewClipboardEntry {
    pub content_type: String,
    pub content: String,
    pub html_content: Option<String>,
    pub preview: String,
    pub content_hash: String,
    pub size_bytes: i64,
}

/// 把原始剪贴板文本分类并构造待入库条目；空白文本返回 `None`（不入库）。
///
/// 分类顺序由 [`detect_text_type`] 决定（file > url > code > text），
/// 同时派生 `preview` 和 `content_hash`（后者用于去重 UPSERT）。
pub fn classify_text(raw: &str) -> Option<NewClipboardEntry> {
    let content = normalize_text(raw);
    if content.trim().is_empty() {
        return None;
    }

    let content_type = detect_text_type(&content);
    let preview = build_preview(&content_type, &content, None);
    let content_hash = build_content_hash(&content_type, &content, None);
    let size_bytes = content.as_bytes().len() as i64;

    Some(NewClipboardEntry {
        content_type,
        content,
        html_content: None,
        preview,
        content_hash,
        size_bytes,
    })
}

/// 把图片 data URL 构造成 `image` 类型待入库条目（用于图片编辑后入库或直接捕获）。
pub fn image_entry_from_data_url(data_url: String) -> Option<NewClipboardEntry> {
    if !data_url.starts_with("data:image/") {
        return None;
    }
    let content_hash = build_content_hash("image", &data_url, None);
    Some(NewClipboardEntry {
        content_type: "image".to_string(),
        content: data_url.clone(),
        html_content: None,
        preview: "图片内容".to_string(),
        content_hash,
        size_bytes: data_url.as_bytes().len() as i64,
    })
}

/// 生成卡片预览文本：图片固定文案、富文本取 HTML 纯文本、文件取首行、其余取原文。
/// 结果会折叠空白并截断到 160 字符，保证卡片高度一致。
pub fn build_preview(content_type: &str, content: &str, html_content: Option<&str>) -> String {
    let source = match content_type {
        "image" => "图片内容".to_string(),
        "rich_text" => html_content
            .map(strip_html_tags)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| content.to_string()),
        "file" => content.lines().next().unwrap_or(content).to_string(),
        _ => content.to_string(),
    };

    truncate_chars(&collapse_preview_whitespace(&source), 160)
}

/// 计算内容去重哈希：`{content_type}:{hash}`。组合类型确保相同正文不同类型不会误判为重复。
/// 用 `DefaultHasher` 足够（非安全场景），输出定长 16 位十六进制。
pub fn build_content_hash(content_type: &str, content: &str, html_content: Option<&str>) -> String {
    let mut hasher = DefaultHasher::new();
    content_type.hash(&mut hasher);
    content.hash(&mut hasher);
    html_content.unwrap_or("").hash(&mut hasher);
    format!("{content_type}:{:016x}", hasher.finish())
}

/// 读取当前系统剪贴板并构造待入库条目；优先文本，其次图片，都没有则返回 `None`。
pub fn entry_from_system_clipboard() -> Option<NewClipboardEntry> {
    let mut clipboard = Clipboard::new().ok()?;
    if let Ok(text) = clipboard.get_text() {
        if let Some(entry) = classify_text(&text) {
            return Some(entry);
        }
    }
    if let Ok(image) = clipboard.get_image() {
        if let Some(data_url) = image_data_url(image) {
            return image_entry_from_data_url(data_url);
        }
    }
    None
}

/// 把一条历史条目写回系统剪贴板（图片走 set_image，其余走 set_text）。
///
/// 写入后调用 `echo.remember_current()` 登记回显标记，让监视线程下次轮询时
/// 跳过这条"Steno 自身写入"的内容，避免重复入库和误刷 `updated_at`。
pub fn write_entry_to_system_clipboard(
    entry: &ClipboardEntry,
    echo: &ClipboardEcho,
) -> Result<(), String> {
    {
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        if entry.content_type == "image" && entry.content.starts_with("data:image/") {
            let image = image_data_url_to_arboard(&entry.content)?;
            clipboard.set_image(image).map_err(|e| e.to_string())?;
        } else {
            clipboard
                .set_text(entry.content.clone())
                .map_err(|e| e.to_string())?;
        }
    } // 先释放写句柄，再读回，避免在同一作用域内持有两个 Clipboard。
      // 记录"自身写入回显"：读回剪贴板真实内容的 hash，供监视器下次轮询时跳过，
      // 避免把 Steno 自己的复制/粘贴当成新内容而 bump updated_at。
    echo.remember_current();
    Ok(())
}

/// 把图片 data URL 写回系统剪贴板（图片编辑器"复制"按钮专用，不入库不登记回显）。
pub fn write_image_data_url_to_system_clipboard(data_url: &str) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let image = image_data_url_to_arboard(data_url)?;
    clipboard.set_image(image).map_err(|e| e.to_string())
}

/// 把历史条目粘贴到当前光标位置：先写系统剪贴板（含回显登记），再模拟 Ctrl+V。
pub fn paste_entry_to_active_cursor(
    entry: &ClipboardEntry,
    echo: &ClipboardEcho,
) -> Result<(), String> {
    write_entry_to_system_clipboard(entry, echo)?;
    trigger_system_paste()
}

#[cfg(target_os = "windows")]
fn trigger_system_paste() -> Result<(), String> {
    let script = "$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 120; $wshell.SendKeys('^v')";
    let status = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("触发粘贴快捷键失败：{status}"))
    }
}

#[cfg(target_os = "macos")]
fn trigger_system_paste() -> Result<(), String> {
    let status = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to keystroke \"v\" using command down",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("触发粘贴快捷键失败：{status}"))
    }
}

#[cfg(target_os = "linux")]
fn trigger_system_paste() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "ctrl+v"])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("触发粘贴快捷键失败：{status}"))
    }
}

/// 判断本次轮询到的 hash 是否需要处理：与上次不同才算"新内容"。
pub fn should_process_hash(last_hash: Option<&str>, next_hash: &str) -> bool {
    last_hash != Some(next_hash)
}

/// 记录 Steno 自己写入系统剪贴板的内容（复制 / 粘贴）的"回显"标记。
///
/// 监视器轮询到剪贴板变化时会先比对此标记：若本次变化正是 Steno 自身刚写入的
/// 内容，则跳过入库，避免无谓地 bump `updated_at`（否则会导致卡片错误地重排到
/// 列表顶部、并被打上"已修改"标记）。标记带 [`ClipboardEcho::TTL`] 过期时间，
/// 超时即失效，防止误伤后续用户真实的相同内容复制。
#[derive(Clone, Default)]
pub struct ClipboardEcho {
    inner: Arc<Mutex<Option<EchoMark>>>,
}

/// 回显标记内部状态：记录的 hash 和写入时刻（用于 TTL 过期判断）。
struct EchoMark {
    hash: String,
    at: Instant,
}

/// `ClipboardEcho` 的行为实现：登记自身写入、消费匹配的回显、自动清理过期标记。
impl ClipboardEcho {
    /// 回显标记有效期：监视器轮询间隔为 600ms，2s 足够覆盖一次自身写入的回显，
    /// 同时足够短以避免长期残留误伤后续复制。
    const TTL: Duration = Duration::from_secs(2);

    /// 直接记录一个 hash（带当前时间戳）。
    fn remember(&self, hash: String) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(EchoMark {
                hash,
                at: Instant::now(),
            });
        }
    }

    /// 读回当前系统剪贴板内容并记录其 hash。
    ///
    /// 这正是监视器下次轮询时会算出的 hash，因此对文本 / 图片都能精确匹配，
    /// 无需预测文本分类结果或图片重编码后的字节。
    pub fn remember_current(&self) {
        if let Some(entry) = entry_from_system_clipboard() {
            self.remember(entry.content_hash);
        }
    }

    /// 若 `hash` 与未过期的回显标记匹配，则消费该标记并返回 `true`（应跳过入库）。
    /// 顺带清理已过期的标记。
    pub fn take_if_matches(&self, hash: &str) -> bool {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mark) = guard.as_ref() {
                if mark.at.elapsed() > Self::TTL {
                    *guard = None;
                } else if mark.hash == hash {
                    *guard = None;
                    return true;
                }
            }
        }
        false
    }
}

/// 启动剪贴板监视线程。在 `lib.rs::run().setup()` 中调用一次，进程生命周期内常驻。
///
/// 线程每 600ms 轮询一次系统剪贴板：hash 变化 → 跳过自身回显 → UPSERT 入库 →
/// 广播 `CLIPBOARD_UPDATED_EVENT`。出错只打日志不退出，保证监视持续运行。
pub fn start_monitor(app: AppHandle, db: Db, echo: ClipboardEcho) {
    thread::spawn(move || {
        let mut last_hash = entry_from_system_clipboard().map(|entry| entry.content_hash);
        loop {
            thread::sleep(Duration::from_millis(600));
            let Some(entry) = entry_from_system_clipboard() else {
                continue;
            };
            if !should_process_hash(last_hash.as_deref(), &entry.content_hash) {
                continue;
            }
            last_hash = Some(entry.content_hash.clone());
            // 跳过 Steno 自身复制 / 粘贴写入剪贴板产生的回显，避免 bump updated_at
            // 导致卡片重排与误报"已修改"。
            if echo.take_if_matches(&entry.content_hash) {
                continue;
            }
            match db.upsert_clipboard_entry(entry) {
                Ok(saved) => {
                    let _ = app.emit(CLIPBOARD_UPDATED_EVENT, saved);
                }
                Err(error) => {
                    eprintln!("[clipboard] failed to save clipboard entry: {error}");
                }
            }
        }
    });
}

/// 统一换行符为 `\n` 并去除首尾空白；保证相同内容跨平台产生相同 hash。
fn normalize_text(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

/// 文本类型检测（决定 content_type 与卡片图标）。优先级：file > url > code > text。
fn detect_text_type(content: &str) -> String {
    if is_existing_path_list(content) {
        return "file".to_string();
    }
    if is_url(content) {
        return "url".to_string();
    }
    if looks_like_code(content) {
        return "code".to_string();
    }
    "text".to_string()
}

/// 判断文本是否为单个 URL（无空白 + 常见协议前缀或 www. 开头）。
fn is_url(content: &str) -> bool {
    let value = content.trim();
    if value.contains(char::is_whitespace) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ftp://")
        || lower.starts_with("file://")
        || lower.starts_with("www.")
}

/// 启发式判断文本是否像代码：多行 + 含 `function`/`const`/`fn`/`=>` 等语言关键字。
fn looks_like_code(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    let code_signals = [
        "function ",
        "const ",
        "let ",
        "var ",
        "class ",
        "import ",
        "export ",
        "=>",
        "fn ",
        "pub ",
        "#include",
        "select ",
    ];
    content.lines().count() >= 2 && code_signals.iter().any(|signal| lower.contains(signal))
}

/// 判断文本是否为"全部都存在的路径列表"（每行都是一个真实存在的文件/目录路径）。
fn is_existing_path_list(content: &str) -> bool {
    let paths: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    !paths.is_empty() && paths.iter().all(|path| Path::new(path).exists())
}

/// 把任意空白序列折叠成单个空格，让预览单行显示且不会因缩进错乱。
fn collapse_preview_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 按 Unicode 字符（而非字节）截断，避免把多字节字符切成乱码。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// 极简 HTML 标签剥离（状态机：遇 `<` 进标签、遇 `>` 出标签，只保留标签外文本）。
/// 不做实体解码，仅供预览展示用途。
fn strip_html_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut inside_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(ch),
            _ => {}
        }
    }
    output
}

/// 把 arboard 读到的 RGBA 图片编码成 `data:image/png;base64,...` 字符串，便于入库和回显哈希。
fn image_data_url(image: ImageData<'_>) -> Option<String> {
    let width = image.width as u32;
    let height = image.height as u32;
    let bytes = image.bytes.into_owned();
    let rgba = image::RgbaImage::from_raw(width, height, bytes)?;
    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

/// 反向：把 data URL 解码成 arboard 可写的 `ImageData`（统一转 RGBA8，兼容不同源格式）。
fn image_data_url_to_arboard(data_url: &str) -> Result<ImageData<'static>, String> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "图片 data URL 格式无效".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let dynamic = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let rgba = dynamic.to_rgba8();
    let width = rgba.width() as usize;
    let height = rgba.height() as usize;
    Ok(ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_url_text() {
        let entry = classify_text(" https://example.com/a?q=1 ").expect("entry");
        assert_eq!(entry.content_type, "url");
        assert_eq!(entry.content, "https://example.com/a?q=1");
        assert_eq!(entry.preview, "https://example.com/a?q=1");
        assert!(entry.content_hash.starts_with("url:"));
    }

    #[test]
    fn classify_code_text() {
        let entry =
            classify_text("const value = 1;\nfunction run() { return value; }").expect("entry");
        assert_eq!(entry.content_type, "code");
        assert!(entry.preview.contains("const value"));
    }

    #[test]
    fn classify_existing_windows_path_as_file() {
        let current = std::env::current_dir().unwrap();
        let entry = classify_text(&current.to_string_lossy()).expect("entry");
        assert_eq!(entry.content_type, "file");
    }

    #[test]
    fn ignores_empty_text() {
        assert!(classify_text("  \n\t  ").is_none());
    }

    #[test]
    fn truncates_long_preview_on_char_boundary() {
        let content = "字".repeat(240);
        let preview = build_preview("text", &content, None);
        assert_eq!(preview.chars().count(), 160);
    }

    #[test]
    fn image_entry_uses_data_url_hash() {
        let data_url = "data:image/png;base64,AAAA".to_string();
        let entry = image_entry_from_data_url(data_url.clone()).expect("entry");
        assert_eq!(entry.content_type, "image");
        assert_eq!(entry.content, data_url);
        assert_eq!(entry.preview, "图片内容");
        assert!(entry.content_hash.starts_with("image:"));
        assert_eq!(entry.size_bytes, "data:image/png;base64,AAAA".len() as i64);
    }

    #[test]
    fn image_entry_rejects_non_image_data_url() {
        assert!(image_entry_from_data_url("data:text/plain;base64,AAAA".to_string()).is_none());
    }

    #[test]
    fn image_data_url_to_arboard_rejects_non_image() {
        assert!(image_data_url_to_arboard("data:text/plain;base64,AAAA").is_err());
    }

    #[test]
    fn should_process_hash_skips_unchanged_clipboard_content() {
        assert!(!should_process_hash(Some("text:abc"), "text:abc"));
    }

    #[test]
    fn should_process_hash_accepts_first_or_changed_clipboard_content() {
        assert!(should_process_hash(None, "text:abc"));
        assert!(should_process_hash(Some("text:abc"), "text:def"));
    }

    #[test]
    fn echo_matches_then_consumes_self_write() {
        // 模拟 Steno 自身写入剪贴板后记下回显 hash；监视器轮询到同一 hash 时应跳过，
        // 且仅跳过一次（消费后再查为 false），避免误伤后续真实复制。
        let echo = ClipboardEcho::default();
        echo.remember("text:abc".to_string());
        assert!(echo.take_if_matches("text:abc"));
        assert!(!echo.take_if_matches("text:abc"));
    }

    #[test]
    fn echo_ignores_non_matching_hash_and_retains_mark() {
        // 不匹配的 hash 不应消费标记：真实的新内容照常入库，自身写入回显仍待命。
        let echo = ClipboardEcho::default();
        echo.remember("text:abc".to_string());
        assert!(!echo.take_if_matches("text:def"));
        assert!(echo.take_if_matches("text:abc"));
    }
}
