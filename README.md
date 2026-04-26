# Reaction GIF Lab

First proof of concept for the app: upload an image or GIF, generate a short image-to-video reaction clip with fal's `fal-ai/ltx-video/image-to-video`, then convert the MP4 into a looping GIF with `ffmpeg`.

## What this does

- Takes an uploaded image or GIF from the UI
- Normalizes the source into a still frame locally with `ffmpeg`
- Calls fal LTX image-to-video on the server
- Downloads the generated MP4
- Builds a looped GIF from the source frame and generated MP4
- Saves artifacts under `public/outputs`

## Requirements

- Node.js 22+
- npm 10+
- `ffmpeg` installed and available on your shell path
- `FAL_KEY` set in `.env.local`

Optional:

- none for the first cut

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local`:

```bash
FAL_KEY=your_key_here
```

3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Notes

- This first version is intentionally synchronous. The request waits for fal to finish the video before assembling the GIF.
- GIF uploads currently use the first frame as the source image for generation.
- The current backend targets `fal-ai/ltx-video/image-to-video`, which the fal docs currently price at about $0.02 per video.
