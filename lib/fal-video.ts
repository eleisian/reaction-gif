import { fal } from "@fal-ai/client";

const FAL_ENDPOINT = "fal-ai/ltx-video/image-to-video";
export type MotionDirection = "up" | "right" | "down" | "left";

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
};

function composeDirectionalPrompt(prompt: string, direction: MotionDirection) {
  const directionInstruction: Record<MotionDirection, string> = {
    up: "Bias the reaction energy upward in frame, as if the motion expands into the top tile.",
    right:
      "Bias the reaction energy toward the right side of frame, as if the motion expands into the right tile.",
    down:
      "Bias the reaction energy downward in frame, as if the motion expands into the bottom tile.",
    left:
      "Bias the reaction energy toward the left side of frame, as if the motion expands into the left tile."
  };

  return [
    prompt,
    "Keep the original subject recognizable and the camera mostly locked.",
    "Favor a short, readable reaction motion that loops cleanly.",
    directionInstruction[direction]
  ].join(" ");
}

export async function generateLtxVideoFromImage(
  image: File,
  prompt: string,
  direction: MotionDirection
) {
  ensureFalConfigured();

  const result = await fal.subscribe(FAL_ENDPOINT, {
    input: {
      prompt: composeDirectionalPrompt(prompt, direction),
      image_url: image,
      num_inference_steps: 30,
      guidance_scale: 3
    },
    logs: true,
    mode: "polling",
    pollInterval: 1500
  });

  const videoUrl = result.data.video?.url;

  if (!videoUrl) {
    throw new Error("fal did not return a video URL.");
  }

  return {
    requestId: result.requestId,
    model: FAL_ENDPOINT,
    videoUrl
  } satisfies FalVideoResult;
}
