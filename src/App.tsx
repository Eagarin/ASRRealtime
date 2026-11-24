import {
  AlertCircle,
  Check,
  Copy,
  Mic,
  RotateCcw,
  Square,
  Upload,
} from 'lucide-react';
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  TARGET_SAMPLE_RATE,
  computeRms,
  concatFloat32Arrays,
  downsampleTo16k,
  encodeWav16k,
} from './lib/audioWav.ts';

type AsrModelId = 'typhoon-asr-realtime' | 'typhoon-isan-asr-realtime';

interface ModelOption {
  id: AsrModelId;
  label: string;
  dialect: string;
  description: string;
}

interface TranscriptEntry {
  id: string;
  text: string;
  model: AsrModelId;
  latencyMs: number;
  createdAt: string;
}

const MODELS: ModelOption[] = [
  {
    id: 'typhoon-asr-realtime',
    label: 'Typhoon ASR Realtime',
    dialect: 'Standard Thai',
    description: 'General Thai speech recognition',
  },
  {
    id: 'typhoon-isan-asr-realtime',
    label: 'Typhoon Isan ASR Realtime',
    dialect: 'Isan / Northeastern Thai',
    description: 'Fine-tuned for Isan dialect speech',
  },
];

const SPEECH_START_RMS = 0.011;
const SPEECH_CONTINUE_RMS = 0.008;
const SILENCE_FLUSH_MS = 700;
const MIN_SPEECH_MS = 320;
const MAX_CHUNK_MS = 5500;
const PRE_ROLL_FRAMES = 4;

function formatElapsed(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function App() {
  const [selectedModel, setSelectedModel] = useState<AsrModelId>(
    'typhoon-asr-realtime',
  );
  const [isRecording, setIsRecording] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(
    null,
  );

  const selectedModelRef = useRef<AsrModelId>(selectedModel);
  selectedModelRef.current = selectedModel;

  const isRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // VAD & chunking state refs
  const preRollRef = useRef<Float32Array[]>([]);
  const speechChunksRef = useRef<Float32Array[]>([]);
  const inSpeechRef = useRef(false);
  const speechDurationMsRef = useRef(0);
  const silenceDurationMsRef = useRef(0);
  const peakRmsRef = useRef(0);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.apiKeyConfigured === 'boolean') {
          setApiKeyConfigured(data.apiKeyConfigured);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setApiKeyConfigured(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isRecording) {
      setElapsedSeconds(0);
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({behavior: 'smooth'});
  }, [entries.length, pendingCount]);

  const fullTranscript = useMemo(
    () => entries.map((e) => e.text).join(' ').trim(),
    [entries],
  );

  const lastLatencyMs =
    entries.length > 0 ? entries[entries.length - 1].latencyMs : null;

  const enqueueTranscription = useCallback(
    (audioBlob: Blob, filename: string, model: AsrModelId) => {
      setPendingCount((c) => c + 1);

      uploadQueueRef.current = uploadQueueRef.current
        .then(async () => {
          const formData = new FormData();
          formData.append('file', audioBlob, filename);
          formData.append('model', model);

          const res = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData,
          });

          const data = (await res.json().catch(() => ({}))) as {
            text?: string;
            model?: AsrModelId;
            latencyMs?: number;
            error?: string;
          };

          if (!res.ok) {
            throw new Error(
              data.error || `Transcription failed (HTTP ${res.status})`,
            );
          }

          const cleanText = (data.text || '').trim();
          if (cleanText.length > 0) {
            const now = new Date();
            const timestamp = now.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });
            setEntries((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                text: cleanText,
                model: data.model || model,
                latencyMs: data.latencyMs ?? 0,
                createdAt: timestamp,
              },
            ]);
          }
          setErrorMessage(null);
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof Error
              ? err.message
              : 'Unable to transcribe audio segment.';
          setErrorMessage(msg);
        })
        .finally(() => {
          setPendingCount((c) => Math.max(0, c - 1));
        });
    },
    [],
  );

  const flushSpeechBuffer = useCallback(
    (forceMinRms = false) => {
      const chunks = speechChunksRef.current;
      const durationMs = speechDurationMsRef.current;
      const peakRms = peakRmsRef.current;

      speechChunksRef.current = [];
      inSpeechRef.current = false;
      speechDurationMsRef.current = 0;
      silenceDurationMsRef.current = 0;
      peakRmsRef.current = 0;

      if (chunks.length === 0) return;

      const minDuration = forceMinRms ? 200 : MIN_SPEECH_MS;
      const minPeak = forceMinRms ? 0.004 : SPEECH_START_RMS * 0.85;
      if (durationMs < minDuration || peakRms < minPeak) {
        return;
      }

      const merged = concatFloat32Arrays(chunks);
      const wavBlob = encodeWav16k(merged, TARGET_SAMPLE_RATE);
      enqueueTranscription(wavBlob, 'mic-segment.wav', selectedModelRef.current);
    },
    [enqueueTranscription],
  );

  const drawIdleWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const barCount = 36;
    const gap = 4;
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    const centerY = height / 2;

    ctx.fillStyle = '#cbd5e1';
    for (let i = 0; i < barCount; i++) {
      const barHeight = 4;
      const x = i * (barWidth + gap);
      ctx.beginPath();
      ctx.roundRect(x, centerY - barHeight / 2, barWidth, barHeight, 2);
      ctx.fill();
    }
  }, []);

  const startWaveformLoop = useCallback(() => {
    const render = () => {
      if (!isRecordingRef.current) {
        drawIdleWaveform();
        return;
      }

      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      if (canvas && analyser) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const width = canvas.clientWidth;
          const height = canvas.clientHeight;
          if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
            canvas.width = width * dpr;
            canvas.height = height * dpr;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);

          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);

          const barCount = 36;
          const gap = 4;
          const barWidth = Math.max(
            2,
            (width - gap * (barCount - 1)) / barCount,
          );
          const centerY = height / 2;
          const step = Math.max(1, Math.floor(data.length / barCount));

          for (let i = 0; i < barCount; i++) {
            const val = data[Math.min(data.length - 1, i * step)] / 255;
            const barHeight = Math.max(4, val * (height - 6));
            const x = i * (barWidth + gap);
            ctx.fillStyle = val > 0.14 ? '#e11d48' : '#94a3b8';
            ctx.beginPath();
            ctx.roundRect(x, centerY - barHeight / 2, barWidth, barHeight, 2);
            ctx.fill();
          }
        }
      }

      animFrameRef.current = window.requestAnimationFrame(render);
    };

    animFrameRef.current = window.requestAnimationFrame(render);
  }, [drawIdleWaveform]);

  useEffect(() => {
    drawIdleWaveform();
  }, [drawIdleWaveform]);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);

    flushSpeechBuffer(true);

    if (animFrameRef.current !== null) {
      window.cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }

    preRollRef.current = [];
    drawIdleWaveform();
  }, [drawIdleWaveform, flushSpeechBuffer]);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return;
    setErrorMessage(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage(
        'Microphone capture is not supported in this browser. You can upload an audio file instead.',
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as {webkitAudioContext: typeof AudioContext})
          .webkitAudioContext;
      const audioContext = new AudioCtx({sampleRate: TARGET_SAMPLE_RATE});
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      // Mute output path to avoid feedback while keeping processor active
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      preRollRef.current = [];
      speechChunksRef.current = [];
      inSpeechRef.current = false;
      speechDurationMsRef.current = 0;
      silenceDurationMsRef.current = 0;
      peakRmsRef.current = 0;

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!isRecordingRef.current) return;

        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(
          new Float32Array(input),
          audioContext.sampleRate,
        );
        const frameMs = (downsampled.length / TARGET_SAMPLE_RATE) * 1000;
        const rms = computeRms(downsampled);

        if (!inSpeechRef.current) {
          preRollRef.current.push(downsampled);
          if (preRollRef.current.length > PRE_ROLL_FRAMES) {
            preRollRef.current.shift();
          }

          if (rms >= SPEECH_START_RMS) {
            inSpeechRef.current = true;
            speechChunksRef.current = [...preRollRef.current];
            preRollRef.current = [];
            speechDurationMsRef.current =
              speechChunksRef.current.length * frameMs;
            silenceDurationMsRef.current = 0;
            peakRmsRef.current = rms;
          }
          return;
        }

        speechChunksRef.current.push(downsampled);
        speechDurationMsRef.current += frameMs;
        if (rms > peakRmsRef.current) {
          peakRmsRef.current = rms;
        }

        if (rms < SPEECH_CONTINUE_RMS) {
          silenceDurationMsRef.current += frameMs;
        } else {
          silenceDurationMsRef.current = 0;
        }

        if (
          silenceDurationMsRef.current >= SILENCE_FLUSH_MS ||
          speechDurationMsRef.current >= MAX_CHUNK_MS
        ) {
          flushSpeechBuffer(false);
        }
      };

      audioContextRef.current = audioContext;
      mediaStreamRef.current = stream;
      analyserRef.current = analyser;
      processorRef.current = processor;
      isRecordingRef.current = true;
      setIsRecording(true);
      startWaveformLoop();
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access or upload an audio file.'
          : 'Could not start microphone capture. Check your audio input device.';
      setErrorMessage(msg);
      stopRecording();
    }
  }, [flushSpeechBuffer, startWaveformLoop, stopRecording]);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  // Spacebar shortcut to toggle speaking
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'BUTTON' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (isRecordingRef.current) {
        stopRecording();
      } else {
        void startRecording();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [startRecording, stopRecording]);

  const handleModelSelect = (modelId: AsrModelId) => {
    if (modelId === selectedModel) return;
    if (isRecordingRef.current) {
      flushSpeechBuffer(true);
    }
    setSelectedModel(modelId);
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrorMessage(null);
    enqueueTranscription(file, file.name, selectedModelRef.current);
  };

  const handleCopy = async () => {
    if (!fullTranscript) return;
    try {
      await navigator.clipboard.writeText(fullTranscript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setErrorMessage('Could not copy text to clipboard.');
    }
  };

  const handleClear = () => {
    setEntries([]);
    setErrorMessage(null);
  };

  const activeModelMeta =
    MODELS.find((m) => m.id === selectedModel) ?? MODELS[0];

  const statusText = isRecording
    ? pendingCount > 0
      ? 'Listening · Transcribing…'
      : 'Listening — speak naturally'
    : pendingCount > 0
      ? 'Transcribing final phrase…'
      : 'Ready';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            Typhoon ASR Studio
          </span>

          <div className="flex items-center gap-4 text-xs text-slate-500 whitespace-nowrap shrink-0">
            <span className="hidden sm:inline">{activeModelMeta.id}</span>
            {apiKeyConfigured === false && (
              <span className="text-rose-600 font-medium">
                API key missing
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,.flac,.ogg,.opus,audio/*"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Audio
            </button>
          </div>
        </div>
      </header>

      {/* Main Single-Page Studio */}
      <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 flex flex-col gap-6">
        {/* 1. Model Selection */}
        <section aria-label="Model selection" className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-lg font-semibold text-slate-900">
              Select ASR Model
            </h1>
            <span className="text-xs text-slate-500">
              OpenTyphoon Speech Recognition
            </span>
          </div>

          <div
            role="radiogroup"
            aria-label="Typhoon ASR Model"
            className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-1.5 bg-slate-200/70 rounded-xl border border-slate-200"
          >
            {MODELS.map((model) => {
              const active = selectedModel === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleModelSelect(model.id)}
                  className={`text-left px-4 py-3 rounded-lg transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 ${
                    active
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold whitespace-nowrap truncate">
                      {model.label}
                    </span>
                    <span
                      className={`text-xs whitespace-nowrap shrink-0 ${
                        active ? 'text-blue-600 font-medium' : 'text-slate-400'
                      }`}
                    >
                      {model.dialect}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">
                    {model.description}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* 2. Speak Control & Live Audio Meter */}
        <section
          aria-label="Speech capture"
          className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col gap-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => {
                if (isRecording) {
                  stopRecording();
                } else {
                  void startRecording();
                }
              }}
              className={`inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 ${
                isRecording
                  ? 'bg-rose-600 hover:bg-rose-700 text-white focus-visible:outline-rose-600'
                  : 'bg-slate-900 hover:bg-slate-800 text-white focus-visible:outline-slate-900'
              }`}
            >
              {isRecording ? (
                <>
                  <Square className="w-4 h-4 fill-current" />
                  Stop Speaking
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  Start Speaking
                </>
              )}
            </button>

            {/* Acoustic Waveform + Status */}
            <div className="flex-1 flex items-center gap-4 min-w-0">
              <canvas
                ref={canvasRef}
                className="flex-1 h-10 min-w-[120px]"
                aria-hidden="true"
              />
              <div className="flex items-center gap-3 text-xs text-slate-500 shrink-0">
                <span className="font-mono-tabular text-slate-700 font-medium">
                  {formatElapsed(elapsedSeconds)}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    isRecording
                      ? 'text-rose-600 font-medium whitespace-nowrap'
                      : 'text-slate-600 whitespace-nowrap'
                  }
                >
                  {statusText}
                </span>
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-400">
            Press Space to toggle microphone · Phrases transcribe automatically
            when you pause
          </p>
        </section>

        {/* Error Alert */}
        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-600" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* 3. Live Transcript Output */}
        <section
          aria-label="Transcription output"
          className="flex-1 bg-white border border-slate-200 rounded-2xl flex flex-col min-h-[300px]"
        >
          <div className="px-5 sm:px-6 py-3.5 border-b border-slate-100 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">Transcript</span>
              {entries.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">
                    {entries.length}{' '}
                    {entries.length === 1 ? 'phrase' : 'phrases'}
                  </span>
                </>
              )}
              {lastLatencyMs !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular">{lastLatencyMs} ms</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopy}
                disabled={!fullTranscript}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleClear}
                disabled={entries.length === 0 && !errorMessage}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Clear
              </button>
            </div>
          </div>

          <div className="flex-1 p-5 sm:p-6 overflow-y-auto">
            {entries.length === 0 && pendingCount === 0 ? (
              <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center max-w-md mx-auto">
                <p className="text-sm text-slate-500 leading-relaxed">
                  Select a Typhoon model above, press{' '}
                  <span className="font-medium text-slate-700">
                    Start Speaking
                  </span>
                  , and your transcribed text will appear here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-xl sm:text-2xl leading-relaxed text-slate-900 whitespace-pre-wrap break-words">
                  {fullTranscript}
                  {pendingCount > 0 && (
                    <span className="inline-block ml-2 text-base font-normal text-slate-400">
                      transcribing…
                    </span>
                  )}
                </p>

                {entries.length > 0 && (
                  <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                    {entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1 sm:gap-4 text-xs py-1"
                      >
                        <span className="text-slate-700 text-sm">
                          {entry.text}
                        </span>
                        <span className="text-slate-400 font-mono-tabular whitespace-nowrap shrink-0">
                          {entry.model} · {entry.latencyMs} ms ·{' '}
                          {entry.createdAt}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
