# Typhoon ASR Studio

A clean, single-page web application for testing the **OpenTyphoon Speech Recognition API**. Switch between standard Thai and Isan ASR models, speak into your microphone, and see transcribed text appear continuously in real time.

---

## 1. Concept & Architecture

The hosted OpenTyphoon ASR endpoint (`https://api.opentyphoon.ai/v1/audio/transcriptions`) exposes an OpenAI-compatible REST interface that accepts audio files (`.wav`, `.mp3`, `.flac`, `.ogg`, `.opus`). To deliver a **near-realtime speaking experience** without requiring a separate WebSocket server, the app uses a lightweight client-to-proxy pipeline:

1. **Client-Side Audio Capture & VAD Chunking**
   - Captures microphone input via the Web Audio API (`AudioContext`) and downsamples it to **16 kHz Mono PCM**.
   - Maintains a short pre-roll buffer (~300 ms) so opening consonants and syllables are not clipped.
   - Applies Voice Activity Detection (VAD) using RMS energy thresholds: when a speaker pauses briefly (~700 ms) or speaks continuously for ~5.5 seconds, the buffered speech is encoded in memory as a compact `.wav` file and dispatched immediately.
   - Uses a serialized upload queue so transcribed phrases always append in spoken order.

2. **Server-Side API Proxy (Security Boundary)**
   - The browser never calls OpenTyphoon directly; instead, it posts audio to the Express route `/api/transcribe`.
   - `TYPHOON_API_KEY` is read exclusively from server-side `process.env` and never exposed to client code.
   - The server validates the selected model against an explicit allowlist, checks file extensions/MIME types, enforces a 10 MB upload limit, and applies a 30-second upstream request timeout.

3. **Shared Express Core for Local Dev & Vercel Production**
   - The Express application is defined once in `server/asrApp.ts`.
   - During local development, `server.ts` mounts `vite.middlewares` alongside the Express API on port `3000`.
   - On Vercel, `api/index.ts` exports the same Express app as a Serverless Function while Vercel serves the static Vite bundle from `dist/`.

---

## 2. Framework & Tech Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite 8 | Single-page UI, recording controls, and live transcript feed |
| **Styling & Icons** | Tailwind CSS v4, Lucide React | Clean, responsive layout and typography (`Plus Jakarta Sans`, `IBM Plex Sans Thai`, `IBM Plex Mono`) |
| **Audio Processing** | Web Audio API (`AudioContext`, `AnalyserNode`) | Live waveform meter, 16 kHz resampling, VAD segmentation, and 16-bit PCM WAV encoding |
| **Backend** | Express 4, Multer, Node.js `fetch` / `FormData` | Multipart audio upload handling and OpenTyphoon API proxy |
| **Deployment** | Vercel (`vercel.json` + Serverless Function) | Static frontend hosting (`dist/`) and `/api/*` serverless routing |

### Supported Models
- `typhoon-asr-realtime` — Standard Thai speech recognition
- `typhoon-isan-asr-realtime` — Isan / Northeastern Thai dialect speech recognition

---

## 3. Code Structure

```text
.
├── api/
│   └── index.ts             # Vercel Serverless Function entry point (exports Express app)
├── server/
│   └── asrApp.ts            # Shared Express app: /api/health, /api/transcribe, input validation
├── server.ts                # Local & Node server entry point (Express + Vite dev middleware / dist static)
├── src/
│   ├── lib/
│   │   └── audioWav.ts      # RMS energy calculation, 16 kHz linear resampler, PCM WAV encoder
│   ├── App.tsx              # Single-page UI: model switcher, mic capture, waveform, file upload, transcript
│   ├── index.css            # Tailwind CSS import and typography defaults
│   └── main.tsx             # React application mount
├── .env.example             # Example environment variables template
├── index.html               # HTML shell and Google Fonts imports
├── package.json             # Dependencies and npm scripts (dev, build, start, lint)
└── vercel.json              # Vercel build config (dist/) and /api/* rewrite rules
```

---

## 4. Local Development

### 1) Install Dependencies
```bash
npm install
```

### 2) Configure Environment Variables
Copy `.env.example` to `.env` and add your OpenTyphoon API key (`.env` is excluded by `.gitignore`):

```env
TYPHOON_API_KEY="YOUR_TYPHOON_API_KEY"
```

### 3) Start the Development Server
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

### Additional Scripts
- `npm run lint` — Run TypeScript type checking (`tsc --noEmit`)
- `npm run build` — Build the production frontend into `dist/`
- `npm start` — Run the production Express server via `node server.ts`

---

## 5. Deploying to Vercel

The repository includes `vercel.json` and `api/index.ts` for zero-config Express + Vite deployment on Vercel.

### Deployment Steps

1. **Connect your repository to Vercel** (via the Vercel Dashboard or Vercel CLI).
2. **Verify Build & Output Settings** (automatically detected from `vercel.json`):
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. **Configure Environment Variables in Vercel**:
   - Navigate to **Project Settings → Environment Variables**.
   - Add `TYPHOON_API_KEY` with your OpenTyphoon API key for Production (and Preview/Development if needed).
4. **Deploy**:
   - Trigger a deployment from the Vercel Dashboard, or run:
     ```bash
     vercel --prod
     ```

### Routing Behavior on Vercel
- Requests matching `/api/*` (such as `GET /api/health` and `POST /api/transcribe`) are routed to the Express Serverless Function at `api/index.ts`.
- All other routes serve the built SPA bundle from `dist/index.html`.

> **Note on Vercel Payload Limits:** Vercel Serverless Functions enforce a ~4.5 MB request body limit on standard plans. Typical spoken phrases captured from the microphone (16 kHz mono WAV up to 5.5 seconds) are ~170 KB, keeping uploads fast and well within limits.
