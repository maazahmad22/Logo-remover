import { processCanvasFrame, clearTemporalCache, type ProcessingConfig, type RenderQuality } from './watermark-engine';

export interface OfflineExportOptions {
  config: ProcessingConfig;
  quality: RenderQuality;
  /** Called with 0..1 as frames are processed. */
  onProgress?: (fraction: number, framesDone: number) => void;
  signal?: AbortSignal;
}

export interface OfflineExportResult {
  blob: Blob;
  /** File extension without the dot, e.g. "mp4". */
  extension: string;
  mimeType: string;
  frames: number;
  videoCodec: string;
  audioCodec: string | null;
}

/** WebCodecs is required for frame-accurate decode and encode. */
export function isOfflineExportSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined' &&
    typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined'
  );
}

/**
 * Decodes every frame of the source clip, runs the removal engine on it at the chosen
 * quality, and re-encodes it offline. Unlike MediaRecorder this is not tied to wall-clock
 * playback: no frames are dropped no matter how slow the fill is, and the output keeps the
 * source frame timestamps. Audio is re-encoded and carried across when present.
 */
export async function exportVideoOffline(
  source: Blob,
  options: OfflineExportOptions
): Promise<OfflineExportResult> {
  const mb = await import('mediabunny');
  const { config, quality, onProgress, signal } = options;

  const input = new mb.Input({ source: new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('No video track found in this file.');
    if (!(await videoTrack.canDecode())) {
      throw new Error('Your browser cannot decode this video codec with WebCodecs.');
    }

    const width = await videoTrack.getDisplayWidth();
    const height = await videoTrack.getDisplayHeight();
    const duration = await input.computeDuration();
    const frameRate = (await videoTrack.computeFrameRateMetrics()).bestGuessFrameRate;

    // Prefer MP4/H.264 since it plays everywhere; fall back to WebM/VP9.
    const formats = [new mb.Mp4OutputFormat(), new mb.WebMOutputFormat()];
    let format: InstanceType<typeof mb.Mp4OutputFormat> | InstanceType<typeof mb.WebMOutputFormat> | null = null;
    let videoCodec: (typeof mb.VIDEO_CODECS)[number] | null = null;
    for (const candidate of formats) {
      const supported = candidate
        .getSupportedCodecs()
        .filter((c): c is (typeof mb.VIDEO_CODECS)[number] =>
          (mb.VIDEO_CODECS as readonly string[]).includes(c)
        );
      const ordered = (['avc', 'hevc', 'vp9', 'av1', 'vp8'] as const).filter((c) => supported.includes(c));
      const codec = await mb.getFirstEncodableVideoCodec(ordered, { width, height, frameRate });
      if (codec) {
        format = candidate;
        videoCodec = codec;
        break;
      }
    }
    if (!format || !videoCodec) {
      throw new Error('No supported video encoder is available in this browser.');
    }

    const output = new mb.Output({ format, target: new mb.BufferTarget() });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a 2D canvas context.');

    const videoSource = new mb.CanvasSource(canvas, {
      codec: videoCodec,
      bitrate: quality === 'high' ? mb.QUALITY_VERY_HIGH : mb.QUALITY_HIGH,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource);

    // Audio: re-encode into whatever the container accepts.
    const audioTrack = await input.getPrimaryAudioTrack();
    let audioSource: InstanceType<typeof mb.AudioSampleSource> | null = null;
    let audioCodec: string | null = null;
    if (audioTrack && (await audioTrack.canDecode())) {
      const supportedAudio = format
        .getSupportedCodecs()
        .filter((c): c is (typeof mb.AUDIO_CODECS)[number] =>
          (mb.AUDIO_CODECS as readonly string[]).includes(c)
        );
      const ordered = (['aac', 'opus'] as const).filter((c) => supportedAudio.includes(c));
      const codec = await mb.getFirstEncodableAudioCodec(ordered, {
        numberOfChannels: await audioTrack.getNumberOfChannels(),
        sampleRate: await audioTrack.getSampleRate(),
      });
      if (codec) {
        audioSource = new mb.AudioSampleSource({ codec, bitrate: mb.QUALITY_HIGH });
        output.addAudioTrack(audioSource);
        audioCodec = codec;
      }
    }

    await output.start();

    const throwIfAborted = () => {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    };

    clearTemporalCache('export');
    const sink = new mb.VideoSampleSink(videoTrack);
    let frames = 0;
    let lastYield = performance.now();
    try {
      for await (const sample of sink.samples()) {
        try {
          throwIfAborted();
          sample.draw(ctx, 0, 0, width, height);
          processCanvasFrame(ctx, width, height, config, { quality, temporalKey: 'export' });
          await videoSource.add(sample.timestamp, sample.duration);
        } finally {
          sample.close();
        }
        frames++;
        onProgress?.(duration > 0 ? Math.min(0.98, sample.timestamp / duration) : 0, frames);

        // Keep the page responsive: hand control back to the event loop regularly.
        if (performance.now() - lastYield > 60) {
          await new Promise<void>((r) => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }

      if (audioSource && audioTrack) {
        const audioSink = new mb.AudioSampleSink(audioTrack);
        for await (const sample of audioSink.samples()) {
          try {
            throwIfAborted();
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
        }
      }

      await output.finalize();
    } catch (err) {
      if (output.state === 'started') {
        await output.cancel();
      }
      throw err;
    } finally {
      clearTemporalCache('export');
    }

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Encoder produced no output.');
    onProgress?.(1, frames);

    return {
      blob: new Blob([buffer], { type: format.mimeType }),
      extension: format.fileExtension.replace(/^\./, ''),
      mimeType: format.mimeType,
      frames,
      videoCodec,
      audioCodec,
    };
  } finally {
    input.dispose();
  }
}
