//! 应用运行时集成模块。
//!
//! 聚合窗口管理、速记窗口、快捷键、托盘和日志等与桌面运行环境直接相关的能力。

pub(crate) mod logging;
pub(crate) mod quicknote;
pub(crate) mod shortcut;
pub(crate) mod tray;
pub(crate) mod window_manager;
