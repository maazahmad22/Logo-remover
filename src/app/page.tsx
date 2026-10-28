'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  Video,
  Image as ImageIcon,
  Upload,
  Download,
  ShieldCheck,
  Zap,
  RotateCcw,
  Play,
  Pause,
  CheckCircle2,
  Eye,
  EyeOff,
  HelpCircle,
  ChevronDown,
  Layers,
  Cpu,
  Menu,
  X,
  Maximize2,
  AlertCircle,
  Loader2,
  Move,
  Crosshair,
  Wand2,
  FileOutput,
} from 'lucide-react';
import {
  DEFAULT_CONFIG,
  clearTemporalCache,
  createDemoWatermarkedImage,
  drawSimulatedWatermarkBadge,
  getFillProfileSummary,
  processCanvasFrame,
  regionForPreset,
  type CornerPreset,
  type ProcessingConfig,
  type RemovalMode,
  type RenderQuality,
} from '@/lib/watermark-engine';
import { exportVideoOffline, isOfflineExportSupported } from '@/lib/video-export';

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================

type ActiveTab = 'video' | 'image';

interface FaqItem {
  question: string;
  answer: string;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'Are my videos or images uploaded to any remote server?',
    answer:
      'No. Every frame is decoded, processed, and re-encoded 100% locally inside your browser using the HTML5 Canvas 2D API and MediaRecorder. Your files never leave your computer.',
  },
  {
    question: 'How does the #video watermark remover work?',
    answer:
      'In Video Mode (#video), every frame of your clip is decoded with WebCodecs, cleaned with Content-Aware Fill (PatchMatch texture synthesis) or Reverse Alpha Unblending at the calibrated watermark coordinates, and re-encoded frame-accurately to MP4 (H.264) or WebM, with the original audio carried across. Browsers without WebCodecs fall back to a real-time recorder.',
  },
  {
    question: 'What do the Low, Medium and High render qualities change?',
    answer:
      'They set how hard the fill works. Low matches patches at half resolution and is what the live preview uses while playing. Medium refines at full resolution with match-weighted voting. High is the best the app can do: 7x7 patches, a three-level pyramid, twice the sampling context, more refinement passes, and a higher encoder bitrate. Pause the video to see the selected quality on the current frame.',
  },
  {
    question: 'Which removal algorithm should I choose?',
    answer:
      'Use "Content-Aware Fill" (default) for almost everything: it rebuilds the masked area from real texture sampled around it, like Photoshop\'s Content-Aware Fill. Try "Reverse Alpha Unblending" when the overlay is a faint translucent white badge on a mostly flat background, and "Feather Blur" when you only want a quick, soft smudge.',
  },
  {
    question: 'What video and image formats are supported?',
    answer:
      'For video (#video), MP4, WebM, and MOV files supported by your browser are accepted. For images (#image), PNG, JPEG, and WebP are supported at full native resolution.',
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

const QUALITY_TIERS: ReadonlyArray<[RenderQuality, string, string]> = [
  ['low', 'Low', 'Fastest'],
  ['medium', 'Medium', 'Balanced'],
  ['high', 'High', 'Best, slow'],
];

const ALGORITHMS: ReadonlyArray<{ id: RemovalMode; title: string; desc: string }> = [
  {
    id: 'content-aware',
    title: 'Content-Aware Fill',
    desc: 'Rebuilds the mask from matching texture around it (PatchMatch).',
  },
  {
    id: 'reverse-alpha',
    title: 'Reverse Alpha Unblending',
    desc: 'Neutralizes semi-transparent white overlays on flat backgrounds.',
  },
  {
    id: 'feather-blur',
    title: 'Soft Feather Smoothing',
    desc: 'Quick soft smudge for busy, fast-moving backgrounds.',
  },
];

const PRESETS: ReadonlyArray<[Exclude<CornerPreset, 'custom'>, string]> = [
  ['top-left', 'Top Left'],
  ['top-right', 'Top Right'],
  ['bottom-left', 'Bottom Left'],
  ['bottom-right', 'Bottom Right'],
];

export default function GeminiWatermarkRemoverPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('video');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  const [config, setConfig] = useState<ProcessingConfig>(() => ({
    ...DEFAULT_CONFIG,
    region: { ...DEFAULT_CONFIG.region },
  }));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [quality, setQuality] = useState<RenderQuality>('medium');
  const [offlineSupported, setOfflineSupported] = useState<boolean>(false);
  useEffect(() => setOfflineSupported(isOfflineExportSupported()), []);

  const [showMaskBox, setShowMaskBox] = useState<boolean>(true);
  const [previewOriginal, setPreviewOriginal] = useState<boolean>(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  // Video Studio State
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>('gemini-veo-sample.webm');
  const [videoMeta, setVideoMeta] = useState<{ width: number; height: number; duration: number }>({
    width: 1280,
    height: 720,
    duration: 0,
  });
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [videoProgress, setVideoProgress] = useState<number>(0);
  const [isExportingVideo, setIsExportingVideo] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportedVideoUrl, setExportedVideoUrl] = useState<string | null>(null);
  const [exportedVideoExt, setExportedVideoExt] = useState<string>('webm');
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [realtimeExport, setRealtimeExport] = useState<boolean>(false);
  const [isGeneratingDemoVideo, setIsGeneratingDemoVideo] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const exportPollRef = useRef<number | null>(null);
  const exportRecorderRef = useRef<MediaRecorder | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const videoBlobRef = useRef<Blob | null>(null);

  // Image Studio State
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState<string>('gemini-sample.png');
  const [cleanedImageUrl, setCleanedImageUrl] = useState<string | null>(null);
  const [imageMeta, setImageMeta] = useState<{ width: number; height: number }>({
    width: 1280,
    height: 720,
  });
  const [compareSliderPos, setCompareSliderPos] = useState<number>(50);
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Shared viewport wrapper (sized exactly to the media) used for mask dragging.
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.toLowerCase();
      if (hash.includes('image')) {
        setActiveTab('image');
      } else if (hash.includes('video') || hash === '') {
        setActiveTab('video');
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  const switchTab = (tab: ActiveTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, '', `#${tab}`);
  };

  const mediaLoaded = activeTab === 'video' ? !!videoUrl : !!imageUrl;
  const mediaDims = activeTab === 'video' ? videoMeta : imageMeta;
  const mediaName = activeTab === 'video' ? videoFileName : imageFileName;

  // Outline of the area the fill actually covers: the mask box grown by the glow margin.
  const haloBoxStyle = (dims: { width: number; height: number }) => {
    const hx = ((config.haloPx ?? 0) / Math.max(1, dims.width)) * 100;
    const hy = ((config.haloPx ?? 0) / Math.max(1, dims.height)) * 100;
    return {
      left: `${config.region.xPct - hx}%`,
      top: `${config.region.yPct - hy}%`,
      width: `${config.region.widthPct + hx * 2}%`,
      height: `${config.region.heightPct + hy * 2}%`,
    };
  };

  const handlePresetChange = (preset: CornerPreset) => {
    if (preset === 'custom') {
      setConfig((prev) => ({ ...prev, preset: 'custom' }));
      return;
    }
    setConfig((prev) => ({
      ...prev,
      preset,
      region: regionForPreset(preset),
    }));
  };

  const updateRegionField = (key: keyof ProcessingConfig['region'], value: number) => {
    setConfig((prev) => ({
      ...prev,
      preset: 'custom',
      region: {
        ...prev.region,
        [key]: value,
      },
    }));
  };

  // --- Mask box direct manipulation: drag to move, drag the corner handle to resize ---
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    region: ProcessingConfig['region'];
  } | null>(null);

  const onMaskPointerDown = (mode: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, region: { ...config.region } };
  };
  const onMaskPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    const vp = viewportRef.current;
    if (!d || !vp) return;
    const r = vp.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const dx = ((e.clientX - d.startX) / r.width) * 100;
    const dy = ((e.clientY - d.startY) / r.height) * 100;
    setConfig((prev) => {
      const reg = { ...d.region };
      if (d.mode === 'move') {
        reg.xPct = clamp(round1(d.region.xPct + dx), 0, 100 - reg.widthPct);
        reg.yPct = clamp(round1(d.region.yPct + dy), 0, 100 - reg.heightPct);
      } else {
        reg.widthPct = clamp(round1(d.region.widthPct + dx), 1, 100 - reg.xPct);
        reg.heightPct = clamp(round1(d.region.heightPct + dy), 1, 100 - reg.yPct);
      }
      return { ...prev, preset: 'custom', region: reg };
    });
  };
  const onMaskPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
    }
    dragRef.current = null;
  };

  const renderCurrentVideoFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = videoCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, vw, vh);

    if (!previewOriginal) {
      processCanvasFrame(ctx, vw, vh, config, {
        quality: isPlaying || realtimeExport ? 'low' : quality,
        temporalKey: 'video',
      });
    }

    if (video.duration) {
      setVideoProgress((video.currentTime / video.duration) * 100);
    }
  }, [config, previewOriginal, isPlaying, realtimeExport, quality]);

  // While playing (or recording in real time) render every animation frame.
  useEffect(() => {
    if (!(isPlaying || realtimeExport)) return;
    const loop = () => {
      renderCurrentVideoFrame();
      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, realtimeExport, renderCurrentVideoFrame]);

  // When paused, re-render the still frame at the selected quality, debounced so
  // slider drags stay responsive even on the High profile.
  useEffect(() => {
    if (isPlaying || isExportingVideo) return;
    if (activeTab !== 'video' || !videoUrl) return;
    const handle = window.setTimeout(() => {
      setBusyLabel(`Rendering frame · ${quality}`);
      // Let the badge paint before the synchronous fill blocks the thread.
      window.setTimeout(() => {
        renderCurrentVideoFrame();
        setBusyLabel(null);
      }, 16);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [config, previewOriginal, activeTab, videoUrl, isPlaying, isExportingVideo, renderCurrentVideoFrame, quality]);

  const loadVideoFile = (file: File) => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (exportedVideoUrl) URL.revokeObjectURL(exportedVideoUrl);

    const url = URL.createObjectURL(file);
    clearTemporalCache('video');
    videoBlobRef.current = file;
    setErrorMessage(null);
    setExportStatus(null);
    setVideoFileName(file.name);
    setVideoUrl(url);
    setExportedVideoUrl(null);
    setExportProgress(0);
    setIsPlaying(false);
    setVideoProgress(0);
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadVideoFile(file);
  };

  const generateSyntheticDemoVideo = async () => {
    if (typeof MediaRecorder === 'undefined') {
      setErrorMessage(
        'Your browser does not support MediaRecorder, which is required to synthesize or export video.'
      );
      return;
    }
    setIsGeneratingDemoVideo(true);
    setErrorMessage(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (exportedVideoUrl) URL.revokeObjectURL(exportedVideoUrl);
    setVideoUrl(null);
    setExportedVideoUrl(null);
    setExportProgress(0);

    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 960;
      tempCanvas.height = 540;
      const ctx = tempCanvas.getContext('2d')!;

      const stream = tempCanvas.captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4500000 });
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };

      const donePromise = new Promise<{ blob: Blob; url: string }>((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          resolve({ blob, url: URL.createObjectURL(blob) });
        };
      });

      recorder.start();

      const totalFrames = 90;
      for (let f = 0; f < totalFrames; f++) {
        const t = f / totalFrames;
        const grad = ctx.createLinearGradient(0, 0, 960, 540);
        grad.addColorStop(0, '#090d16');
        grad.addColorStop(0.5, '#1e1b4b');
        grad.addColorStop(1, '#0f172a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 960, 540);

        const orbX = 250 + Math.sin(t * Math.PI * 2) * 220;
        const orbY = 270 + Math.cos(t * Math.PI * 2) * 80;
        const radGrad = ctx.createRadialGradient(orbX, orbY, 10, orbX, orbY, 260);
        radGrad.addColorStop(0, 'rgba(99, 102, 241, 0.55)');
        radGrad.addColorStop(0.6, 'rgba(6, 182, 212, 0.25)');
        radGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
        ctx.fillStyle = radGrad;
        ctx.fillRect(0, 0, 960, 540);

        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '700 28px sans-serif';
        ctx.fillText('Veo / Gemini Sample Video Stream', 240, 260);
        ctx.font = '400 16px monospace';
        ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
        ctx.fillText(`Frame ${f + 1} / ${totalFrames} — Inspect Bottom-Right Corner`, 285, 295);

        drawSimulatedWatermarkBadge(ctx, 960, 540);

        await new Promise((r) => setTimeout(r, 25));
      }

      recorder.stop();
      const generated = await donePromise;
      clearTemporalCache('video');
      videoBlobRef.current = generated.blob;
      setExportStatus(null);
      setVideoFileName('gemini-veo-demo-clip.webm');
      setVideoUrl(generated.url);
      setIsPlaying(false);
      setVideoProgress(0);
    } catch (err) {
      setErrorMessage(
        `Could not synthesize the sample clip: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setIsGeneratingDemoVideo(false);
    }
  };

  const stopExport = useCallback(() => {
    if (exportPollRef.current !== null) {
      window.clearInterval(exportPollRef.current);
      exportPollRef.current = null;
    }
    const recorder = exportRecorderRef.current;
    exportRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, []);

  useEffect(() => stopExport, [stopExport]);

  const exportOffline = async (sourceBlob: Blob) => {
    setIsExportingVideo(true);
    setExportProgress(0);
    setPreviewOriginal(false);
    setErrorMessage(null);
    if (exportedVideoUrl) URL.revokeObjectURL(exportedVideoUrl);
    setExportedVideoUrl(null);
    videoRef.current?.pause();

    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportStatus(`Decoding and re-encoding every frame at ${quality} quality…`);

    try {
      const result = await exportVideoOffline(sourceBlob, {
        config,
        quality,
        signal: controller.signal,
        onProgress: (fraction, frames) => {
          setExportProgress(Math.round(fraction * 100));
          setExportStatus(`Frame ${frames} · ${quality} quality · frame-accurate encode`);
        },
      });
      setExportedVideoUrl(URL.createObjectURL(result.blob));
      setExportedVideoExt(result.extension);
      setExportProgress(100);
      setExportStatus(
        `${result.frames} frames encoded as ${result.videoCodec.toUpperCase()}${
          result.audioCodec ? ` + ${result.audioCodec.toUpperCase()} audio` : ' (source had no audio)'
        } at ${quality} quality.`
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setExportStatus('Export cancelled.');
      } else {
        setExportStatus(null);
        setErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      exportAbortRef.current = null;
      setIsExportingVideo(false);
    }
  };

  const handleExportCleanedVideo = async () => {
    const video = videoRef.current;
    const canvas = videoCanvasRef.current;
    if (!video || !canvas || isExportingVideo) return;

    const sourceBlob = videoBlobRef.current;
    if (sourceBlob && offlineSupported) {
      await exportOffline(sourceBlob);
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setErrorMessage(
        'Your browser does not support MediaRecorder, which is required to export video.'
      );
      return;
    }

    setIsExportingVideo(true);
    setRealtimeExport(true);
    setExportProgress(0);
    setPreviewOriginal(false);
    setErrorMessage(null);
    setExportStatus('Recording the live preview in real time (WebCodecs unavailable).');
    if (exportedVideoUrl) URL.revokeObjectURL(exportedVideoUrl);
    setExportedVideoUrl(null);

    try {
      video.pause();
      if (video.currentTime !== 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            video.removeEventListener('seeked', done);
            resolve();
          };
          video.addEventListener('seeked', done);
          video.currentTime = 0;
        });
      }
      renderCurrentVideoFrame();

      const stream = canvas.captureStream(30);

      // Carry the source audio across: the canvas stream is video-only.
      try {
        const sourceStream = (
          video as HTMLVideoElement & { captureStream?: () => MediaStream }
        ).captureStream?.();
        sourceStream?.getAudioTracks().forEach((track) => stream.addTrack(track));
      } catch {
        // Audio capture is best-effort; export continues as video-only.
      }

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 6000000,
      });
      exportRecorderRef.current = recorder;

      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        setExportedVideoUrl(URL.createObjectURL(blob));
        setExportedVideoExt('webm');
        setIsExportingVideo(false);
        setRealtimeExport(false);
        setIsPlaying(false);
        setExportProgress(100);
        setExportStatus('Recorded in real time from the live preview (Low quality).');
        exportRecorderRef.current = null;
      };

      recorder.start(100);
      await video.play();

      exportPollRef.current = window.setInterval(() => {
        if (video.duration) {
          setExportProgress(Math.min(99, Math.round((video.currentTime / video.duration) * 100)));
        }
        if (video.ended) {
          stopExport();
        }
      }, 80);
    } catch (err) {
      stopExport();
      setIsExportingVideo(false);
      setRealtimeExport(false);
      setIsPlaying(false);
      setErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const processLoadedImage = useCallback(
    (sourceUrl: string) => {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        setImageMeta({ width: img.naturalWidth, height: img.naturalHeight });
        const canvas = imageCanvasRef.current;
        if (!canvas) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);
        processCanvasFrame(ctx, img.naturalWidth, img.naturalHeight, config, {
          quality,
          temporalKey: null,
        });
        setCleanedImageUrl(canvas.toDataURL('image/png'));
        setBusyLabel(null);
      };
      img.onerror = () => {
        setErrorMessage('The selected file could not be decoded as an image.');
        setCleanedImageUrl(null);
        setBusyLabel(null);
      };
      img.src = sourceUrl;
    },
    [config, quality]
  );

  useEffect(() => {
    if (!imageUrl) return;
    setBusyLabel(`Rendering · ${quality}`);
    const handle = window.setTimeout(() => processLoadedImage(imageUrl), 150);
    return () => window.clearTimeout(handle);
  }, [imageUrl, processLoadedImage, quality]);

  const loadImageFile = (file: File) => {
    if (imageUrl && imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
    const url = URL.createObjectURL(file);
    setErrorMessage(null);
    setCleanedImageUrl(null);
    setImageFileName(file.name);
    setImageUrl(url);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadImageFile(file);
  };

  // Drag-and-drop onto the whole studio card, in either state (empty or loaded).
  const [dragOver, setDragOver] = useState<ActiveTab | null>(null);
  const dropProps = (kind: ActiveTab) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragOver !== kind) setDragOver(kind);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (kind === 'video') {
        if (!file.type.startsWith('video/')) {
          setErrorMessage(`"${file.name}" is not a video file.`);
          return;
        }
        loadVideoFile(file);
      } else {
        if (!file.type.startsWith('image/')) {
          setErrorMessage(`"${file.name}" is not an image file.`);
          return;
        }
        loadImageFile(file);
      }
    },
  });

  const handleLoadDemoImage = () => {
    if (imageUrl && imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
    const dataUrl = createDemoWatermarkedImage();
    setErrorMessage(null);
    setCleanedImageUrl(null);
    setImageFileName('gemini-imagen-sample.png');
    setImageUrl(dataUrl);
  };

  const resetAll = () =>
    setConfig({ ...DEFAULT_CONFIG, region: { ...DEFAULT_CONFIG.region } });

  // --------------------------------------------------------------------------
  // Shared pieces
  // --------------------------------------------------------------------------

  const maskOverlay = (dims: { width: number; height: number }) =>
    showMaskBox ? (
      <>
        {(config.haloPx ?? 0) > 0 && (
          <div
            style={haloBoxStyle(dims)}
            className="pointer-events-none absolute border border-dashed border-amber-300/70 rounded"
          />
        )}
        <div
          role="slider"
          aria-label="Watermark mask. Drag to move; drag the corner handle to resize."
          aria-valuetext={`x ${config.region.xPct}%, y ${config.region.yPct}%, ${config.region.widthPct}% by ${config.region.heightPct}%`}
          tabIndex={0}
          style={{
            left: `${config.region.xPct}%`,
            top: `${config.region.yPct}%`,
            width: `${config.region.widthPct}%`,
            height: `${config.region.heightPct}%`,
          }}
          className="absolute border-2 border-cyan-400 bg-cyan-400/10 rounded shadow-[0_0_15px_rgba(34,211,238,0.35)] cursor-move touch-none select-none"
          onPointerDown={onMaskPointerDown('move')}
          onPointerMove={onMaskPointerMove}
          onPointerUp={onMaskPointerUp}
          onPointerCancel={onMaskPointerUp}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 1 : 0.2;
            const map: Record<string, [keyof ProcessingConfig['region'], number]> = {
              ArrowLeft: ['xPct', -step],
              ArrowRight: ['xPct', step],
              ArrowUp: ['yPct', -step],
              ArrowDown: ['yPct', step],
            };
            const hit = map[e.key];
            if (!hit) return;
            e.preventDefault();
            updateRegionField(hit[0], round1(clamp(config.region[hit[0]] + hit[1], 0, 100)));
          }}
        >
          <span className="absolute -top-4 left-0 whitespace-nowrap px-1 py-px text-[9px] leading-none font-mono bg-cyan-500 text-slate-950 font-bold rounded">
            MASK
          </span>
          <span
            role="presentation"
            aria-hidden="true"
            className="absolute -right-2 -bottom-2 w-4 h-4 rounded-sm bg-cyan-400 border border-slate-950 cursor-nwse-resize touch-none"
            onPointerDown={onMaskPointerDown('resize')}
            onPointerMove={onMaskPointerMove}
            onPointerUp={onMaskPointerUp}
            onPointerCancel={onMaskPointerUp}
          />
        </div>
      </>
    ) : null;

  // Size the media box to its own aspect ratio, never taller than --vp-h (set per
  // breakpoint on the container) and never wider than the card. No letterboxing.
  const viewportSizing = (dims: { width: number; height: number }) => {
    const ratio = Math.max(0.05, dims.width / Math.max(1, dims.height));
    return dims.width >= dims.height
      ? { aspectRatio: `${dims.width} / ${dims.height}`, width: `min(100%, calc(var(--vp-h) * ${ratio.toFixed(4)}))` }
      : { aspectRatio: `${dims.width} / ${dims.height}`, height: 'var(--vp-h)', maxWidth: '100%' };
  };

  const tabButton = (tab: ActiveTab, label: string, Icon: typeof Video) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      onClick={() => switchTab(tab)}
      className={`flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
        activeTab === tab
          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-600/25'
          : 'text-slate-400 hover:text-white'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );

  const panel = (step: string, title: string, Icon: typeof Video, children: React.ReactNode) => (
    <section className="rounded-2xl bg-[#0E1320]/90 border border-white/10 backdrop-blur-xl p-4 sm:p-5 space-y-4">
      <header className="flex items-center gap-2.5">
        <span className="w-6 h-6 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[11px] font-mono font-bold flex items-center justify-center">
          {step}
        </span>
        <Icon className="w-4 h-4 text-indigo-400" />
        <h2 className="font-bold text-sm text-white tracking-wide">{title}</h2>
      </header>
      {children}
    </section>
  );

  const slider = (
    label: string,
    value: number,
    display: string,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    accent = 'accent-indigo-500',
    disabled = false
  ) => (
    <label className={`block space-y-1 ${disabled ? 'opacity-40' : ''}`}>
      <span className="flex justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-slate-200">{display}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${accent} cursor-pointer`}
      />
    </label>
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="min-h-screen flex flex-col bg-[#07090E] text-slate-100 relative overflow-x-clip">
      {/* Ambient Background Glows */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 w-[550px] h-[550px] bg-indigo-600/15 rounded-full blur-[140px]" />
        <div className="absolute top-60 right-1/5 w-[480px] h-[480px] bg-cyan-500/10 rounded-full blur-[130px]" />
        <div className="absolute bottom-10 left-1/3 w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[150px]" />
      </div>

      {/* Sticky Navigation Bar */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#07090E]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-3">
          <a href="#video" onClick={() => switchTab('video')} className="flex items-center gap-3 group min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-500 to-cyan-400 p-[1px] shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-[#0B0F19] rounded-[11px] flex items-center justify-center group-hover:bg-transparent transition-colors">
                <Sparkles className="w-5 h-5 text-cyan-300 group-hover:text-white transition-colors" />
              </div>
            </div>
            <div className="min-w-0">
              <span className="font-bold text-sm sm:text-base tracking-tight text-white flex items-center gap-2 truncate">
                Gemini Watermark Remover
                <span className="hidden sm:inline-flex items-center px-2 py-0.5 text-[11px] font-mono font-medium rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  v2.5 Local
                </span>
              </span>
              <p className="text-xs text-slate-400 hidden sm:block">100% Client-Side Image &amp; Video Studio</p>
            </div>
          </a>

          <nav className="hidden md:flex items-center gap-1 bg-white/[0.03] border border-white/10 rounded-full p-1">
            {[
              ['#video', 'Studio'],
              ['#features', 'Features'],
              ['#how-it-works', 'How It Works'],
              ['#faq', 'FAQ'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="px-4 py-1.5 rounded-full text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-xs font-medium">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Zero Server Uploads</span>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-lg border border-white/10 text-slate-300 hover:text-white"
            aria-label="Toggle Menu"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden border-t border-white/10 bg-[#0B0F19] px-4 py-3 space-y-1 overflow-hidden"
            >
              {[
                ['#video', 'Studio'],
                ['#features', 'Features'],
                ['#how-it-works', 'How It Works'],
                ['#faq', 'FAQ'],
              ].map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-3 py-2 rounded-lg text-slate-200 text-sm hover:bg-white/5"
                >
                  {label}
                </a>
              ))}
              <div className="flex items-center gap-2 px-3 pt-2 text-xs text-emerald-300">
                <ShieldCheck className="w-4 h-4" /> Zero server uploads
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-5 sm:pt-8 pb-16">
        {/* Compact hero: the tool is the hero */}
        <section className="text-center max-w-2xl mx-auto mb-5 sm:mb-7">
          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-white leading-tight">
            Remove{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
              Gemini &amp; Veo
            </span>{' '}
            Watermarks
          </h1>
          <p className="mt-2 text-slate-400 text-sm sm:text-base">
            Content-aware fill and frame-accurate video export, entirely in your browser.
          </p>
        </section>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="rounded-md p-1 text-rose-300 hover:bg-rose-500/20 hover:text-white"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Studio: sticky preview + scrolling controls */}
        <section id={activeTab} className="flex flex-col lg:grid lg:grid-cols-12 gap-4 lg:gap-6 items-start">
          <div
            {...dropProps(activeTab)}
            className={`w-full lg:col-span-8 sticky top-[3.75rem] sm:top-[4.5rem] z-20 self-start rounded-2xl bg-[#0E1320]/95 border p-3 sm:p-5 shadow-2xl backdrop-blur-xl transition-colors ${
              dragOver ? 'border-cyan-400/70' : 'border-white/10'
            }`}
          >
            {/* Card header: mode tabs + file info + view toggles */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div role="tablist" aria-label="Studio mode" className="flex w-full sm:w-auto p-1 rounded-xl bg-[#090D16] border border-white/10">
                {tabButton('video', 'Video', Video)}
                {tabButton('image', 'Image', ImageIcon)}
              </div>

              {mediaLoaded && (
                <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto">
                  <span className="hidden sm:inline truncate text-xs font-mono text-slate-400 max-w-[22rem]">
                    {mediaName} · {mediaDims.width}×{mediaDims.height}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowMaskBox(!showMaskBox)}
                    aria-pressed={showMaskBox}
                    className={`inline-flex flex-1 sm:flex-none justify-center items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      showMaskBox
                        ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200'
                        : 'bg-white/5 border-white/10 text-slate-400'
                    }`}
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Mask
                  </button>
                  {activeTab === 'video' && (
                    <button
                      type="button"
                      disabled={isExportingVideo}
                      aria-pressed={previewOriginal}
                      onClick={() => setPreviewOriginal((p) => !p)}
                      className={`inline-flex flex-1 sm:flex-none justify-center items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        previewOriginal
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                          : 'bg-white/5 border-white/10 text-slate-300 hover:text-white'
                      }`}
                    >
                      {previewOriginal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      {previewOriginal ? 'Original' : 'Cleaned'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ------------------------------ VIDEO ------------------------------ */}
            {activeTab === 'video' &&
              (!videoUrl ? (
                <div
                  className={`border-2 border-dashed rounded-2xl p-6 sm:p-12 text-center transition-all ${
                    dragOver === 'video'
                      ? 'border-indigo-400 bg-indigo-500/10'
                      : 'border-indigo-500/30 hover:border-indigo-400/60 bg-[#090D16]/70'
                  }`}
                >
                  <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center mx-auto mb-3">
                    <Video className="w-7 h-7 text-indigo-400" />
                  </div>
                  <h3 className="text-base sm:text-lg font-bold text-white">Drop a Gemini or Veo video here</h3>
                  <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
                    MP4, WebM or MOV. Every frame is processed on this device.
                  </p>
                  <div className="mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
                    <label className="cursor-pointer inline-flex justify-center items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition-all">
                      <Upload className="w-4 h-4" />
                      <span>Select Video</span>
                      <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={handleVideoUpload} className="hidden" />
                    </label>
                    <button
                      type="button"
                      disabled={isGeneratingDemoVideo}
                      onClick={generateSyntheticDemoVideo}
                      className="inline-flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 text-sm font-medium transition-all disabled:opacity-50"
                    >
                      {isGeneratingDemoVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-cyan-400" />}
                      <span>{isGeneratingDemoVideo ? 'Synthesizing sample…' : 'Try a sample clip'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="relative rounded-xl overflow-hidden bg-black border border-white/10 flex items-center justify-center [--vp-h:34vh] sm:[--vp-h:62vh]">
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      playsInline
                      crossOrigin="anonymous"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        setVideoMeta({
                          width: v.videoWidth || 1280,
                          height: v.videoHeight || 720,
                          duration: v.duration || 0,
                        });
                      }}
                      onLoadedData={(e) => {
                        // Many encoders (MediaRecorder included) have no decodable frame at
                        // exactly t=0, which leaves the preview black until the user scrubs.
                        // A tiny seek lands on the first real frame; onSeeked then renders.
                        const v = e.currentTarget;
                        if (v.currentTime === 0 && v.duration > 0.5) {
                          v.currentTime = Math.min(0.05, v.duration / 10);
                        } else {
                          renderCurrentVideoFrame();
                        }
                      }}
                      onSeeked={renderCurrentVideoFrame}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
                      onError={() =>
                        setErrorMessage('This video could not be decoded by your browser. Try an MP4 (H.264) or WebM file.')
                      }
                      className="absolute w-px h-px opacity-0 pointer-events-none"
                      aria-hidden="true"
                    />
                    <div ref={viewportRef} className="relative" style={viewportSizing(videoMeta)}>
                      <canvas ref={videoCanvasRef} className="block w-full h-full" />
                      {maskOverlay(videoMeta)}
                    </div>
                    {busyLabel && (
                      <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 text-[11px] font-mono text-slate-200">
                        <Loader2 className="w-3 h-3 animate-spin" /> {busyLabel}
                      </span>
                    )}
                  </div>

                  <div className="bg-[#090D16] border border-white/10 rounded-xl p-2.5 sm:p-3 flex items-center gap-3">
                    <button
                      type="button"
                      disabled={isExportingVideo}
                      onClick={() => {
                        const v = videoRef.current;
                        if (!v) return;
                        if (v.paused) {
                          v.play().catch((err: unknown) =>
                            setErrorMessage(`Playback failed: ${err instanceof Error ? err.message : String(err)}`)
                          );
                        } else {
                          v.pause();
                        }
                      }}
                      className="w-10 h-10 shrink-0 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-colors disabled:opacity-40"
                      aria-label={isPlaying ? 'Pause' : 'Play'}
                    >
                      {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <input
                        type="range"
                        aria-label="Seek"
                        min={0}
                        max={100}
                        step={0.5}
                        value={videoProgress}
                        disabled={isExportingVideo}
                        onChange={(e) => {
                          const pct = Number(e.target.value);
                          setVideoProgress(pct);
                          if (videoRef.current && videoRef.current.duration) {
                            videoRef.current.currentTime = (pct / 100) * videoRef.current.duration;
                          }
                        }}
                        className="w-full accent-indigo-500 cursor-pointer"
                      />
                      <div className="flex justify-between gap-2 text-[11px] font-mono text-slate-400 mt-0.5">
                        <span className="truncate">
                          {isPlaying ? 'Playing · Low preview' : `Paused · ${quality} preview`}
                        </span>
                        <span>{Math.round(videoProgress)}%</span>
                      </div>
                    </div>
                    <label className="cursor-pointer shrink-0 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-300">
                      Replace
                      <input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={handleVideoUpload} className="hidden" />
                    </label>
                  </div>
                </div>
              ))}

            {/* ------------------------------ IMAGE ------------------------------ */}
            {activeTab === 'image' && (
              <>
                <canvas ref={imageCanvasRef} className="hidden" />
                {!imageUrl ? (
                  <div
                    className={`border-2 border-dashed rounded-2xl p-6 sm:p-12 text-center transition-all ${
                      dragOver === 'image'
                        ? 'border-cyan-400 bg-cyan-500/10'
                        : 'border-cyan-500/30 hover:border-cyan-400/60 bg-[#090D16]/70'
                    }`}
                  >
                    <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center mx-auto mb-3">
                      <ImageIcon className="w-7 h-7 text-cyan-400" />
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-white">Drop a Gemini or Imagen photo here</h3>
                    <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
                      PNG, JPG or WebP at full resolution, with a before/after slider.
                    </p>
                    <div className="mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
                      <label className="cursor-pointer inline-flex justify-center items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-semibold text-sm shadow-lg shadow-cyan-600/20 transition-all">
                        <Upload className="w-4 h-4" />
                        <span>Select Image</span>
                        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} className="hidden" />
                      </label>
                      <button
                        type="button"
                        onClick={handleLoadDemoImage}
                        className="inline-flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 text-sm font-medium transition-all"
                      >
                        <Sparkles className="w-4 h-4 text-cyan-400" />
                        <span>Try a sample image</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="relative rounded-xl overflow-hidden bg-black border border-white/10 select-none flex items-center justify-center [--vp-h:34vh] sm:[--vp-h:62vh]">
                      <div ref={viewportRef} className="relative" style={viewportSizing(imageMeta)}>
                        <img src={cleanedImageUrl ?? imageUrl} alt="Cleaned output" className="block w-full h-full" />
                        <div style={{ clipPath: `inset(0 ${100 - compareSliderPos}% 0 0)` }} className="absolute inset-0 pointer-events-none">
                          <img src={imageUrl} alt="Original input" className="w-full h-full" />
                        </div>
                        <div
                          style={{ left: `${compareSliderPos}%` }}
                          className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_12px_rgba(255,255,255,0.9)] pointer-events-none"
                        >
                          <div className="absolute top-2 -left-14 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-slate-200">
                            BEFORE
                          </div>
                          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-indigo-600/90 text-[10px] font-mono text-white">
                            AFTER
                          </div>
                        </div>
                        {maskOverlay(imageMeta)}
                      </div>
                      {busyLabel && (
                        <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 text-[11px] font-mono text-slate-200">
                          <Loader2 className="w-3 h-3 animate-spin" /> {busyLabel}
                        </span>
                      )}
                    </div>

                    <div className="bg-[#090D16] border border-white/10 rounded-xl p-2.5 sm:p-3 flex items-center gap-3">
                      <span className="text-xs font-mono text-slate-400 shrink-0">Compare</span>
                      <input
                        type="range"
                        aria-label="Before/after split position"
                        min={0}
                        max={100}
                        value={compareSliderPos}
                        onChange={(e) => setCompareSliderPos(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-cyan-400 cursor-pointer"
                      />
                      <span className="text-xs font-mono text-cyan-300 w-9 text-right">{compareSliderPos}%</span>
                      <label className="cursor-pointer shrink-0 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-slate-300">
                        Replace
                        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} className="hidden" />
                      </label>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ------------------------------ CONTROLS ------------------------------ */}
          <aside className="w-full lg:col-span-4 space-y-4">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs text-slate-500">
                {mediaLoaded ? 'Adjust and watch the preview update.' : 'Load media above, then calibrate here.'}
              </p>
              <button
                type="button"
                onClick={resetAll}
                className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset all
              </button>
            </div>

            {panel(
              '1',
              'Mask position',
              Crosshair,
              <>
                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={config.preset === key}
                      onClick={() => handlePresetChange(key)}
                      className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                        config.preset === key
                          ? 'bg-indigo-500/20 border-indigo-400 text-indigo-200'
                          : 'bg-[#090D16]/60 border-white/10 text-slate-400 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
                  <Move className="w-3.5 h-3.5 mt-0.5 shrink-0 text-cyan-400" />
                  Drag the cyan box on the preview to move it, or drag its corner handle to resize. Presets are calibrated for Gemini&apos;s badge.
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {slider('X offset', config.region.xPct, `${config.region.xPct}%`, 0, 97, 0.5, (v) => updateRegionField('xPct', v))}
                  {slider('Y offset', config.region.yPct, `${config.region.yPct}%`, 0, 97, 0.5, (v) => updateRegionField('yPct', v))}
                  {slider('Width', config.region.widthPct, `${config.region.widthPct}%`, 1, 60, 0.5, (v) => updateRegionField('widthPct', v))}
                  {slider('Height', config.region.heightPct, `${config.region.heightPct}%`, 1, 60, 0.5, (v) => updateRegionField('heightPct', v))}
                </div>
                {slider(
                  'Glow margin (fills past the box)',
                  config.haloPx ?? 0,
                  `${config.haloPx ?? 0}px`,
                  0,
                  40,
                  1,
                  (v) => setConfig((prev) => ({ ...prev, haloPx: v })),
                  'accent-amber-400'
                )}
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  The dashed amber outline is the area replaced outright. Raise the margin if a faint halo or lighter box remains.
                </p>
              </>
            )}

            {panel(
              '2',
              'Removal',
              Wand2,
              <>
                <div className="space-y-2">
                  {ALGORITHMS.map((alg) => (
                    <button
                      key={alg.id}
                      type="button"
                      aria-pressed={config.mode === alg.id}
                      onClick={() => setConfig((prev) => ({ ...prev, mode: alg.id }))}
                      className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all ${
                        config.mode === alg.id
                          ? 'bg-indigo-600/15 border-indigo-500 text-white'
                          : 'bg-[#090D16]/60 border-white/10 text-slate-400 hover:border-white/20'
                      }`}
                    >
                      <span className="flex items-center justify-between text-xs font-bold text-white">
                        {alg.title}
                        {config.mode === alg.id && <span className="w-2 h-2 rounded-full bg-cyan-400" />}
                      </span>
                      <span className="block text-[11px] text-slate-400 mt-0.5">{alg.desc}</span>
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <span className="block text-[11px] font-semibold text-slate-300">Render quality</span>
                  <div className="grid grid-cols-3 gap-2">
                    {QUALITY_TIERS.map(([key, label, hint]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={quality === key}
                        onClick={() => setQuality(key)}
                        className={`px-2 py-2 rounded-lg text-xs font-medium border transition-all ${
                          quality === key
                            ? 'bg-cyan-500/15 border-cyan-400 text-cyan-100'
                            : 'bg-[#090D16]/60 border-white/10 text-slate-400 hover:text-white'
                        }`}
                      >
                        <span className="block font-bold">{label}</span>
                        <span className="block text-[10px] opacity-80">{hint}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] font-mono text-slate-500 leading-relaxed">
                    {getFillProfileSummary(quality)}
                    {quality !== 'low' && ' · grain matching'}
                  </p>
                  {quality === 'high' && (
                    <p className="text-[11px] text-amber-300/80">
                      High takes seconds per frame on large masks. Pick it for the final export rather than while dragging sliders.
                    </p>
                  )}
                  {activeTab === 'video' && (
                    <p className="text-[11px] text-slate-500">
                      Playback previews at Low; pause to inspect the selected quality. Export always renders every frame at the selected quality.
                    </p>
                  )}
                </div>

                {slider(
                  'Edge feather (band outside the box)',
                  config.featherPx,
                  `${config.featherPx}px`,
                  2,
                  24,
                  1,
                  (v) => setConfig((prev) => ({ ...prev, featherPx: v })),
                  'accent-cyan-400'
                )}
                {config.mode !== 'content-aware' &&
                  slider(
                    'Blend / unblend strength',
                    Math.round(config.intensity * 100),
                    `${Math.round(config.intensity * 100)}%`,
                    20,
                    100,
                    1,
                    (v) => setConfig((prev) => ({ ...prev, intensity: v / 100 })),
                    'accent-cyan-400'
                  )}
              </>
            )}

            {panel(
              '3',
              'Export',
              FileOutput,
              <>
                {!mediaLoaded && (
                  <p className="text-xs text-slate-500">Load a video or image to export the cleaned result.</p>
                )}

                {mediaLoaded && activeTab === 'video' && (
                  <>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      {offlineSupported
                        ? 'Every frame is decoded and re-encoded offline with WebCodecs: no dropped frames, audio preserved, MP4 when available.'
                        : 'WebCodecs is not available in this browser, so export records the live preview in real time.'}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isExportingVideo}
                        onClick={handleExportCleanedVideo}
                        className="inline-flex flex-1 justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                      >
                        {isExportingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                        {isExportingVideo ? `Rendering ${exportProgress}%` : `Render & Export · ${quality}`}
                      </button>
                      {isExportingVideo && exportAbortRef.current && (
                        <button
                          type="button"
                          onClick={() => exportAbortRef.current?.abort()}
                          className="px-3 py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-200 text-xs font-medium"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {isExportingVideo && (
                      <div className="space-y-1.5">
                        <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-[width] duration-150"
                            style={{ width: `${exportProgress}%` }}
                          />
                        </div>
                        <p className="text-[11px] font-mono text-slate-400">{exportStatus}</p>
                      </div>
                    )}
                    {exportedVideoUrl && !isExportingVideo && (
                      <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-2.5">
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <p className="text-xs text-emerald-200 leading-relaxed">
                            {exportStatus ?? 'Cleaned video ready.'}
                          </p>
                        </div>
                        <a
                          href={exportedVideoUrl}
                          download={`cleaned-${videoFileName.replace(/\.[^/.]+$/, '')}.${exportedVideoExt}`}
                          className="inline-flex w-full justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition-colors"
                        >
                          <Download className="w-4 h-4" />
                          Download .{exportedVideoExt}
                        </a>
                      </div>
                    )}
                  </>
                )}

                {mediaLoaded && activeTab === 'image' && (
                  <>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      Lossless PNG at the original {imageMeta.width}×{imageMeta.height} resolution, rendered at {quality} quality.
                    </p>
                    <a
                      href={cleanedImageUrl ?? undefined}
                      download={`cleaned-${imageFileName.replace(/\.[^/.]+$/, '')}.png`}
                      aria-disabled={!cleanedImageUrl}
                      className={`inline-flex w-full justify-center items-center gap-2 px-4 py-2.5 rounded-xl text-white font-semibold text-sm shadow-lg ${
                        cleanedImageUrl
                          ? 'bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500'
                          : 'bg-white/10 pointer-events-none opacity-60'
                      }`}
                    >
                      {cleanedImageUrl ? <Download className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
                      {cleanedImageUrl ? 'Download Clean PNG' : 'Rendering…'}
                    </a>
                  </>
                )}
              </>
            )}
          </aside>
        </section>

        {/* Features Grid */}
        <section id="features" className="mt-16 sm:mt-24 pt-8 border-t border-white/10 scroll-mt-20">
          <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Engineered for Clean, Private Media Restoration</h2>
            <p className="text-slate-400 text-sm mt-2">Built on native browser Web APIs so your media never leaves your local machine.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
            {[
              {
                icon: ShieldCheck,
                title: '100% Local Privacy',
                desc: 'Zero backend servers or cloud buckets. All frame buffers stay strictly inside your browser memory.',
              },
              {
                icon: Video,
                title: 'Frame-Accurate Video',
                desc: 'Every frame is decoded and re-encoded offline with WebCodecs, with the original audio carried across.',
              },
              {
                icon: Layers,
                title: 'Content-Aware Fill',
                desc: 'Multi-scale PatchMatch rebuilds the badge area from real texture around it, grain included.',
              },
              {
                icon: Cpu,
                title: 'Instant Zero-Install',
                desc: 'Runs directly in modern desktop and mobile browsers without heavy external dependencies.',
              },
            ].map((feat, idx) => (
              <div key={idx} className="p-5 sm:p-6 rounded-2xl bg-[#0E1320]/70 border border-white/10 hover:border-indigo-500/40 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center mb-4">
                  <feat.icon className="w-5 h-5 text-indigo-400" />
                </div>
                <h3 className="font-bold text-white text-base">{feat.title}</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="mt-16 sm:mt-24 pt-8 border-t border-white/10 scroll-mt-20">
          <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">How It Works</h2>
            <p className="text-slate-400 text-sm mt-2">Three steps from watermarked export to clean deliverable.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
            {[
              {
                step: '01',
                title: 'Load a video or image',
                desc: 'Drop your Gemini or Veo file onto the studio, or try a sample to see the engine immediately.',
              },
              {
                step: '02',
                title: 'Place the mask, pick a quality',
                desc: 'Drag the box onto the badge (presets are calibrated for Gemini) and choose Low, Medium or High.',
              },
              {
                step: '03',
                title: 'Export locally',
                desc: 'Preview the cleaned result, then export a frame-accurate video or a lossless PNG with one click.',
              },
            ].map((item) => (
              <div key={item.step} className="relative p-5 sm:p-6 rounded-2xl bg-[#0E1320]/70 border border-white/10">
                <span className="text-3xl font-mono font-extrabold text-indigo-500/30">{item.step}</span>
                <h3 className="text-base font-bold text-white mt-2">{item.title}</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ Accordion */}
        <section id="faq" className="mt-16 sm:mt-24 pt-8 border-t border-white/10 max-w-3xl mx-auto scroll-mt-20">
          <div className="text-center mb-8 sm:mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-white flex items-center justify-center gap-2">
              <HelpCircle className="w-6 h-6 text-indigo-400" />
              Frequently Asked Questions
            </h2>
          </div>

          <div className="space-y-3">
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openFaqIndex === i;
              return (
                <div key={i} className="rounded-xl bg-[#0E1320]/80 border border-white/10 overflow-hidden">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpenFaqIndex(isOpen ? null : i)}
                    className="w-full px-4 sm:px-5 py-4 text-left flex items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="font-semibold text-sm text-white">{item.question}</span>
                    <ChevronDown className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
                  </button>
                  {isOpen && (
                    <div className="px-4 sm:px-5 pb-4 text-xs text-slate-300 leading-relaxed border-t border-white/5 pt-3">
                      {item.answer}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/10 bg-[#05070B] py-6 sm:py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400 text-center sm:text-left">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <span className="font-semibold text-slate-200">Gemini Watermark Remover</span>
            <span className="hidden sm:inline">— Client-Side Canvas &amp; WebCodecs Studio</span>
          </div>
          <div className="flex items-center gap-2 text-slate-500">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>For personal &amp; educational restoration of user-owned AI media.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
