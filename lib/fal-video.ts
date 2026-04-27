import { fal } from "@fal-ai/client";
import {
  DEFAULT_VIDEO_MODEL,
  getVideoModelConfig,
  type VideoModelId
} from "@/lib/video-models";

const FAL_OUTPAINT_ENDPOINT = "openai/gpt-image-2/edit";
const GPT_IMAGE_EDIT_QUALITY = "medium";
export type MotionDirection = "up" | "right" | "down" | "left" | "auto";
export type ReactionFramePhase = "before" | "after";
export type ImageSize = {
  width: number;
  height: number;
};
export type FalImageInput = File | string;

let configured = false;

function ensureFalConfigured() {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is missing.");
  }

  if (!configured) {
    fal.config({
      credentials: process.env.FAL_KEY
    });
    configured = true;
  }
}

export type FalVideoResult = {
  requestId: string;
  model: string;
  videoUrl: string;
  startImageUrl: string;
  endImageUrl: string | null;
};

export type FalImageResult = {
  requestId: string;
  model: string;
  imageUrl: string;
};

export type FalDebugLogger = (message: string) => void;

function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const detail = error as Error & {
    status?: number;
    body?: unknown;
    response?: unknown;
    cause?: unknown;
  };
  const parts = [error.message];

  if (detail.status) {
    parts.push(`status=${detail.status}`);
  }

  if (detail.body) {
    parts.push(`body=${JSON.stringify(detail.body)}`);
  }

  if (detail.response) {
    parts.push(`response=${JSON.stringify(detail.response)}`);
  }

  if (detail.cause) {
    parts.push(`cause=${JSON.stringify(detail.cause)}`);
  }

  return parts.join(" | ");
}

function composeDirectionalPrompt(prompt: string, direction: MotionDirection) {
  const directionInstruction: Record<MotionDirection, string> = {
    up: "The action should naturally use the extended area above the source image.",
    right: "The action should naturally use the extended area to the right of the source image.",
    down: "The action should naturally use the extended area below the source image.",
    left: "The action should naturally use the extended area to the left of the source image.",
    auto: "The action should naturally use the newly extended area around the source image."
  };

  return [
    "Animate from the before frame to the after frame.",
    "The motion should show the user's prompted action happening naturally as a short reaction GIF.",
    `User action: ${prompt}`,
    "Use the first image as the exact starting keyframe and the second image as the exact ending keyframe.",
    "Preserve the source image, characters, art style, camera, lighting, perspective, linework, texture, color palette, and composition.",
    "No cuts, scene changes, captions, borders, panels, black bars, or unrelated objects.",
    directionInstruction[direction]
  ].join(" ");
}

function composeContinuationPrompt(prompt: string, direction: MotionDirection) {
  const directionInstruction: Record<MotionDirection, string> = {
    up: "Let the motion feel like it continues upward from the source frame when appropriate.",
    right: "Let the motion feel like it continues to the right from the source frame when appropriate.",
    down: "Let the motion feel like it continues downward from the source frame when appropriate.",
    left: "Let the motion feel like it continues to the left from the source frame when appropriate.",
    auto: "Let the motion continue naturally from the source frame without reframing or cutting away."
  };

  return [
    "Continue the supplied source frame into a short reaction GIF.",
    "The source frame is the first frame of the generated continuation.",
    `User action: ${prompt}`,
    "Keep the same subject, art style, camera, lighting, perspective, linework, texture, color palette, and composition.",
    "Do not zoom out, reframe, add borders, add panels, add captions, or replace the subject.",
    "Create readable reaction motion that can be stitched immediately after the original source media.",
    directionInstruction[direction]
  ].join(" ");
}

function composeReferenceVideoPrompt(prompt: string, direction: MotionDirection) {
  const directionInstruction: Record<MotionDirection, string> = {
    up: "If the reaction extends spatially, let it read as a continuation above the reference clip.",
    right: "If the reaction extends spatially, let it read as a continuation to the right of the reference clip.",
    down: "If the reaction extends spatially, let it read as a continuation below the reference clip.",
    left: "If the reaction extends spatially, let it read as a continuation to the left of the reference clip.",
    auto: "Continue naturally from the reference clip without reframing or cutting away."
  };

  return [
    "Use @Video1 as the exact source motion reference.",
    "Preserve the original character colors, proportions, silhouette, pose language, loop rhythm, timing, and animation style from @Video1.",
    "Continue the same motion beat as if this is the next reaction moment after @Video1.",
    "Use a rotoscoping-like approach: keep the source subject isolated, stable, and consistent frame-to-frame, as if traced from the original motion.",
    `User action: ${prompt}`,
    "Do not redesign the character, change the color palette, change the camera, zoom out, add captions, add panels, or replace the subject.",
    directionInstruction[direction]
  ].join(" ");
}

function composePromptWithSourceDescription(
  prompt: string,
  sourceDescription?: string | null
) {
  if (!sourceDescription) {
    return prompt;
  }

  return [
    prompt,
    `Source frame description for continuity: ${sourceDescription}`
  ].join("\n\n");
}

export async function generateVideoFromStartEndFrames(
  startImage: FalImageInput,
  endImage: FalImageInput,
  prompt: string,
  direction: MotionDirection,
  model: VideoModelId = DEFAULT_VIDEO_MODEL,
  sourceDescription?: string | null,
  logger?: FalDebugLogger
) {
  ensureFalConfigured();
  const describeInput = (input: FalImageInput) =>
    typeof input === "string"
      ? `url=${input}`
      : `file=${input.name}; type=${input.type}; size=${input.size}`;

  logger?.(
    `fal start/end video input: endpoint=${model}; start=${describeInput(startImage)}; end=${describeInput(endImage)}; direction=${direction}`
  );

  let startImageUrl: string;
  let endImageUrl: string;
  try {
    startImageUrl =
      typeof startImage === "string"
        ? startImage
        : await fal.storage.upload(startImage);
    endImageUrl =
      typeof endImage === "string" ? endImage : await fal.storage.upload(endImage);
  } catch (error) {
    logger?.(`fal start/end video upload failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal start/end video uploaded start image url: ${startImageUrl}`);
  logger?.(`fal start/end video uploaded end image url: ${endImageUrl}`);

  let result: Awaited<ReturnType<typeof fal.subscribe>>;

  const videoInput: Record<string, string | boolean> = {
    prompt: composeContinuationPrompt(
      composePromptWithSourceDescription(prompt, sourceDescription),
      direction
    ),
    image_url: startImageUrl,
    end_image_url: endImageUrl,
    aspect_ratio: "auto",
    resolution: "720p",
    duration: "5",
    generate_audio: false
  };

  if (getVideoModelConfig(model).supportsCameraFixed) {
    videoInput.camera_fixed = true;
  }

  try {
    result = await fal.subscribe(model, {
      input: videoInput,
      logs: true,
      mode: "polling",
      pollInterval: 2500
    });
  } catch (error) {
    logger?.(`fal start/end video request failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal start/end video raw response keys: ${Object.keys(result.data ?? {}).join(", ")}`);

  const videoUrl = result.data.video?.url;

  if (!videoUrl) {
    throw new Error("fal did not return a video URL.");
  }

  return {
    requestId: result.requestId,
    model,
    videoUrl,
    startImageUrl,
    endImageUrl
  } satisfies FalVideoResult;
}

export async function generateVideoFromImage(
  image: FalImageInput,
  prompt: string,
  direction: MotionDirection,
  model: VideoModelId = DEFAULT_VIDEO_MODEL,
  sourceDescription?: string | null,
  logger?: FalDebugLogger
) {
  ensureFalConfigured();
  const describeInput = (input: FalImageInput) =>
    typeof input === "string"
      ? `url=${input}`
      : `file=${input.name}; type=${input.type}; size=${input.size}`;

  logger?.(
    `fal single-image video input: endpoint=${model}; image=${describeInput(image)}; direction=${direction}`
  );

  let imageUrl: string;
  try {
    imageUrl = typeof image === "string" ? image : await fal.storage.upload(image);
  } catch (error) {
    logger?.(`fal single-image video upload failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal single-image video uploaded image url: ${imageUrl}`);

  const videoInput: Record<string, string | boolean> = {
    prompt: composeDirectionalPrompt(
      composePromptWithSourceDescription(prompt, sourceDescription),
      direction
    ),
    image_url: imageUrl,
    aspect_ratio: "auto",
    resolution: "720p",
    duration: "5",
    generate_audio: false
  };

  if (getVideoModelConfig(model).supportsCameraFixed) {
    videoInput.camera_fixed = true;
  }

  let result: Awaited<ReturnType<typeof fal.subscribe>>;

  try {
    result = await fal.subscribe(model, {
      input: videoInput,
      logs: true,
      mode: "polling",
      pollInterval: 2500
    });
  } catch (error) {
    logger?.(`fal single-image video request failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal single-image video raw response keys: ${Object.keys(result.data ?? {}).join(", ")}`);

  const videoUrl = result.data.video?.url;

  if (!videoUrl) {
    throw new Error("fal did not return a video URL.");
  }

  return {
    requestId: result.requestId,
    model,
    videoUrl,
    startImageUrl: imageUrl,
    endImageUrl: null
  } satisfies FalVideoResult;
}

export async function generateVideoFromReferenceVideo(
  video: FalImageInput,
  prompt: string,
  direction: MotionDirection,
  model: VideoModelId = "bytedance/seedance-2.0/reference-to-video",
  sourceDescription?: string | null,
  logger?: FalDebugLogger
) {
  ensureFalConfigured();
  const describeInput = (input: FalImageInput) =>
    typeof input === "string"
      ? `url=${input}`
      : `file=${input.name}; type=${input.type}; size=${input.size}`;

  logger?.(
    `fal reference-video input: endpoint=${model}; video=${describeInput(video)}; direction=${direction}`
  );

  let videoUrl: string;
  try {
    videoUrl = typeof video === "string" ? video : await fal.storage.upload(video);
  } catch (error) {
    logger?.(`fal reference-video upload failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal reference-video uploaded source video url: ${videoUrl}`);

  const videoInput: Record<string, string | boolean | string[]> = {
    prompt: composeReferenceVideoPrompt(
      composePromptWithSourceDescription(prompt, sourceDescription),
      direction
    ),
    video_urls: [videoUrl],
    aspect_ratio: "auto",
    resolution: "720p",
    duration: "5",
    generate_audio: false
  };

  let result: Awaited<ReturnType<typeof fal.subscribe>>;

  try {
    result = await fal.subscribe(model, {
      input: videoInput,
      logs: true,
      mode: "polling",
      pollInterval: 2500
    });
  } catch (error) {
    logger?.(`fal reference-video request failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal reference-video raw response keys: ${Object.keys(result.data ?? {}).join(", ")}`);

  const generatedVideoUrl = result.data.video?.url;

  if (!generatedVideoUrl) {
    throw new Error("fal did not return a video URL.");
  }

  return {
    requestId: result.requestId,
    model,
    videoUrl: generatedVideoUrl,
    startImageUrl: videoUrl,
    endImageUrl: null
  } satisfies FalVideoResult;
}

function composeOutpaintPrompt(
  prompt: string,
  direction: MotionDirection,
  phase: ReactionFramePhase
) {
  const directionInstruction: Record<MotionDirection, string> = {
    up: "Extend the source image into the masked area above it.",
    right: "Extend the source image into the masked area to its right.",
    down: "Extend the source image into the masked area below it.",
    left: "Extend the source image into the masked area to its left.",
    auto: "Extend the source image into the masked area surrounding it on all sides."
  };
  const phaseInstruction =
    phase === "before"
      ? [
          "This is the START FRAME, the first animation keyframe of the user's prompted action.",
          "The prompted action is about to happen, but has not happened yet.",
          "Set up the scene naturally for the action to begin next, but do not show the payoff yet."
        ]
      : [
          "This is the END FRAME, the final animation keyframe of the user's prompted action.",
          "The prompted action has happened.",
          "Show the visible payoff, result, or final reaction pose clearly in the generated area.",
          "Use the provided start frame as the visual continuity reference.",
          "Keep the generated background, architecture, scenery, lighting, camera, perspective, and composition as identical to the start frame as possible.",
          "Keep the same generated characters, creatures, objects, clothing, props, colors, scale, and placement from the start frame.",
          "Do not replace the start-frame subject with a different character, creature, species, costume, object, or design.",
          "Only change the pose, facial expression, gesture, contact points, or small action state needed to show the user's prompted action or reaction."
        ];

  return [
    directionInstruction[direction],
    ...phaseInstruction,
    `User action: ${prompt}`,
    "Preserve the unmasked source image exactly.",
    "Fill the entire masked area edge-to-edge. No black bars, blank areas, letterboxing, fades, or empty regions.",
    "Continue the same single continuous scene from the visible border of the source image.",
    "Match the source image's exact art style, character design, lighting, perspective, texture, linework, color palette, level of detail, and composition.",
    "Do not create a comic strip, storyboard, separate panel, caption, gutter, border, frame, collage, or new unrelated scene."
  ].join(" ");
}

export async function generateOutpaintedImage(
  image: File,
  mask: File,
  prompt: string,
  direction: MotionDirection,
  imageSize: ImageSize,
  phase: ReactionFramePhase,
  sourceDescription?: string | null,
  logger?: FalDebugLogger
) {
  ensureFalConfigured();
  logger?.(
    `fal GPT Image 2 edit upload input: endpoint=${FAL_OUTPAINT_ENDPOINT}; phase=${phase}; image=${image.name}; imageType=${image.type}; imageSize=${image.size}; mask=${mask.name}; maskType=${mask.type}; maskSize=${mask.size}; direction=${direction}; output=${imageSize.width}x${imageSize.height}; quality=${GPT_IMAGE_EDIT_QUALITY}`
  );

  let imageUrl: string;
  let maskUrl: string;
  try {
    imageUrl = await fal.storage.upload(image);
    maskUrl = await fal.storage.upload(mask);
  } catch (error) {
    logger?.(`fal GPT Image 2 edit upload failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal GPT Image 2 edit uploaded image url: ${imageUrl}`);
  logger?.(`fal GPT Image 2 edit uploaded mask url: ${maskUrl}`);

  let result: Awaited<ReturnType<typeof fal.subscribe>>;

  try {
    result = await fal.subscribe(FAL_OUTPAINT_ENDPOINT, {
      input: {
        prompt: composeOutpaintPrompt(
          composePromptWithSourceDescription(prompt, sourceDescription),
          direction,
          phase
        ),
        image_urls: [imageUrl],
        mask_url: maskUrl,
        image_size: imageSize,
        quality: GPT_IMAGE_EDIT_QUALITY,
        num_images: 1,
        output_format: "png",
        sync_mode: false
      },
      logs: true,
      mode: "polling",
      pollInterval: 1500
    });
  } catch (error) {
    logger?.(`fal GPT Image 2 edit request failed: ${describeError(error)}`);
    throw error;
  }

  logger?.(`fal GPT Image 2 edit raw response keys: ${Object.keys(result.data ?? {}).join(", ")}`);

  const imageUrlResult = result.data.images?.[0]?.url;

  if (!imageUrlResult) {
    throw new Error("fal GPT Image 2 edit did not return an image URL.");
  }

  return {
    requestId: result.requestId,
    model: FAL_OUTPAINT_ENDPOINT,
    imageUrl: imageUrlResult
  } satisfies FalImageResult;
}
