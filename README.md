# Typhoon ASR Studio

เว็บแอปพลิเคชันแบบหน้าเดียว (Single-Page Web App) สำหรับทดลองใช้งาน **OpenTyphoon Speech Recognition API** โดยรองรับการสลับโมเดลภาษาไทยกลางและภาษาอีสาน พูดผ่านไมโครโฟนแล้วถอดความออกมาเป็นข้อความแบบต่อเนื่องทันที

---

## 1. แนวคิดและสถาปัตยกรรม (Concept & Architecture)

OpenTyphoon ASR (`https://api.opentyphoon.ai/v1/audio/transcriptions`) ให้บริการผ่าน REST endpoint แบบ OpenAI-compatible ที่รับไฟล์เสียง (`.wav`, `.mp3`, `.flac`, `.ogg`, `.opus`) จึงออกแบบระบบให้ทำงานแบบ **Near-Realtime Streaming** บนเบราว์เซอร์ได้ทันทีโดยไม่ต้องตั้งค่า WebSocket Server แยก:

1. **Client-Side Audio Capture & VAD Chunking**
   - รับเสียงจากไมโครโฟนผ่าน `AudioContext` และทำ Downsampling ให้เป็น **16 kHz Mono PCM**
   - เก็บ Pre-roll buffer (~300 ms) เพื่อไม่ให้พยางค์แรกขาดหาย
   - ใช้ Voice Activity Detection (VAD) ตรวจจับระดับเสียง (RMS): เมื่อผู้พูดหยุดพักสั้นๆ (~700 ms) หรือพูดต่อเนื่องครบ ~5.5 วินาที ระบบจะเข้ารหัสเสียงช่วงนั้นเป็นไฟล์ `.wav` ขนาดเล็กในหน่วยความจำ แล้วส่งไปถอดความทันที
   - ใช้คิวแบบเรียงลำดับ (Serialized Upload Queue) เพื่อให้ข้อความแสดงผลตามลำดับวลีที่พูดอย่างถูกต้อง

2. **Server-Side API Proxy (Security Boundary)**
   - เบราว์เซอร์ไม่เรียก OpenTyphoon API โดยตรง แต่ส่งไฟล์เสียงผ่าน Express endpoint `/api/transcribe`
   - ค่า `TYPHOON_API_KEY` ถูกเก็บและใช้งานเฉพาะฝั่งเซิร์ฟเวอร์ (`process.env.TYPHOON_API_KEY`) เท่านั้น เพื่อไม่ให้ Secret รั่วไหลไปยัง Client
   - ฝั่งเซิร์ฟเวอร์ตรวจสอบชื่อโมเดล (Allowlist), นามสกุล/MIME ของไฟล์เสียง, จำกัดขนาดไฟล์ไม่เกิน 10 MB และกำหนด Timeout ที่ 30 วินาที

3. **รองรับทั้ง Local Dev และ Vercel Production ด้วย Express ชุดเดียว**
   - โค้ด Express หลักอยู่ใน `server/asrApp.ts`
   - ตอนพัฒนาในเครื่อง `server.ts` จะนำ Express app มาต่อกับ `vite.middlewares` บนพอร์ต `3000`
   - ตอน Deploy บน Vercel `api/index.ts` จะ import Express app เดียวกันไปรันเป็น Serverless Function และให้ Vercel เสิร์ฟไฟล์ Frontend จาก `dist/`

---

## 2. Framework และเทคโนโลยีที่ใช้ (Tech Stack)

| ส่วนประกอบ | เทคโนโลยี | หน้าที่หลัก |
| :--- | :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite 8 | Single-page UI, จัดการสถานะการอัดเสียง และแสดงผลข้อความ |
| **Styling & Icons** | Tailwind CSS v4, Lucide React | จัดวางเลย์เอาต์ที่อ่านง่าย รองรับภาษาไทย (`IBM Plex Sans Thai`) |
| **Audio Processing** | Web Audio API (`AudioContext`, `AnalyserNode`) | จับเสียงไมโครโฟน, วาดกราฟคลื่นเสียง, Downsample 16 kHz และสร้างไฟล์ WAV |
| **Backend** | Express 4, Multer, Node.js Fetch / FormData | รับไฟล์เสียงแบบ `multipart/form-data` และส่งต่อไปยัง OpenTyphoon API |
| **Deployment** | Vercel (`vercel.json` + Serverless Function) | รัน Frontend แบบ Static และ Backend Express ผ่าน `/api/*` |

### โมเดลที่รองรับ
- `typhoon-asr-realtime` — สำหรับภาษาไทยมาตรฐาน
- `typhoon-isan-asr-realtime` — สำหรับภาษาอีสาน / ไทยตะวันออกเฉียงเหนือ

---

## 3. โครงสร้างโค้ด (Code Structure)

```text
.
├── api/
│   └── index.ts             # Entry point สำหรับ Vercel Serverless Function (export Express app)
├── server/
│   └── asrApp.ts            # Express app หลัก: /api/health และ /api/transcribe + validation
├── server.ts                # Entry point สำหรับรันในเครื่อง (Express + Vite middleware ใน dev / dist ใน prod)
├── src/
│   ├── lib/
│   │   └── audioWav.ts      # คำนวณ RMS, Downsample เป็น 16 kHz และเข้ารหัส PCM WAV 16-bit
│   ├── App.tsx              # UI หน้าเดียว: เลือกโมเดล, ปุ่มพูด, กราฟเสียง, อัปโหลดไฟล์, แสดงผลข้อความ
│   ├── index.css            # Tailwind CSS import และฟอนต์หลัก
│   └── main.tsx             # React root mount
├── .env.example             # ตัวอย่างตัวแปรสภาพแวดล้อมที่ต้องตั้งค่า
├── index.html               # HTML template และ Google Fonts (Plus Jakarta Sans, IBM Plex Sans Thai, IBM Plex Mono)
├── package.json             # Dependencies และ scripts (dev, build, start, lint)
└── vercel.json              # ตั้งค่า build output (dist) และ routing /api/* ไปยัง api/index
```

---

## 4. การรันบนเครื่องเพื่อพัฒนา (Local Development)

### 1) ติดตั้ง Dependencies
```bash
npm install
```

### 2) ตั้งค่า Environment Variables
คัดลอกไฟล์ `.env.example` เป็น `.env` แล้วใส่คีย์ OpenTyphoon API ของคุณ (ไฟล์ `.env` ถูกกันไว้ใน `.gitignore` แล้ว):

```env
TYPHOON_API_KEY="YOUR_TYPHOON_API_KEY"
```

### 3) รันเซิร์ฟเวอร์พัฒนา
```bash
npm run dev
```
เปิดเบราว์เซอร์ไปที่ `http://localhost:3000`

### คำสั่งอื่นๆ
- `npm run lint` — ตรวจสอบ TypeScript types (`tsc --noEmit`)
- `npm run build` — Build ฝั่ง Frontend ลงโฟลเดอร์ `dist/`
- `npm start` — รัน Production server ผ่าน `node server.ts`

---

## 5. การ Deploy ขึ้น Vercel

โปรเจกต์นี้ตั้งค่าไฟล์ `vercel.json` และ `api/index.ts` ให้พร้อม Deploy บน Vercel ได้ทันที

### ขั้นตอนการ Deploy

1. **เชื่อมต่อ Repository กับ Vercel** (ผ่าน Vercel Dashboard หรือ Vercel CLI)
2. **ตั้งค่า Build & Output** (ระบบจะอ่านจาก `vercel.json` ให้อัตโนมัติ):
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. **เพิ่ม Environment Variable ใน Vercel Dashboard**:
   - ไปที่ **Project Settings → Environment Variables**
   - เพิ่มตัวแปรชื่อ `TYPHOON_API_KEY` พร้อมค่า API Key ของคุณ (เลือกใช้ใน Production / Preview / Development ตามต้องการ)
4. **Deploy**:
   - กด Deploy บน Dashboard หรือรันผ่าน CLI:
     ```bash
     vercel --prod
     ```

### การทำงานของ Routing บน Vercel
- คำขอที่ขึ้นต้นด้วย `/api/*` (เช่น `GET /api/health`, `POST /api/transcribe`) จะถูกส่งไปยัง Serverless Function ที่ `api/index.ts`
- คำขอเส้นทางอื่นๆ จะถูกเสิร์ฟจากไฟล์ Static ที่ Build ไว้ใน `dist/index.html`

> **หมายเหตุเรื่องขนาดไฟล์บน Vercel:** Vercel Serverless Functions มีขีดจำกัดขนาด Request Body สูงสุดประมาณ 4.5 MB สำหรับ Hobby/Pro plan โดยปกติการพูดทีละวลีผ่านไมโครโฟน (16 kHz mono WAV ความยาวไม่เกิน 5.5 วินาที) จะมีขนาดเพียง ~170 KB จึงส่งผ่านได้รวดเร็วและไม่ติดขีดจำกัดครับ
