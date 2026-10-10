//! 音频解码与重采样。
//!
//! 这是「不再要求用户安装 ffmpeg」的关键一层：以前靠外部 ffmpeg 把任意音频转成
//! 16 kHz 单声道 wav，现在全部在进程内用纯 Rust 完成。
//!
//! 识别引擎只接受 16 kHz 单声道 f32 采样，所以这里做两件事：
//! 解码（symphonia，覆盖 m4a/aac、mp3、wav、aiff、flac、ogg/vorbis、alac、caf）
//! 与重采样（rubato 的 windowed-sinc，而不是线性插值——线性插值的混叠会直接影响识别率）。

use std::fs::File;
use std::path::Path;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// 识别引擎要求的采样率，写死是有意的：whisper 的 mel 频谱按 16 kHz 定义。
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// 重采样器一次处理的帧数。太小会放大边界损失，太大占用内存。
const RESAMPLE_CHUNK: usize = 4096;

/// 一段已解码并重采样到 16 kHz 单声道的音频。
pub struct DecodedAudio {
    /// 16 kHz 单声道 f32 采样
    pub samples: Vec<f32>,
    /// 原始采样率（仅用于展示，例如「源 44.1 kHz」）
    pub source_rate: u32,
    pub source_channels: usize,
}

impl DecodedAudio {
    /// 音频时长（秒）。以重采样后的长度为准，和送进引擎的数据严格一致。
    pub fn duration_seconds(&self) -> f64 {
        self.samples.len() as f64 / TARGET_SAMPLE_RATE as f64
    }
}

/// 把任意受支持的音频文件解码成 16 kHz 单声道 f32。
pub fn decode_to_16k(path: &Path) -> Result<DecodedAudio, String> {
    let (interleaved, source_rate, source_channels) = decode(path)?;
    if interleaved.is_empty() {
        return Err("音频里没有可用的采样数据".to_string());
    }

    let mono = downmix_to_mono(&interleaved, source_channels);
    let samples = resample_to_target(&mono, source_rate)?;

    Ok(DecodedAudio {
        samples,
        source_rate,
        source_channels,
    })
}

/// 用 symphonia 解码任意容器/编码，返回交错 f32 采样、源采样率、声道数。
fn decode(path: &Path) -> Result<(Vec<f32>, u32, usize), String> {
    let file = File::open(path).map_err(|error| format!("打开音频失败：{error}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    // 扩展名只是给探测器的提示，认不出来时它仍会按内容判断
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| format!("无法识别的音频格式：{error}"))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "文件里没有音频轨道".to_string())?;

    let params = track
        .codec_params
        .as_ref()
        .and_then(|value| value.audio())
        .ok_or_else(|| "缺少音频编解码参数".to_string())?;

    let sample_rate = params
        .sample_rate
        .ok_or_else(|| "音频没有声明采样率".to_string())?;
    let channels = params
        .channels
        .as_ref()
        .map(|value| value.count())
        .filter(|count| *count > 0)
        .unwrap_or(1);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|error| format!("不支持这种音频编码：{error}"))?;

    let target_track = track.id;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // 链式流（例如拼接过的 ogg）会要求重建解码器；对转写场景直接当作结束
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(format!("读取音频失败：{error}")),
        };

        if packet.track_id != target_track {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(buffer) => {
                scratch.resize(buffer.samples_interleaved(), 0.0);
                buffer.copy_to_slice_interleaved(&mut scratch);
                interleaved.extend_from_slice(&scratch);
            }
            // 单包损坏不该让整段音频失败：跳过它，继续解码后续
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(format!("解码音频失败：{error}")),
        }
    }

    Ok((interleaved, sample_rate, channels))
}

/// 交错多声道 → 单声道（取平均）。
fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }

    let frames = interleaved.len() / channels;
    let scale = 1.0 / channels as f32;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * channels;
        let sum: f32 = interleaved[base..base + channels].iter().sum();
        mono.push(sum * scale);
    }
    mono
}

/// 重采样到 16 kHz。已经是目标采样率时直接返回，不做无谓的重采样。
fn resample_to_target(input: &[f32], source_rate: u32) -> Result<Vec<f32>, String> {
    if source_rate == TARGET_SAMPLE_RATE || input.is_empty() {
        return Ok(input.to_vec());
    }

    let ratio = TARGET_SAMPLE_RATE as f64 / source_rate as f64;
    let parameters = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.0, parameters, RESAMPLE_CHUNK, 1)
        .map_err(|error| format!("创建重采样器失败：{error}"))?;

    // 末尾不足一块的输入补零：补出来的部分落在尾部，最后按理论长度截掉，不会影响真实信号
    let expected = (input.len() as f64 * ratio).round() as usize;
    let mut output: Vec<f32> = Vec::with_capacity(expected + RESAMPLE_CHUNK);
    let mut position = 0usize;

    while position < input.len() {
        let needed = resampler.input_frames_next();
        let end = (position + needed).min(input.len());

        let mut frame = input[position..end].to_vec();
        frame.resize(needed, 0.0);

        let produced = resampler
            .process(&[frame], None)
            .map_err(|error| format!("重采样失败：{error}"))?;
        output.extend_from_slice(&produced[0]);
        position = end;
    }

    output.truncate(expected);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{downmix_to_mono, resample_to_target, DecodedAudio, TARGET_SAMPLE_RATE};

    #[test]
    fn averages_channels_into_mono() {
        // 左右两声道分别是 1.0 与 0.0，取平均应为 0.5
        let interleaved = [1.0, 0.0, 1.0, 0.0];
        assert_eq!(downmix_to_mono(&interleaved, 2), vec![0.5, 0.5]);
    }

    #[test]
    fn keeps_single_channel_untouched() {
        let interleaved = [0.25, -0.5, 0.75];
        assert_eq!(downmix_to_mono(&interleaved, 1), vec![0.25, -0.5, 0.75]);
    }

    #[test]
    fn treats_short_tail_as_a_whole_frame() {
        // 声道数写错时不能 panic，多余的那半帧直接丢弃
        let interleaved = [1.0, 1.0, 1.0];
        assert_eq!(downmix_to_mono(&interleaved, 2), vec![1.0]);
    }

    #[test]
    fn skips_resampling_when_already_at_target_rate() {
        let input: Vec<f32> = (0..100).map(|value| value as f32).collect();
        let output = resample_to_target(&input, TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(output, input);
    }

    #[test]
    fn halves_the_length_when_rate_is_halved() {
        // 32 kHz → 16 kHz，长度应大致减半
        let input = vec![0.1f32; 32_000];
        let output = resample_to_target(&input, 32_000).unwrap();
        assert!(
            (output.len() as i64 - 16_000).abs() <= 2,
            "期望约 16000 个采样，实际 {}",
            output.len()
        );
    }

    #[test]
    fn converts_44100_to_16k_with_expected_length() {
        // 44.1 kHz 是录音最常见的采样率，长度换算必须准，否则时间轴会整体偏移
        let input = vec![0.0f32; 44_100];
        let output = resample_to_target(&input, 44_100).unwrap();
        assert!(
            (output.len() as i64 - 16_000).abs() <= 2,
            "期望约 16000 个采样，实际 {}",
            output.len()
        );
    }

    #[test]
    fn reports_duration_from_resampled_samples() {
        let audio = DecodedAudio {
            samples: vec![0.0; 32_000],
            source_rate: 48_000,
            source_channels: 2,
        };
        assert!((audio.duration_seconds() - 2.0).abs() < 1e-9);
    }
}
