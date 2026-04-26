import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createReactionGif,
  createPosterFrameFromVideo,
  downloadUrlToFile,
  ensureOutputDirectory,
  extensionFromMimeType,
  normalizeSourceFrame,
  readFileToNodeFile,
  writeBufferAsset
} from "@/lib/media";
import {
  generateLtxVideoFromImage,
  type MotionDirection
} from "@/lib/fal-video";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_INPUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);
const ALLOWED_DIRECTIONS = new Set<MotionDirection>([
  "up",
  "right",
  "down",
  "left"
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const debugLog: string[] = [];
  const log = (message: string) => {
    debugLog.push(message);
  };

  try {
    log("Starting /api/generate request.");
    const formData = await request.formData();
    const prompt = String(formData.get("prompt") ?? "").trim();
    const image = formData.get("image");
    const direction = String(formData.get("direction") ?? "right") as MotionDirection;
    log(`Prompt length: ${prompt.length}`);

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required.", debugLog },
        { status: 400 }
      );
    }

    if (!(image instanceof File)) {
      return NextResponse.json(
        { error: "An image upload is required.", debugLog },
        { status: 400 }
      );
    }

    log(`Received file: ${image.name} (${image.type}, ${image.size} bytes)`);
    log(`Selected motion tile: ${direction}`);

    if (!ALLOWED_DIRECTIONS.has(direction)) {
      return NextResponse.json(
        { error: "Unsupported direction selected.", debugLog },
        { status: 400 }
      );
    }

    if (!ALLOWED_INPUT_TYPES.has(image.type)) {
      return NextResponse.json(
        { error: "Supported formats are PNG, JPG, WEBP, and GIF.", debugLog },
        { status: 400 }
      );
    }

    if (image.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Please upload an image under 20MB for this prototype.", debugLog },
        { status: 400 }
      );
    }

    await ensureOutputDirectory();
    log("Ensured output directory exists.");

    const jobId = randomUUID();
    log(`Generated job id: ${jobId}`);
    const uploadExtension = extensionFromMimeType(image.type);
    const uploadBuffer = Buffer.from(await image.arrayBuffer());
    const uploadedAsset = await writeBufferAsset(
      `${jobId}-upload.${uploadExtension}`,
      uploadBuffer
    );
    log(`Saved uploaded asset to ${uploadedAsset.path}`);

    const sourceFrameAsset = {
      path: path.join(process.cwd(), "public", "outputs", `${jobId}-source.png`),
      url: `/outputs/${jobId}-source.png`
    };
    log("Normalizing source frame.");
    await normalizeSourceFrame(uploadedAsset.path, sourceFrameAsset.path, log);
    log(`Normalized source frame saved to ${sourceFrameAsset.path}`);

    const sourceFile = await readFileToNodeFile(
      sourceFrameAsset.path,
      `${jobId}-source.png`,
      "image/png"
    );
    log("Created File object for fal input.");

    log("Submitting image-to-video request to fal.");
    const generatedVideo = await generateLtxVideoFromImage(
      sourceFile,
      prompt,
      direction
    );
    log(`fal request id: ${generatedVideo.requestId}`);
    log(`fal model: ${generatedVideo.model}`);
    log(`fal video url: ${generatedVideo.videoUrl}`);

    const mp4Asset = {
      path: path.join(process.cwd(), "public", "outputs", `${jobId}.mp4`),
      url: `/outputs/${jobId}.mp4`
    };
    await downloadUrlToFile(generatedVideo.videoUrl, mp4Asset.path, log);
    log(`Saved generated MP4 to ${mp4Asset.path}`);

    const posterAsset = {
      path: path.join(process.cwd(), "public", "outputs", `${jobId}-poster.png`),
      url: `/outputs/${jobId}-poster.png`
    };
    log("Extracting poster frame from generated video.");
    await createPosterFrameFromVideo(mp4Asset.path, posterAsset.path, log);
    log(`Saved poster frame to ${posterAsset.path}`);

    const sourcePreviewAsset = await writeBufferAsset(
      `${jobId}-source-preview.png`,
      await sourceFile.arrayBuffer()
    );
    log(`Saved source preview to ${sourcePreviewAsset.path}`);

    const gifAsset = {
      path: path.join(process.cwd(), "public", "outputs", `${jobId}.gif`),
      url: `/outputs/${jobId}.gif`
    };
    log("Building final GIF.");
    await createReactionGif(
      sourcePreviewAsset.path,
      mp4Asset.path,
      gifAsset.path,
      log
    );
    log(`Saved final GIF to ${gifAsset.path}`);
    log("Request completed successfully.");

    return NextResponse.json({
      jobId,
      prompt,
      direction,
      model: generatedVideo.model,
      requestId: generatedVideo.requestId,
      inputFileName: image.name,
      inputMimeType: image.type,
      uploadedAssetUrl: uploadedAsset.url,
      sourceImageUrl: sourcePreviewAsset.url,
      videoUrl: mp4Asset.url,
      posterImageUrl: posterAsset.url,
      gifUrl: gifAsset.url,
      debugLog
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    log(`Request failed: ${message}`);

    return NextResponse.json({ error: message, debugLog }, { status: 500 });
  }
}
