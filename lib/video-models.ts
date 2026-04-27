export const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.0/image-to-video";

export const VIDEO_MODELS = [
  {
    id: "bytedance/seedance-2.0/reference-to-video",
    label: "Seedance 2.0 Reference",
    description: "Uses source video/GIF motion as a reference clip",
    supportsCameraFixed: false,
    usesReferenceVideo: true
  },
  {
    id: "bytedance/seedance-2.0/image-to-video",
    label: "Seedance 2.0",
    description: "Best quality start/end frame control",
    supportsCameraFixed: false,
    usesReferenceVideo: false
  },
  {
    id: "bytedance/seedance-2.0/fast/image-to-video",
    label: "Seedance 2.0 Fast",
    description: "Faster, cheaper start/end frame control",
    supportsCameraFixed: false,
    usesReferenceVideo: false
  },
  {
    id: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",
    label: "Seedance 1.5 Pro",
    description: "Older pro model with start/end frame support",
    supportsCameraFixed: true,
    usesReferenceVideo: false
  },
  {
    id: "fal-ai/kling-video/o3/standard/image-to-video",
    label: "Kling O3 Standard",
    description: "Kling start/end-capable image-to-video model",
    supportsCameraFixed: false,
    usesReferenceVideo: false
  }
] as const;

export type VideoModelId = (typeof VIDEO_MODELS)[number]["id"];

export function isVideoModelId(value: string): value is VideoModelId {
  return VIDEO_MODELS.some((model) => model.id === value);
}

export function getVideoModelConfig(id: VideoModelId) {
  return VIDEO_MODELS.find((model) => model.id === id) ?? VIDEO_MODELS[0];
}

export function isReferenceVideoModel(id: VideoModelId) {
  return getVideoModelConfig(id).usesReferenceVideo;
}
