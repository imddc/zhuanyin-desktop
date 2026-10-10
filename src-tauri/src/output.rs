//! 产物写出：txt / srt / vtt / json。
//!
//! 一个任务一个文件夹，四种格式同名。时间轴格式必须严格正确——srt 用逗号分隔毫秒、
//! vtt 用点，且都是 `HH:MM:SS`，写错了播放器就整条字幕失效。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 一段识别结果。`start` / `end` 单位是秒。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 写出结果后回给前端的产物路径表（键是格式名）。
pub type WrittenFiles = HashMap<String, String>;

/// 秒 → `HH:MM:SS<sep>mmm`。
///
/// 负数与 NaN 一律当 0：时间轴出现负值会让播放器直接拒绝整条字幕。
fn format_timestamp(seconds: f64, separator: char) -> String {
    let safe = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    };

    let total_ms = (safe * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let millis = total_ms % 1000;

    format!("{hours:02}:{minutes:02}:{secs:02}{separator}{millis:03}")
}

fn render_srt(segments: &[Segment]) -> String {
    let mut blocks = String::new();
    for (index, segment) in segments.iter().enumerate() {
        blocks.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            format_timestamp(segment.start, ','),
            format_timestamp(segment.end, ','),
            segment.text.trim()
        ));
    }
    blocks.trim_end().to_string()
}

fn render_vtt(segments: &[Segment]) -> String {
    let mut blocks = String::from("WEBVTT\n");
    for segment in segments {
        blocks.push_str(&format!(
            "\n{} --> {}\n{}\n",
            format_timestamp(segment.start, '.'),
            format_timestamp(segment.end, '.'),
            segment.text.trim()
        ));
    }
    blocks
}

/// 写入四种产物，返回 `{格式: 绝对路径}`。
///
/// json 只保留 start / end / text：识别引擎的原始段还带 token 级调试信息，
/// 落盘会让文件膨胀几十倍，界面也用不到。
pub fn write_outputs(
    out_dir: &Path,
    name: &str,
    text: &str,
    language: &str,
    duration: f64,
    segments: &[Segment],
) -> Result<WrittenFiles, String> {
    std::fs::create_dir_all(out_dir)
        .map_err(|error| format!("无法创建产物目录 {}：{error}", out_dir.display()))?;

    let mut written = WrittenFiles::new();

    let txt_path = out_dir.join(format!("{name}.txt"));
    write_file(&txt_path, &format!("{}\n", text.trim()))?;
    written.insert("txt".to_string(), txt_path.display().to_string());

    let srt_path = out_dir.join(format!("{name}.srt"));
    write_file(&srt_path, &format!("{}\n", render_srt(segments)))?;
    written.insert("srt".to_string(), srt_path.display().to_string());

    let vtt_path = out_dir.join(format!("{name}.vtt"));
    write_file(&vtt_path, &render_vtt(segments))?;
    written.insert("vtt".to_string(), vtt_path.display().to_string());

    let json_path = out_dir.join(format!("{name}.json"));
    let payload = serde_json::json!({
        "text": text,
        "language": language,
        "duration": duration,
        "segments": segments,
    });
    let json_text = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("序列化 json 失败：{error}"))?;
    write_file(&json_path, &json_text)?;
    written.insert("json".to_string(), json_path.display().to_string());

    Ok(written)
}

fn write_file(path: &PathBuf, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|error| format!("写入 {} 失败：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{format_timestamp, render_srt, render_vtt, Segment};

    fn segment(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.to_string(),
        }
    }

    #[test]
    fn formats_zero_for_srt() {
        assert_eq!(format_timestamp(0.0, ','), "00:00:00,000");
    }

    #[test]
    fn formats_hours_minutes_seconds_and_millis() {
        // 1 小时 2 分 3.456 秒，是最容易在进位处写错的边界
        assert_eq!(format_timestamp(3723.456, ','), "01:02:03,456");
    }

    #[test]
    fn uses_dot_for_vtt() {
        assert_eq!(format_timestamp(1.25, '.'), "00:00:01.250");
    }

    #[test]
    fn clamps_negative_and_nan_to_zero() {
        // 时间轴出现负值会让播放器拒绝整条字幕
        assert_eq!(format_timestamp(-5.0, ','), "00:00:00,000");
        assert_eq!(format_timestamp(f64::NAN, ','), "00:00:00,000");
    }

    #[test]
    fn rounds_millis_instead_of_truncating() {
        // 1.9995 秒应当进位到 2.000，而不是截断成 1.999
        assert_eq!(format_timestamp(1.9996, ','), "00:00:02,000");
    }

    #[test]
    fn numbers_srt_blocks_from_one_and_keeps_timeline() {
        let srt = render_srt(&[segment(0.0, 6.24, "第一段"), segment(6.24, 15.74, "第二段")]);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:06,240\n第一段"));
        assert!(srt.contains("2\n00:00:06,240 --> 00:00:15,740\n第二段"));
    }

    #[test]
    fn starts_vtt_with_the_required_header() {
        let vtt = render_vtt(&[segment(0.0, 1.0, "文本")]);
        assert!(vtt.starts_with("WEBVTT\n"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:01.000"));
        assert!(!vtt.contains(','));
    }

    #[test]
    fn trims_segment_text_so_subtitles_have_no_stray_blank_lines() {
        let srt = render_srt(&[segment(0.0, 1.0, "  前后都有空白  ")]);
        assert!(srt.ends_with("前后都有空白"));
    }
}
