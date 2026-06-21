//! 本地数据与文件系统模块。
//!
//! 聚合 SQLite 数据访问、工作区文件扫描、备份、同步预留接口和后台清理任务。

pub(crate) mod backup;
pub(crate) mod cleanup_scheduler;
pub(crate) mod db;
pub(crate) mod sync;
pub(crate) mod workspace_fs;
