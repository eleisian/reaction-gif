import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createOutpaintEditInput,
  createContinuationGif,
  createContinuationVideo,
  createMattedTransparentGif,
  createReferenceVideoForModel,
  createReactionGif,
  createPosterFrameFromVideo,
  convertMp4ToGif,
  cropImageRegion,
  cropVideoRegion,
  downloadUrlToFile,
  ensureOutputDirectory,
  extensionFromMimeType,
  extractLastFrame,
  extractStillFrame,
  getFfmpegCommand,
  getImageDimensions,
  getReactionCropBox,
  hasTransparentBackground,
  isMissingFfmpegError,
  readFileToNodeFile,
  resizeImageToMatch,
  resizeImageForModelInput,
  scaleCropBox,
  writeBufferAsset
} from "@/lib/media";
import {
  generateOutpaintedImage,
  generateVideoFromImage,
  generateVideoFromReferenceVideo,
  generateVideoFromStartEndFrames,
  type MotionDirection
} from "@/lib/fal-video";
import {
  DEFAULT_VIDEO_MODEL,
  isReferenceVideoModel,
  isVideoModelId,
  type VideoModelId
} from "@/lib/video-models";
import { describeSourceImage } from "@/lib/vision";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_INPUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime"
]);
const ALLOWED_DIRECTIONS = new Set<MotionDirection>([
  "up",
  "right",
  "down",
  "left",
  "auto"
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIN_EXTENSION_SCALE = 0.25;
const MAX_EXTENSION_SCALE = 1;
const MIN_OVERFLOW_SCALE = 0;
const MAX_OVERFLOW_SCALE = 0.5;
const DEFAULT_DIRECTION: MotionDirection = "auto";
type GenerationMode = "continuation" | "keyframes";

function parseGenerationMode(value: FormDataEntryValue | null): GenerationMode {
  return value === "keyframes" ? "keyframes" : "continuation";
}

function parseExtensionScale(value: FormDataEntryValue | null) {
  const parsed = Number(value ?? 1);

  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(MIN_EXTENSION_SCALE, Math.min(parsed, MAX_EXTENSION_SCALE));
}

function parseOverflowScale(value: FormDataEntryValue | null) {
  const parsed = Number(value ?? 0);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(MIN_OVERFLOW_SCALE, Math.min(parsed, MAX_OVERFLOW_SCALE));
}

function parseBoolean(value: FormDataEntryValue | null) {
  return value === "true" || value === "1" || value === "on";
}

function describeServerError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const detail = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    body?: unknown;
    cause?: unknown;
  };
  const parts = [error.message];

  if (detail.code) {
    parts.push(`code=${String(detail.code)}`);
  }

  if (detail.status) {
    parts.push(`status=${String(detail.status)}`);
  }

  if (detail.statusCode) {
    parts.push(`statusCode=${String(detail.statusCode)}`);
  }

  if (detail.body) {
    parts.push(`body=${JSON.stringify(detail.body)}`);
  }

  if (detail.cause) {
    parts.push(`cause=${JSON.stringify(detail.cause)}`);
  }

  return parts.join(" | ");
}

export async function POST(request: Request) {
  const debugLog: string[] = [];
  const log = (message: string) => {
    debugLog.push(message);
    console.log(`[generate] ${message}`);
  };

  try {
    log("Starting /api/generate request.");
    log(`Runtime cwd: ${process.cwd()}`);
    log(`FAL_KEY configured: ${Boolean(process.env.FAL_KEY)}`);
    log(`ffmpeg command: ${getFfmpegCommand()}`);
    const formData = await request.formData();
    const prompt = String(formData.get("prompt") ?? "").trim();
    const image = formData.get("image");
    const requestedDirection = String(formData.get("direction") ?? "").trim();
    const direction = (requestedDirection || DEFAULT_DIRECTION) as MotionDirection;
    const requestedVideoModel = String(
      formData.get("videoModel") ?? DEFAULT_VIDEO_MODEL
    );
    let videoModel: VideoModelId = isVideoModelId(requestedVideoModel)
      ? requestedVideoModel
      : DEFAULT_VIDEO_MODEL;
    const extensionScale = parseExtensionScale(formData.get("extensionScale"));
    const requestedOverflowScale = parseOverflowScale(formData.get("overflowScale"));
    const overflowScale = requestedDirection ? requestedOverflowScale : 0;
    const generationMode = parseGenerationMode(formData.get("generationMode"));
    const usesExtendedFrame = Boolean(requestedDirection);
    const removeGeneratedBackground = parseBoolean(
      formData.get("removeGeneratedBackground")
    );
    log(`Prompt length: ${prompt.length}`);
    log(`Requested video model: ${requestedVideoModel}`);
    log(`Resolved video model: ${videoModel}`);
    log(`Generation mode: ${generationMode}`);
    log(`Remove generated background: ${removeGeneratedBackground}`);
    log(`Extension scale: ${extensionScale}`);
    log(`Reaction overflow scale: ${overflowScale}`);
    if (!requestedDirection && requestedOverflowScale !== 0) {
      log("No generation frame selected; clamped reaction overflow to 0.");
    }

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
    log(
      requestedDirection
        ? `Selected motion tile: ${direction}`
        : "No motion tile selected; using auto extension around the source frame"
    );

    if (!ALLOWED_DIRECTIONS.has(direction)) {
      return NextResponse.json(
        { error: "Unsupported direction selected.", debugLog },
        { status: 400 }
      );
    }

    if (!ALLOWED_INPUT_TYPES.has(image.type)) {
      return NextResponse.json(
        { error: "Supported formats are PNG, JPG, WEBP, GIF, MP4, WEBM, and MOV.", debugLog },
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
    const outputPrefix = jobId;
    const uploadExtension = extensionFromMimeType(image.type);
    const uploadBuffer = Buffer.from(await image.arrayBuffer());
    const uploadedAsset = await writeBufferAsset(
      `${outputPrefix}/source-image/upload.${uploadExtension}`,
      uploadBuffer
    );
    log(`Saved uploaded asset to ${uploadedAsset.path}`);
    const isAnimatedInput =
      image.type === "image/gif" || image.type.startsWith("video/");

    const sourceFrameAsset =
      isAnimatedInput
        ? {
            path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "source-frame.png"),
            url: `/outputs/${outputPrefix}/source-image/source-frame.png`,
            fileName: "source-frame.png",
            mimeType: "image/png"
          }
        : {
            path: uploadedAsset.path,
            url: uploadedAsset.url,
            fileName: `upload.${uploadExtension}`,
            mimeType: image.type
          };

    if (isAnimatedInput) {
      if (generationMode === "keyframes" && requestedDirection) {
        log("Extracting first source frame with ffmpeg because keyframe mode and an extension frame were selected.");
        await extractStillFrame(uploadedAsset.path, sourceFrameAsset.path, log);
      } else {
        log("Extracting last source frame with ffmpeg for continuation.");
        await extractLastFrame(uploadedAsset.path, sourceFrameAsset.path, log);
      }
      log(`Source frame saved to ${sourceFrameAsset.path}`);
    } else {
      log("Static image input detected; using uploaded source directly without ffmpeg.");
    }

    const sourceDescription = await describeSourceImage(
      sourceFrameAsset.path,
      sourceFrameAsset.mimeType,
      log
    );
    const sourceHasTransparency = await hasTransparentBackground(sourceFrameAsset.path);
    log(`Source transparency detected: ${sourceHasTransparency}`);
    const sourceContinuityDescription = [
      sourceDescription,
      sourceHasTransparency
        ? "The source has a transparent/no-background canvas. Rotoscope-preserve the source subject exactly. Keep the original subject as if it is a pasted transparent sticker layer. Only generate new reaction motion, props, effects, or environment around it. Do not repaint the subject, and avoid inventing a filled backdrop behind it."
        : null
    ]
      .filter(Boolean)
      .join(" ");

    const sourceFile = await readFileToNodeFile(
      sourceFrameAsset.path,
      sourceFrameAsset.fileName,
      sourceFrameAsset.mimeType
    );
    log("Created File object for fal input.");

    const sourceIsAnimated = isAnimatedInput;

    if (isReferenceVideoModel(videoModel) && (!sourceIsAnimated || generationMode !== "continuation")) {
      log(
        "Seedance reference-to-video requires an animated source in continuation mode; falling back to Seedance 2.0 image-to-video."
      );
      videoModel = DEFAULT_VIDEO_MODEL;
    }

    if (generationMode === "continuation" && !usesExtendedFrame) {
      log("Continuation mode without a selected generation frame: skipping image outpaint and keyframes.");
      const useReferenceVideo = sourceIsAnimated && isReferenceVideoModel(videoModel);
      const modelInputFrameAsset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "model-input-frame.png"),
        url: `/outputs/${outputPrefix}/source-image/model-input-frame.png`,
        fileName: "model-input-frame.png",
        mimeType: "image/png"
      };
      const generatedVideo = useReferenceVideo
        ? await (async () => {
            const referenceVideoAsset = {
              path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "reference-video.mp4"),
              fileName: "reference-video.mp4",
              url: `/outputs/${outputPrefix}/source-image/reference-video.mp4`,
              mimeType: "video/mp4"
            };
            log("Creating normalized reference video for Seedance reference-to-video.");
            await createReferenceVideoForModel(
              uploadedAsset.path,
              referenceVideoAsset.path,
              log
            );
            const referenceVideoFile = await readFileToNodeFile(
              referenceVideoAsset.path,
              referenceVideoAsset.fileName,
              referenceVideoAsset.mimeType
            );
            log("Submitting animated source clip to fal reference-to-video.");
            return await generateVideoFromReferenceVideo(
              referenceVideoFile,
              prompt,
              direction,
              videoModel,
              sourceContinuityDescription,
              log
            );
          })()
        : await (async () => {
            const modelInputFrame = await resizeImageForModelInput(
              sourceFrameAsset.path,
              modelInputFrameAsset.path,
              300,
              log
            );
            if (modelInputFrame.resized) {
              log(
                `Upscaled source frame for model input to ${modelInputFrame.dimensions.width}x${modelInputFrame.dimensions.height}.`
              );
            } else {
              log("Source frame already meets model input minimum dimensions.");
            }
            const falInputFile = await readFileToNodeFile(
              modelInputFrame.path,
              modelInputFrame.resized
                ? modelInputFrameAsset.fileName
                : sourceFrameAsset.fileName,
              "image/png"
            );
            log("Submitting source last frame directly to fal image-to-video.");
            return await generateVideoFromImage(
              falInputFile,
              prompt,
              direction,
              videoModel,
              sourceContinuityDescription,
              log
            );
          })();
      log(`fal request id: ${generatedVideo.requestId}`);
      log(`fal model: ${generatedVideo.model}`);
      log(`fal video url: ${generatedVideo.videoUrl}`);

      const mp4Asset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "reaction.mp4"),
        url: `/outputs/${outputPrefix}/generated-video/reaction.mp4`
      };
      await downloadUrlToFile(generatedVideo.videoUrl, mp4Asset.path, log);
      log(`Saved generated MP4 to ${mp4Asset.path}`);

      const mattedGifAsset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "reaction-matted.gif"),
        url: `/outputs/${outputPrefix}/generated-video/reaction-matted.gif`
      };

      if (removeGeneratedBackground) {
        log("Removing generated-video background and exporting transparent matted GIF.");
        await createMattedTransparentGif(mp4Asset.path, mattedGifAsset.path, log);
        log(`Saved transparent matted continuation GIF to ${mattedGifAsset.path}`);
      } else {
        log("Skipping generated background removal; raw AI continuation will be used for exports.");
      }

      const continuationVideoForFinal = mp4Asset;
      const continuationGifInputForFinal = removeGeneratedBackground
        ? mattedGifAsset
        : continuationVideoForFinal;

      const fullContinuationVideoAsset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "full-reaction.mp4"),
        url: `/outputs/${outputPrefix}/generated-video/full-reaction.mp4`
      };
      log("Building full continuation MP4 from source media plus generated continuation.");
      await createContinuationVideo(
        sourceIsAnimated ? uploadedAsset.path : sourceFrameAsset.path,
        sourceIsAnimated,
        continuationVideoForFinal.path,
        fullContinuationVideoAsset.path,
        log
      );
      log(`Saved full continuation MP4 to ${fullContinuationVideoAsset.path}`);

      let posterAsset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "poster.png"),
        url: `/outputs/${outputPrefix}/generated-video/poster.png`
      };
      try {
        log("Extracting poster frame from generated continuation video.");
        await createPosterFrameFromVideo(fullContinuationVideoAsset.path, posterAsset.path, log);
        log(`Saved poster frame to ${posterAsset.path}`);
      } catch (posterError) {
        if (!isMissingFfmpegError(posterError)) {
          throw posterError;
        }

        log("Skipping poster extraction because ffmpeg is missing; using source frame as poster fallback.");
        posterAsset = {
          path: sourceFrameAsset.path,
          url: sourceFrameAsset.url
        };
      }

      let gifAsset: { path: string; url: string } | null = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "gif", "reaction.gif"),
        url: `/outputs/${outputPrefix}/gif/reaction.gif`
      };
      try {
        log("Building final continuation GIF.");
        await createContinuationGif(
          sourceIsAnimated ? uploadedAsset.path : sourceFrameAsset.path,
          sourceIsAnimated,
          continuationGifInputForFinal.path,
          gifAsset.path,
          log,
          { transparentBackground: sourceHasTransparency || removeGeneratedBackground }
        );
        log(`Saved final GIF to ${gifAsset.path}`);
      } catch (gifError) {
        if (!isMissingFfmpegError(gifError)) {
          throw gifError;
        }

        log("Skipping GIF assembly because ffmpeg is missing; returning MP4 only.");
        gifAsset = null;
      }
      log("Request completed successfully.");

      return NextResponse.json({
        jobId,
        prompt,
        direction,
        generationMode,
        removeGeneratedBackground,
        videoModel,
        extensionScale,
        overflowScale,
        model: generatedVideo.model,
        requestId: generatedVideo.requestId,
        falVideoStartImageUrl: generatedVideo.startImageUrl,
        falVideoEndImageUrl: generatedVideo.endImageUrl,
        startFrameRequestId: null,
        endFrameRequestId: null,
        inputFileName: image.name,
        inputMimeType: image.type,
        uploadedAssetUrl: uploadedAsset.url,
        sourceImageUrl: sourceFrameAsset.url,
        beforeFrameUrl: sourceFrameAsset.url,
        afterFrameUrl: sourceFrameAsset.url,
        videoStartFrameUrl: sourceFrameAsset.url,
        videoEndFrameUrl: sourceFrameAsset.url,
        editCanvasUrl: null,
        editMaskUrl: null,
        afterEditMaskUrl: null,
        sourceDescription,
        sourceHasTransparency,
        extendedImageUrl: sourceFrameAsset.url,
        videoUrl: fullContinuationVideoAsset.url,
        generatedVideoUrl: mp4Asset.url,
        mattedGifUrl: removeGeneratedBackground ? mattedGifAsset.url : null,
        compositedVideoUrl: null,
        compositedGifUrl: null,
        posterImageUrl: posterAsset.url,
        gifUrl: gifAsset?.url ?? null,
        reactionOnlyImageUrl: sourceFrameAsset.url,
        reactionOnlyVideoUrl: mp4Asset.url,
        reactionOnlyGifUrl: removeGeneratedBackground ? mattedGifAsset.url : null,
        debugLog
      });
    }

    if (generationMode === "continuation" && usesExtendedFrame) {
      log(
        "Continuation mode with a selected generation frame: using the extended-frame outpaint pipeline before image-to-video generation."
      );
    }

    const editCanvasAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "edit-canvas.png"),
      fileName: "edit-canvas.png",
      url: `/outputs/${outputPrefix}/source-image/edit-canvas.png`,
      mimeType: "image/png"
    };
    const editMaskAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "edit-mask.png"),
      fileName: "edit-mask.png",
      url: `/outputs/${outputPrefix}/source-image/edit-mask.png`,
      mimeType: "image/png"
    };
    log("Creating expanded canvas and mask for GPT Image 2 edit outpaint.");
    const editLayout = await createOutpaintEditInput(
      sourceFrameAsset.path,
      editCanvasAsset.path,
      editMaskAsset.path,
      direction,
      extensionScale,
      log
    );
    log("Created GPT Image 2 edit canvas and mask assets.");
    const reactionCrop = getReactionCropBox(
      editLayout.source,
      direction,
      extensionScale,
      overflowScale
    );
    log(
      `Reaction crop box: ${reactionCrop.cropBox.x},${reactionCrop.cropBox.y},${reactionCrop.cropBox.width},${reactionCrop.cropBox.height}; sourceOverflow=${reactionCrop.sourceOverflow}`
    );

    const editCanvasFile = await readFileToNodeFile(
      editCanvasAsset.path,
      editCanvasAsset.fileName,
      editCanvasAsset.mimeType
    );
    const editMaskFile = await readFileToNodeFile(
      editMaskAsset.path,
      editMaskAsset.fileName,
      editMaskAsset.mimeType
    );
    log("Created File objects for GPT Image 2 edit input.");

    log(
      generationMode === "keyframes"
        ? "Submitting masked source canvas to fal GPT Image 2 edit for before frame."
        : "Submitting masked source canvas to fal GPT Image 2 edit for extended continuation frame."
    );
    const beforeFrame = await generateOutpaintedImage(
      editCanvasFile,
      editMaskFile,
      prompt,
      direction,
      editLayout.canvas,
      generationMode === "keyframes" ? "before" : "after",
      sourceContinuityDescription,
      log
    );
    log(`fal before outpaint request id: ${beforeFrame.requestId}`);
    log(`fal before outpaint model: ${beforeFrame.model}`);
    log(`fal before outpaint image url: ${beforeFrame.imageUrl}`);

    const beforeFrameAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "start-frame", generationMode === "keyframes" ? "before-frame.png" : "extended-frame.png"),
      fileName: generationMode === "keyframes" ? "before-frame.png" : "extended-frame.png",
      url: `/outputs/${outputPrefix}/start-frame/${generationMode === "keyframes" ? "before-frame.png" : "extended-frame.png"}`,
      mimeType: "image/png"
    };
    await downloadUrlToFile(beforeFrame.imageUrl, beforeFrameAsset.path, log);
    log(`Saved generated ${generationMode === "keyframes" ? "before" : "extended"} frame to ${beforeFrameAsset.path}`);
    const beforeFrameSize = await getImageDimensions(beforeFrameAsset.path);
    log(`Generated frame dimensions: ${beforeFrameSize.width}x${beforeFrameSize.height}`);

    let afterFrame = beforeFrame;
    let afterFrameAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "end-frame", "after-frame.png"),
      url: `/outputs/${outputPrefix}/end-frame/after-frame.png`
    };
    let afterFrameSize = beforeFrameSize;
    let afterMaskAsset: {
      path: string;
      fileName: string;
      url: string;
      mimeType: string;
    } | null = null;

    if (generationMode === "keyframes") {
      afterMaskAsset = {
        path: path.join(process.cwd(), "public", "outputs", outputPrefix, "source-image", "after-edit-mask.png"),
        fileName: "after-edit-mask.png",
        url: `/outputs/${outputPrefix}/source-image/after-edit-mask.png`,
        mimeType: "image/png"
      };
      log("Resizing edit mask to match generated before frame for after-frame edit.");
      const afterEditSize = await resizeImageToMatch(
        editMaskAsset.path,
        beforeFrameAsset.path,
        afterMaskAsset.path,
        log
      );
      log(`After-frame edit mask dimensions: ${afterEditSize.width}x${afterEditSize.height}`);

      const beforeFrameFile = await readFileToNodeFile(
        beforeFrameAsset.path,
        beforeFrameAsset.fileName,
        beforeFrameAsset.mimeType
      );
      const afterMaskFile = await readFileToNodeFile(
        afterMaskAsset.path,
        afterMaskAsset.fileName,
        afterMaskAsset.mimeType
      );
      log("Created File object from generated before frame for after-frame edit.");

      log("Submitting generated before frame to fal GPT Image 2 edit for after frame.");
      afterFrame = await generateOutpaintedImage(
        beforeFrameFile,
        afterMaskFile,
        prompt,
        direction,
        afterEditSize,
        "after",
        sourceContinuityDescription,
        log
      );
      log(`fal after outpaint request id: ${afterFrame.requestId}`);
      log(`fal after outpaint model: ${afterFrame.model}`);
      log(`fal after outpaint image url: ${afterFrame.imageUrl}`);

      await downloadUrlToFile(afterFrame.imageUrl, afterFrameAsset.path, log);
      log(`Saved generated after frame to ${afterFrameAsset.path}`);
      afterFrameSize = await getImageDimensions(afterFrameAsset.path);
      log(`After frame dimensions: ${afterFrameSize.width}x${afterFrameSize.height}`);
    } else {
      afterFrameAsset = {
        path: beforeFrameAsset.path,
        url: beforeFrameAsset.url
      };
      log("Skipping second outpaint because continuation mode uses a single extended frame.");
    }

    const generatedVideo =
      generationMode === "continuation"
        ? await (async () => {
            const extendedFrameFile = await readFileToNodeFile(
              beforeFrameAsset.path,
              beforeFrameAsset.fileName,
              beforeFrameAsset.mimeType
            );
            log(
              "Submitting single extended frame to image-to-video for continuation mode."
            );
            return await generateVideoFromImage(
              extendedFrameFile,
              prompt,
              direction,
              videoModel,
              sourceContinuityDescription,
              log
            );
          })()
        : await (async () => {
            log("Submitting before/after image-to-video request to fal.");
            return await generateVideoFromStartEndFrames(
              beforeFrame.imageUrl,
              afterFrame.imageUrl,
              prompt,
              direction,
              videoModel,
              sourceContinuityDescription,
              log
            );
          })();
    log(`fal request id: ${generatedVideo.requestId}`);
    log(`fal model: ${generatedVideo.model}`);
    log(`fal video url: ${generatedVideo.videoUrl}`);

    const mp4Asset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "reaction.mp4"),
      url: `/outputs/${outputPrefix}/generated-video/reaction.mp4`
    };
    await downloadUrlToFile(generatedVideo.videoUrl, mp4Asset.path, log);
    log(`Saved generated MP4 to ${mp4Asset.path}`);

    const reactionOnlyImageAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "reaction-only", "reaction-frame.png"),
      url: `/outputs/${outputPrefix}/reaction-only/reaction-frame.png`
    };
    log("Cropping reaction-only still from generated extension region.");
    const reactionImageCropBox = scaleCropBox(
      reactionCrop.cropBox,
      editLayout.canvas,
      afterFrameSize
    );
    log(
      `Scaled reaction still crop box: ${reactionImageCropBox.x},${reactionImageCropBox.y},${reactionImageCropBox.width},${reactionImageCropBox.height}`
    );
    await cropImageRegion(
      afterFrameAsset.path,
      reactionOnlyImageAsset.path,
      reactionImageCropBox,
      log
    );
    log(`Saved reaction-only still to ${reactionOnlyImageAsset.path}`);

    const reactionOnlyVideoAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "reaction-only", "reaction.mp4"),
      url: `/outputs/${outputPrefix}/reaction-only/reaction.mp4`
    };
    log("Cropping reaction-only video from generated extension region.");
    await cropVideoRegion(
      mp4Asset.path,
      reactionOnlyVideoAsset.path,
      reactionCrop.cropBox,
      editLayout.canvas,
      log
    );
    log(`Saved reaction-only video to ${reactionOnlyVideoAsset.path}`);

    let posterAsset = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "generated-video", "poster.png"),
      url: `/outputs/${outputPrefix}/generated-video/poster.png`
    };
    try {
      log("Extracting poster frame from generated video.");
      await createPosterFrameFromVideo(mp4Asset.path, posterAsset.path, log);
      log(`Saved poster frame to ${posterAsset.path}`);
    } catch (posterError) {
      if (!isMissingFfmpegError(posterError)) {
        throw posterError;
      }

      log("Skipping poster extraction because ffmpeg is missing; using extended image as poster fallback.");
      posterAsset = afterFrameAsset;
    }

    const sourcePreviewAsset =
      generationMode === "continuation"
        ? {
            path: beforeFrameAsset.path,
            url: beforeFrameAsset.url
          }
        : {
            path: sourceFrameAsset.path,
            url: sourceFrameAsset.url
          };
    log(`Using source preview from ${sourcePreviewAsset.path}`);

    let gifAsset: { path: string; url: string } | null = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "gif", "reaction.gif"),
      url: `/outputs/${outputPrefix}/gif/reaction.gif`
    };
    let reactionOnlyGifAsset: { path: string; url: string } | null = {
      path: path.join(process.cwd(), "public", "outputs", outputPrefix, "reaction-only", "reaction.gif"),
      url: `/outputs/${outputPrefix}/reaction-only/reaction.gif`
    };
    try {
      log("Building final GIF.");
      if (generationMode === "keyframes") {
        await createReactionGif(
          beforeFrameAsset.path,
          mp4Asset.path,
          afterFrameAsset.path,
          gifAsset.path,
          log,
          { transparentBackground: sourceHasTransparency }
        );
      } else if (requestedDirection) {
        await convertMp4ToGif(
          mp4Asset.path,
          gifAsset.path,
          log
        );
      } else {
        await createContinuationGif(
          sourceIsAnimated ? uploadedAsset.path : sourceFrameAsset.path,
          sourceIsAnimated,
          mp4Asset.path,
          gifAsset.path,
          log,
          { transparentBackground: sourceHasTransparency }
        );
      }
      log(`Saved final GIF to ${gifAsset.path}`);
      log("Building reaction-only GIF.");
      await convertMp4ToGif(
        reactionOnlyVideoAsset.path,
        reactionOnlyGifAsset.path,
        log
      );
      log(`Saved reaction-only GIF to ${reactionOnlyGifAsset.path}`);
    } catch (gifError) {
      if (!isMissingFfmpegError(gifError)) {
        throw gifError;
      }

      log("Skipping GIF assembly because ffmpeg is missing; returning MP4 and extended still only.");
      gifAsset = null;
      reactionOnlyGifAsset = null;
    }
    log("Request completed successfully.");

    return NextResponse.json({
      jobId,
      prompt,
      direction,
      generationMode,
      removeGeneratedBackground: false,
      videoModel,
      extensionScale,
      overflowScale,
      model: generatedVideo.model,
      requestId: generatedVideo.requestId,
      falVideoStartImageUrl: generatedVideo.startImageUrl,
      falVideoEndImageUrl: generatedVideo.endImageUrl,
      startFrameRequestId: beforeFrame.requestId,
      endFrameRequestId: afterFrame.requestId,
      inputFileName: image.name,
      inputMimeType: image.type,
      uploadedAssetUrl: uploadedAsset.url,
      sourceImageUrl: sourcePreviewAsset.url,
      beforeFrameUrl: beforeFrameAsset.url,
      afterFrameUrl: afterFrameAsset.url,
      videoStartFrameUrl: beforeFrameAsset.url,
      videoEndFrameUrl: afterFrameAsset.url,
      editCanvasUrl: editCanvasAsset.url,
      editMaskUrl: editMaskAsset.url,
      afterEditMaskUrl: afterMaskAsset?.url ?? null,
      sourceDescription,
      sourceHasTransparency,
      extendedImageUrl: afterFrameAsset.url,
      videoUrl: mp4Asset.url,
      generatedVideoUrl: mp4Asset.url,
      mattedGifUrl: null,
      compositedVideoUrl: null,
      compositedGifUrl: null,
      posterImageUrl: posterAsset.url,
      gifUrl: gifAsset?.url ?? null,
      reactionOnlyImageUrl: reactionOnlyImageAsset.url,
      reactionOnlyVideoUrl: reactionOnlyVideoAsset.url,
      reactionOnlyGifUrl: reactionOnlyGifAsset?.url ?? null,
      debugLog
    });
  } catch (error) {
    const message = describeServerError(error);
    log(`Request failed: ${message}`);
    if (error instanceof Error && error.stack) {
      log(`Stack: ${error.stack.split("\n").slice(0, 8).join("\n")}`);
    }
    console.error("[generate] Request failed", error);

    return NextResponse.json({ error: message, debugLog }, { status: 500 });
  }
}
