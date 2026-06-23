//! Steno 应用入口点。
//!
//! 始终隐藏 Windows 控制台窗口（`windows_subsystem = "windows"`）。
//! 实际初始化逻辑在 [`steno_lib::run()`] 中。

// 始终隐藏 Windows 命令行窗口（包括 debug 构建），避免开机自启时弹出终端窗口。
// 从终端运行时 stdout 仍会输出到已附加的控制台，不会新建窗口。
#![windows_subsystem = "windows"]

/// 执行 main 流程，集中处理 main 相关的输入、错误和返回值。
fn main() {
    steno_lib::run()
}
