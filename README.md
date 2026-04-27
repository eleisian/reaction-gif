# Reaction GIF Lab

First proof of concept for the app: upload an image or GIF, generate a short image-to-video reaction clip with fal's different image to video or video to video generation models, isolate the subject, and composite the result into a looping GIF.

## Example 

<table>
  <tr>
    <td align="center"><b>Original GIF</b></td>
    <td align="center"><b>Reaction GIF</b></td>
  </tr>
  <tr>
    <td>
      <img width="128" height="128" alt="Original GIF" src="https://github.com/user-attachments/assets/0ac5820b-368f-4f54-b253-8c88acd5e4df" />
    </td>
    <td>
      <img width="128" height="128" alt="Reaction GIF" src="https://github.com/user-attachments/assets/e3e084b2-f7e6-469f-81b0-498264f4fe7d" />
    </td>
  </tr>
</table>

## What this does

- Takes an uploaded image or GIF from the UI.
- Normalizes the source into a still frame locally with `ffmpeg`.
- Calls fal LTX image-to-video on the server to generate the reaction.
- Downloads the generated MP4.
- **Runs Python processing workers** (`matte_remove_background.py` and `composite_reaction.py`) to isolate the subject from the background and composite the reaction seamlessly.
- Builds a looped GIF from the source frame and generated MP4.
- Saves artifacts under `public/outputs`.

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

