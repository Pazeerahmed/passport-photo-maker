# Passport Studio — Passport Photo Maker

An AI-powered passport photo website built with Flask, Pillow and rembg.

## Features
- Upload JPG, PNG and WEBP photos (12 MB max)
- Automatic background removal using rembg
- Blue or white background
- Passport sizes: 35 × 45 mm, 2 × 2 inches, 25 × 35 mm
- 300-DPI JPEG downloads
- Mobile-friendly interface, drag-and-drop, and preview

## Installation

Requires Python 3.11.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

On Windows, activate using `.venv\Scripts\activate`. Open http://127.0.0.1:5000.

The first AI request may download a background removal model and take longer.

## Deploy

Use the included `render.yaml` with Render Blueprint. GitHub Pages alone cannot run this Python backend. The AI model needs enough server memory.

## API

`POST /api/process` using multipart fields `photo`, `background` (`blue` or `white`), and `size` (`35x45`, `2x2`, or `25x35`).

`GET /health` returns `{"status":"ok"}`.

## Important

This tool does not certify compliance with official passport requirements. Each country and issuing authority may require a specific background, head position and photo size. Check its rules before submitting a photo. Uploaded photos are processed in memory; the application does not intentionally save uploads, but your hosting service may process the data. Use HTTPS.

## Vercel troubleshooting

On Vercel, the application uses the smaller `u2netp` rembg model and stores it in the writable `/tmp` directory. The model downloads on a cold start, so the first request can take longer. If processing fails, open Vercel → Project → Logs → Runtime and inspect the Python exception. Serverless memory, execution time, or upload size limits may still prevent AI processing. For reliable AI processing, a persistent Python server with enough RAM is recommended.
