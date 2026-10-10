//! 转写历史持久化（SQLite）。
//!
//! 为什么必须有：转写一小时录音要几分钟，但如果应用一关就什么都不剩，
//! 「点段落跳播放 + 高亮跟随」这个核心卖点就只能在当次会话里享受。
//! 所以这里不只存文本，还存**分段与时间轴**——重启后能原样恢复逐字稿面板。
//!
//! 分段与产物路径以 JSON 存进同一张表：它们只在读取历史时整体使用，
//! 拆成关联表只会让读取多一次 join，带不来任何查询收益。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::engine::AppState;
use crate::output::Segment;

/// 建表语句。用 `user_version` 做迁移版本，避免自己维护一张版本表。
const SCHEMA_VERSION: i64 = 1;

/// 历史列表项：不含分段与全文，避免一次查询把几百条长文本全读进内存。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub id: i64,
    pub name: String,
    pub source_path: String,
    pub output_dir: String,
    pub model_id: String,
    pub language: String,
    pub duration_seconds: f64,
    pub segment_count: i64,
    /// 创建时间（Unix 毫秒），前端自己格式化成本地时间
    pub created_at: i64,
}

/// 完整历史条目：列表项 + 全文 + 分段 + 产物路径。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(flatten)]
    pub summary: HistorySummary,
    pub text: String,
    pub segments: Vec<Segment>,
    /// 产物路径表（txt / srt / vtt / json）；文件可能已被用户删掉
    pub files: HashMap<String, String>,
}

/// 待写入的一条历史。
pub struct NewHistoryEntry {
    pub name: String,
    pub source_path: String,
    pub output_dir: String,
    pub model_id: String,
    pub language: String,
    pub duration_seconds: f64,
    pub text: String,
    pub segments: Vec<Segment>,
    pub files: HashMap<String, String>,
}

/// 历史库。`Connection` 不是 `Sync`，用一个 Mutex 串行化访问。
pub struct HistoryStore {
    connection: Mutex<Connection>,
}

impl HistoryStore {
    /// 打开（或创建）历史库，并把 schema 迁到当前版本。
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建历史库目录：{error}"))?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("无法打开历史库 {}：{error}", path.display()))?;
        Self::prepare(connection)
    }

    /// 内存库，仅供测试使用。
    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        let connection =
            Connection::open_in_memory().map_err(|error| format!("无法创建内存库：{error}"))?;
        Self::prepare(connection)
    }

    fn prepare(connection: Connection) -> Result<Self, String> {
        // 转写结果宁可慢一点也不能因为断电丢历史
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("设置 WAL 失败：{error}"))?;

        let store = Self {
            connection: Mutex::new(connection),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;

        let current: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("读取 schema 版本失败：{error}"))?;

        if current >= SCHEMA_VERSION {
            return Ok(());
        }

        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS transcriptions (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    name             TEXT    NOT NULL,
                    source_path      TEXT    NOT NULL,
                    output_dir       TEXT    NOT NULL,
                    model_id         TEXT    NOT NULL,
                    language         TEXT    NOT NULL,
                    duration_seconds REAL    NOT NULL,
                    segment_count    INTEGER NOT NULL,
                    text             TEXT    NOT NULL,
                    files            TEXT    NOT NULL,
                    segments         TEXT    NOT NULL,
                    created_at       INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at
                    ON transcriptions (created_at DESC);",
            )
            .map_err(|error| format!("建立历史表失败：{error}"))?;

        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| format!("写入 schema 版本失败：{error}"))?;

        Ok(())
    }

    /// 写入一条历史，返回新建的 id。
    pub fn record(&self, entry: NewHistoryEntry) -> Result<i64, String> {
        let files = serde_json::to_string(&entry.files)
            .map_err(|error| format!("序列化产物路径失败：{error}"))?;
        let segments = serde_json::to_string(&entry.segments)
            .map_err(|error| format!("序列化分段失败：{error}"))?;

        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;

        connection
            .execute(
                "INSERT INTO transcriptions
                    (name, source_path, output_dir, model_id, language,
                     duration_seconds, segment_count, text, files, segments, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    entry.name,
                    entry.source_path,
                    entry.output_dir,
                    entry.model_id,
                    entry.language,
                    entry.duration_seconds,
                    entry.segments.len() as i64,
                    entry.text,
                    files,
                    segments,
                    now_millis(),
                ],
            )
            .map_err(|error| format!("写入历史失败：{error}"))?;

        Ok(connection.last_insert_rowid())
    }

    /// 按时间倒序列出历史摘要。
    pub fn list(&self, limit: usize) -> Result<Vec<HistorySummary>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;

        let mut statement = connection
            .prepare(
                "SELECT id, name, source_path, output_dir, model_id, language,
                        duration_seconds, segment_count, created_at
                 FROM transcriptions
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|error| format!("准备查询失败：{error}"))?;

        let rows = statement
            .query_map(params![limit as i64], |row| {
                Ok(HistorySummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_path: row.get(2)?,
                    output_dir: row.get(3)?,
                    model_id: row.get(4)?,
                    language: row.get(5)?,
                    duration_seconds: row.get(6)?,
                    segment_count: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|error| format!("查询历史失败：{error}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取历史失败：{error}"))
    }

    /// 读取单条完整历史（含分段，用于恢复逐字稿与时间轴）。
    pub fn get(&self, id: i64) -> Result<Option<HistoryEntry>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;

        let mut statement = connection
            .prepare(
                "SELECT id, name, source_path, output_dir, model_id, language,
                        duration_seconds, segment_count, created_at, text, files, segments
                 FROM transcriptions WHERE id = ?1",
            )
            .map_err(|error| format!("准备查询失败：{error}"))?;

        let mut rows = statement
            .query(params![id])
            .map_err(|error| format!("查询历史失败：{error}"))?;

        let Some(row) = rows
            .next()
            .map_err(|error| format!("读取历史失败：{error}"))?
        else {
            return Ok(None);
        };

        let files_json: String = row.get(10).map_err(|error| format!("读取失败：{error}"))?;
        let segments_json: String = row.get(11).map_err(|error| format!("读取失败：{error}"))?;

        Ok(Some(HistoryEntry {
            summary: HistorySummary {
                id: row.get(0).map_err(|error| format!("读取失败：{error}"))?,
                name: row.get(1).map_err(|error| format!("读取失败：{error}"))?,
                source_path: row.get(2).map_err(|error| format!("读取失败：{error}"))?,
                output_dir: row.get(3).map_err(|error| format!("读取失败：{error}"))?,
                model_id: row.get(4).map_err(|error| format!("读取失败：{error}"))?,
                language: row.get(5).map_err(|error| format!("读取失败：{error}"))?,
                duration_seconds: row.get(6).map_err(|error| format!("读取失败：{error}"))?,
                segment_count: row.get(7).map_err(|error| format!("读取失败：{error}"))?,
                created_at: row.get(8).map_err(|error| format!("读取失败：{error}"))?,
            },
            text: row.get(9).map_err(|error| format!("读取失败：{error}"))?,
            files: serde_json::from_str(&files_json).unwrap_or_default(),
            // 旧版本可能存了损坏的 JSON，这种情况下退回空分段而不是整条历史读不出来
            segments: serde_json::from_str(&segments_json).unwrap_or_default(),
        }))
    }

    pub fn delete(&self, id: i64) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;
        connection
            .execute("DELETE FROM transcriptions WHERE id = ?1", params![id])
            .map_err(|error| format!("删除历史失败：{error}"))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;
        connection
            .execute("DELETE FROM transcriptions", [])
            .map_err(|error| format!("清空历史失败：{error}"))?;
        Ok(())
    }

    /// 当前历史条数。目前只有测试用得到——界面上的条数直接由列表长度得出。
    #[cfg(test)]
    pub fn count(&self) -> Result<i64, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史库连接已损坏".to_string())?;
        connection
            .query_row("SELECT COUNT(*) FROM transcriptions", [], |row| row.get(0))
            .map_err(|error| format!("统计历史失败：{error}"))
    }
}

/// Unix 毫秒。用系统时间就够了，不引入时间库。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 暴露给前端的命令
// ---------------------------------------------------------------------------

/// 默认最多返回多少条历史。列表只取摘要，几百条也只是一次轻量查询。
const DEFAULT_HISTORY_LIMIT: usize = 200;

#[tauri::command]
pub fn list_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<HistorySummary>, String> {
    state.history.list(limit.unwrap_or(DEFAULT_HISTORY_LIMIT))
}

/// 读取单条完整历史（含分段），用于选中历史任务时恢复逐字稿与时间轴。
#[tauri::command]
pub fn get_history_entry(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<HistoryEntry>, String> {
    state.history.get(id)
}

#[tauri::command]
pub fn delete_history_entry(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.history.delete(id)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.history.clear()
}

#[cfg(test)]
mod tests {
    use super::{HistoryStore, NewHistoryEntry};
    use crate::output::Segment;
    use std::collections::HashMap;

    fn sample(name: &str) -> NewHistoryEntry {
        NewHistoryEntry {
            name: name.to_string(),
            source_path: format!("/audio/{name}.m4a"),
            output_dir: format!("/audio/{name}"),
            model_id: "large-v3-turbo-q5_0".to_string(),
            language: "zh".to_string(),
            duration_seconds: 66.8,
            text: "这是逐字稿全文".to_string(),
            segments: vec![
                Segment {
                    start: 0.0,
                    end: 6.24,
                    text: "第一段".to_string(),
                },
                Segment {
                    start: 6.24,
                    end: 15.74,
                    text: "第二段".to_string(),
                },
            ],
            files: HashMap::from([("txt".to_string(), format!("/audio/{name}/{name}.txt"))]),
        }
    }

    #[test]
    fn records_and_reads_back_the_full_entry() {
        let store = HistoryStore::in_memory().unwrap();
        let id = store.record(sample("interview")).unwrap();

        let entry = store.get(id).unwrap().expect("刚写入的历史必须读得回来");
        assert_eq!(entry.summary.name, "interview");
        assert_eq!(entry.summary.segment_count, 2);
        assert_eq!(entry.text, "这是逐字稿全文");
        // 分段必须能恢复，否则重启后时间轴联动就没了
        assert_eq!(entry.segments.len(), 2);
        assert_eq!(entry.segments[1].text, "第二段");
        assert_eq!(
            entry.files.get("txt").unwrap(),
            "/audio/interview/interview.txt"
        );
    }

    #[test]
    fn lists_newest_first() {
        let store = HistoryStore::in_memory().unwrap();
        store.record(sample("first")).unwrap();
        store.record(sample("second")).unwrap();

        let list = store.list(10).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "second", "最新的应当排在最前面");
    }

    #[test]
    fn respects_the_list_limit() {
        let store = HistoryStore::in_memory().unwrap();
        for index in 0..5 {
            store.record(sample(&format!("job-{index}"))).unwrap();
        }
        assert_eq!(store.list(3).unwrap().len(), 3);
    }

    #[test]
    fn missing_id_returns_none_instead_of_failing() {
        let store = HistoryStore::in_memory().unwrap();
        assert!(store.get(999).unwrap().is_none());
    }

    #[test]
    fn deletes_a_single_entry() {
        let store = HistoryStore::in_memory().unwrap();
        let id = store.record(sample("keep")).unwrap();
        let other = store.record(sample("drop")).unwrap();

        store.delete(other).unwrap();

        assert_eq!(store.count().unwrap(), 1);
        assert!(store.get(other).unwrap().is_none());
        assert!(store.get(id).unwrap().is_some());
    }

    #[test]
    fn clears_everything() {
        let store = HistoryStore::in_memory().unwrap();
        store.record(sample("a")).unwrap();
        store.record(sample("b")).unwrap();

        store.clear().unwrap();

        assert_eq!(store.count().unwrap(), 0);
        assert!(store.list(10).unwrap().is_empty());
    }

    #[test]
    fn keeps_unicode_and_special_characters_intact() {
        // 中文、引号与换行都要能原样存回，json 序列化不能把它们吃掉
        let store = HistoryStore::in_memory().unwrap();
        let mut entry = sample("中文 & \"引号\"");
        entry.text = "第一行\n第二行\t带制表符".to_string();
        let id = store.record(entry).unwrap();

        let back = store.get(id).unwrap().unwrap();
        assert_eq!(back.text, "第一行\n第二行\t带制表符");
        assert_eq!(back.summary.name, "中文 & \"引号\"");
    }

    #[test]
    fn reopening_the_same_file_keeps_the_history() {
        // 复盘的核心诉求：重启应用后历史还在
        let dir = std::env::temp_dir().join("zhuanyin-history-test");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("history.db");

        {
            let store = HistoryStore::open(&path).unwrap();
            store.record(sample("persisted")).unwrap();
        }
        {
            let reopened = HistoryStore::open(&path).unwrap();
            assert_eq!(reopened.count().unwrap(), 1);
            assert_eq!(reopened.list(10).unwrap()[0].name, "persisted");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
