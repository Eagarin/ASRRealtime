import express, {type NextFunction, type Request, type Response} from 'express';
import multer from 'multer';
import path from 'node:path';

export const ALLOWED_ASR_MODELS = [
  'typhoon-asr-realtime',
  'typhoon-isan-asr-realtime',
] as const;

export type AsrModelId = (typeof ALLOWED_ASR_MODELS)[number];

const ALLOWED_MODEL_SET = new Set<string>(ALLOWED_ASR_MODELS);

const ALLOWED_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
]);

const ALLOWED_MIME_PREFIXES = [
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'application/ogg',
];

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const TYPHOON_TRANSCRIPTIONS_URL =
  'https://api.opentyphoon.ai/v1/audio/transcriptions';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase().split(';')[0].trim();
    const hasValidExt = ALLOWED_EXTENSIONS.has(ext);
    const hasValidMime = ALLOWED_MIME_PREFIXES.includes(mime);

    if (hasValidExt || hasValidMime) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        'Unsupported audio format. Please use .wav, .mp3, .flac, .ogg, or .opus.',
      ),
    );
  },
});

export function createAsrApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      apiKeyConfigured: Boolean(process.env.TYPHOON_API_KEY?.trim()),
      models: ALLOWED_ASR_MODELS,
    });
  });

  app.post(
    '/api/transcribe',
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: 'Audio file exceeds the 10 MB upload limit.',
            });
            return;
          }
          res.status(400).json({error: err.message});
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Invalid file upload.';
        res.status(400).json({error: message});
      });
    },
    async (req: Request, res: Response) => {
      const apiKey = process.env.TYPHOON_API_KEY?.trim();
      if (!apiKey) {
        res.status(500).json({
          error:
            'TYPHOON_API_KEY is not configured in the server environment.',
        });
        return;
      }

      const rawModel =
        typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      if (!ALLOWED_MODEL_SET.has(rawModel)) {
        res.status(400).json({
          error:
            'Invalid model selected. Choose typhoon-asr-realtime or typhoon-isan-asr-realtime.',
        });
        return;
      }

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({
          error: 'No audio data received.',
        });
        return;
      }

      const safeExt = ALLOWED_EXTENSIONS.has(
        path.extname(file.originalname || '').toLowerCase(),
      )
        ? path.extname(file.originalname).toLowerCase()
        : '.wav';
      const filename = `speech${safeExt}`;
      const mimeType = file.mimetype || 'audio/wav';

      const form = new FormData();
      const audioBlob = new Blob([new Uint8Array(file.buffer)], {
        type: mimeType,
      });
      form.append('file', audioBlob, filename);
      form.append('model', rawModel);

      const startedAt = Date.now();

      try {
        const upstream = await fetch(TYPHOON_TRANSCRIPTIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });

        const latencyMs = Date.now() - startedAt;
        const contentType = upstream.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
          ? ((await upstream.json()) as Record<string, unknown>)
          : {raw: await upstream.text()};

        if (!upstream.ok) {
          const upstreamError =
            (payload?.error as Record<string, unknown> | undefined)?.message ??
            payload?.message ??
            payload?.detail ??
            `Typhoon API returned status ${upstream.status}`;
          res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({
            error: String(upstreamError),
          });
          return;
        }

        const text =
          typeof payload.text === 'string' ? payload.text.trim() : '';

        res.json({
          text,
          model: rawModel as AsrModelId,
          latencyMs,
        });
      } catch (err) {
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError');
        res.status(isTimeout ? 504 : 502).json({
          error: isTimeout
            ? 'Typhoon ASR request timed out. Please try a shorter segment.'
            : 'Unable to reach Typhoon ASR API.',
        });
      }
    },
  );

  return app;
}
