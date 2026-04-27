"use client";

import Image from "next/image";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Hand,
  ImagePlus,
  MousePointer2,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODELS, type VideoModelId } from "@/lib/video-models";
import {
  CSSProperties,
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";

type MotionDirection = "up" | "right" | "down" | "left";
type GenerationDirection = MotionDirection | "auto";
type GenerationMode = "continuation" | "keyframes";

type GenerateResponse = {
  jobId: string;
  prompt: string;
  direction: GenerationDirection;
  generationMode: GenerationMode;
  removeGeneratedBackground: boolean;
  videoModel: VideoModelId;
  model: string;
  requestId: string;
  extensionScale: number;
  overflowScale: number;
  falVideoStartImageUrl: string;
  falVideoEndImageUrl: string | null;
  startFrameRequestId: string | null;
  endFrameRequestId: string | null;
  inputFileName: string;
  inputMimeType: string;
  uploadedAssetUrl: string;
  sourceImageUrl: string;
  beforeFrameUrl: string;
  afterFrameUrl: string;
  videoStartFrameUrl: string;
  videoEndFrameUrl: string;
  editCanvasUrl: string | null;
  editMaskUrl: string | null;
  afterEditMaskUrl: string | null;
  sourceHasTransparency: boolean;
  extendedImageUrl: string;
  videoUrl: string;
  generatedVideoUrl: string;
  mattedGifUrl: string | null;
  compositedVideoUrl: string | null;
  compositedGifUrl: string | null;
  posterImageUrl: string;
  gifUrl: string | null;
  reactionOnlyImageUrl: string;
  reactionOnlyVideoUrl: string;
  reactionOnlyGifUrl: string | null;
  debugLog: string[];
};

type ErrorResponse = {
  error: string;
  debugLog?: string[];
};

const DEFAULT_PROMPT =
  "A skeptical side-eye, a tiny head tilt, then a quick meme-ready pause.";

const DIRECTION_OPTIONS: Array<{
  value: MotionDirection;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "left", label: "Extend left", icon: ArrowLeft },
  { value: "right", label: "Extend right", icon: ArrowRight },
  { value: "up", label: "Extend up", icon: ArrowUp },
  { value: "down", label: "Extend down", icon: ArrowDown }
];

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not preview the selected file."));
    reader.readAsDataURL(file);
  });
}

async function readImageSize(src: string) {
  return await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight
      });
    image.onerror = () => reject(new Error("Could not read the selected image size."));
    image.src = src;
  });
}

function getImageFile(files: FileList | File[]) {
  return (
    Array.from(files).find(
      (file) => file.type.startsWith("image/") || file.type.startsWith("video/")
    ) ?? null
  );
}

function getPastedImage(event: ClipboardEvent<HTMLElement>) {
  const item = Array.from(event.clipboardData.items).find((clipboardItem) =>
    clipboardItem.type.startsWith("image/")
  );

  return item?.getAsFile() ?? null;
}

async function parseGenerateResponse(response: Response) {
  const bodyText = await response.text();

  if (!bodyText) {
    return {
      data: null,
      bodyText: ""
    };
  }

  try {
    return {
      data: JSON.parse(bodyText) as GenerateResponse | ErrorResponse,
      bodyText
    };
  } catch {
    return {
      data: null,
      bodyText
    };
  }
}

export default function HomePage() {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    nextScrollLeft: number;
    nextScrollTop: number;
    animationFrame: number | null;
  } | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [sourceAspectRatio, setSourceAspectRatio] = useState("1 / 1");
  const [selectedFileLabel, setSelectedFileLabel] = useState("Add image");
  const [direction, setDirection] = useState<MotionDirection | null>(null);
  const [generationMode, setGenerationMode] =
    useState<GenerationMode>("continuation");
  const [removeGeneratedBackground, setRemoveGeneratedBackground] = useState(true);
  const [videoModel, setVideoModel] = useState<VideoModelId>(DEFAULT_VIDEO_MODEL);
  const [extensionScale, setExtensionScale] = useState(1);
  const [overflowScale, setOverflowScale] = useState(0.18);
  const [outputMode, setOutputMode] = useState<"full" | "reaction">("full");
  const [hoveredDirection, setHoveredDirection] = useState<MotionDirection | null>(null);
  const [status, setStatus] = useState("Ready");
  const [isDraggingSource, setIsDraggingSource] = useState(false);
  const [isSourcePasteTargetActive, setIsSourcePasteTargetActive] = useState(false);
  const [isPanningCanvas, setIsPanningCanvas] = useState(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const previewDirection = hoveredDirection ?? direction;
  const extensionPercent = Math.round(extensionScale * 100);
  const effectiveOverflowScale = direction ? overflowScale : 0;
  const overflowPercent = Math.round(effectiveOverflowScale * 100);
  const activeOutputUrl =
    outputMode === "reaction"
      ? result?.reactionOnlyGifUrl ?? result?.reactionOnlyVideoUrl
      : result?.gifUrl ?? result?.videoUrl;
  const activePosterUrl =
    outputMode === "reaction"
      ? result?.reactionOnlyImageUrl
      : result?.posterImageUrl;
  const stageStyle = {
    "--source-aspect": sourceAspectRatio,
    "--extension-scale": extensionScale
  } as CSSProperties;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    canvas.scrollTop = (canvas.scrollHeight - canvas.clientHeight) / 2;
    setIsCanvasReady(true);
  }, [imagePreviewUrl]);

  useEffect(() => {
    function handleWindowPaste(event: globalThis.ClipboardEvent) {
      if (!isSourcePasteTargetActive || imagePreviewUrl) {
        return;
      }

      const pastedImage =
        Array.from(event.clipboardData?.items ?? []).find((clipboardItem) =>
          clipboardItem.type.startsWith("image/")
        )?.getAsFile() ?? null;

      if (!pastedImage) {
        return;
      }

      event.preventDefault();
      void loadSourceImage(pastedImage);
    }

    window.addEventListener("paste", handleWindowPaste);

    return () => {
      window.removeEventListener("paste", handleWindowPaste);
    };
  }, [imagePreviewUrl, isSourcePasteTargetActive]);

  async function loadSourceImage(nextFile: File | null) {
    if (!nextFile) {
      setImageFile(null);
      setImagePreviewUrl(null);
      setSourceAspectRatio("1 / 1");
      setSelectedFileLabel("Add image");
      setDirection(null);
      setHoveredDirection(null);
      return;
    }

    if (!nextFile.type.startsWith("image/") && !nextFile.type.startsWith("video/")) {
      setError("Drop or paste an image, GIF, or video file.");
      setStatus("Missing image");
      return;
    }

    setImageFile(nextFile);
    setSelectedFileLabel(nextFile.name || "Pasted image");
    setDirection(null);
    setHoveredDirection(null);
    setError(null);
    setResult(null);
    setDebugLog([]);
    setStatus("Ready");

    try {
      if (nextFile.type.startsWith("video/")) {
        setImagePreviewUrl(null);
        setSourceAspectRatio("1 / 1");
        return;
      }

      const previewUrl = await fileToDataUrl(nextFile);
      const imageSize = await readImageSize(previewUrl);
      setImagePreviewUrl(previewUrl);
      setSourceAspectRatio(`${imageSize.width} / ${imageSize.height}`);
    } catch {
      setImagePreviewUrl(null);
      setSourceAspectRatio("1 / 1");
      setError("Could not preview that image.");
      setStatus("Missing image");
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    await loadSourceImage(event.target.files?.[0] ?? null);
    event.target.value = "";
  }

  async function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const pastedImage = getPastedImage(event);

    if (!pastedImage) {
      return;
    }

    event.preventDefault();
    await loadSourceImage(pastedImage);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    const hasImage = Array.from(event.dataTransfer.items).some((item) =>
      item.type.startsWith("image/")
    );

    if (!hasImage) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingSource(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingSource(false);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    const droppedImage = getImageFile(event.dataTransfer.files);

    if (!droppedImage) {
      return;
    }

    event.preventDefault();
    setIsDraggingSource(false);
    await loadSourceImage(droppedImage);
  }

  function handleCanvasPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 1) {
      return;
    }

    event.preventDefault();
    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      nextScrollLeft: event.currentTarget.scrollLeft,
      nextScrollTop: event.currentTarget.scrollTop,
      animationFrame: null
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanningCanvas(true);
  }

  function handleCanvasPointerMove(event: PointerEvent<HTMLDivElement>) {
    const panState = panStateRef.current;

    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    panState.nextScrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
    panState.nextScrollTop = panState.scrollTop - (event.clientY - panState.startY);

    if (panState.animationFrame !== null) {
      return;
    }

    const canvas = event.currentTarget;
    panState.animationFrame = window.requestAnimationFrame(() => {
      const currentPanState = panStateRef.current;

      if (!currentPanState) {
        return;
      }

      canvas.scrollLeft = currentPanState.nextScrollLeft;
      canvas.scrollTop = currentPanState.nextScrollTop;
      currentPanState.animationFrame = null;
    });
  }

  function endCanvasPan(event: PointerEvent<HTMLDivElement>) {
    const panState = panStateRef.current;

    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (panState.animationFrame !== null) {
      window.cancelAnimationFrame(panState.animationFrame);
    }

    panStateRef.current = null;
    setIsPanningCanvas(false);
  }

  function handleCanvasAuxClick(event: PointerEvent<HTMLDivElement>) {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!imageFile) {
      setError("Add a source image first.");
      setStatus("Missing image");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setResult(null);
    setDebugLog([
      "Preparing multipart form submission.",
      `Selected file: ${imageFile.name}`,
      direction
        ? `Selected extension direction: ${direction}`
        : "No extension direction selected; backend will extend around the source.",
      `Generation mode: ${generationMode}`,
      `Remove generated background: ${removeGeneratedBackground ? "on" : "off"}`,
      `Selected video model: ${videoModel}`,
      `Generated area size: ${extensionPercent}%`,
      `Reaction overflow: ${overflowPercent}%`
    ]);
    setOutputMode("full");
    setStatus("Generating");

    try {
      const formData = new FormData();
      formData.set("prompt", prompt);
      formData.set("image", imageFile);
      if (direction) {
        formData.set("direction", direction);
      }
      formData.set("generationMode", generationMode);
      formData.set("removeGeneratedBackground", String(removeGeneratedBackground));
      formData.set("videoModel", videoModel);
      formData.set("extensionScale", String(extensionScale));
      formData.set("overflowScale", String(effectiveOverflowScale));

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData
      });

      const { data, bodyText } = await parseGenerateResponse(response);

      if (!response.ok) {
        if (data && "debugLog" in data && Array.isArray(data.debugLog)) {
          setDebugLog(data.debugLog);
        } else {
          setDebugLog([
            `HTTP ${response.status} ${response.statusText}`,
            bodyText
              ? `Non-JSON response body:\n${bodyText.slice(0, 4000)}`
              : "No response body returned from the server."
          ]);
        }

        throw new Error(
          data && "error" in data
            ? data.error
            : `Generation failed with HTTP ${response.status}.`
        );
      }

      if (!data) {
        setDebugLog([
          `HTTP ${response.status} ${response.statusText}`,
          bodyText
            ? `Non-JSON response body:\n${bodyText.slice(0, 4000)}`
            : "No response body returned from the server."
        ]);
        throw new Error("Generation returned an unreadable response.");
      }

      const successData = data as GenerateResponse;
      setResult(successData);
      setDebugLog(successData.debugLog);
      setStatus("Complete");
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : "Something went wrong while generating the GIF.";

      setError(message);
      setStatus("Failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="editor-shell" onPaste={handlePaste}>
      <header className="app-bar">
        <nav className="brand-row" aria-label="Primary">
          <strong>Reaction GIF</strong>
          <a href="#editor">Editor</a>
          <a href="#outputs">Outputs</a>
        </nav>
        <div className="status-pill" data-state={status.toLowerCase()}>
          {status}
        </div>
      </header>

      <section className="editor-panel" id="editor">
        <div className="editor-titlebar">
          <button className="icon-button" type="button" aria-label="Back">
            <Undo2 aria-hidden="true" />
          </button>
          <strong>Edit image</strong>
        </div>

        <form className="prompt-bar" onSubmit={handleSubmit}>
          <span className="mode-chip">Edit</span>
          <label className="model-select">
            <span>Mode</span>
            <select
              value={generationMode}
              onChange={(event) =>
                setGenerationMode(event.target.value as GenerationMode)
              }
              aria-label="Generation mode"
            >
              <option value="continuation">Continue source</option>
              <option value="keyframes">Keyframes</option>
            </select>
          </label>
          <label className="model-select">
            <span>Video model</span>
            <select
              value={videoModel}
              onChange={(event) => setVideoModel(event.target.value as VideoModelId)}
              aria-label="Video model"
            >
              {VIDEO_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle-chip">
            <input
              type="checkbox"
              checked={removeGeneratedBackground}
              onChange={(event) =>
                setRemoveGeneratedBackground(event.target.checked)
              }
            />
            <span>Remove generated background</span>
          </label>
          <input
            id="prompt"
            name="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the reaction motion..."
            required
          />
          <label className="file-chip" htmlFor="image" title={selectedFileLabel}>
            {selectedFileLabel}
          </label>
          <input
            id="image"
            name="image"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
            onChange={handleFileChange}
          />
          <button className="generate-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Generating" : "Generate"}
          </button>
        </form>

        <div
          ref={canvasRef}
          className={`canvas${isCanvasReady ? " is-ready" : ""}${
            isDraggingSource ? " is-dragging-source" : ""
          }${
            isPanningCanvas ? " is-panning" : ""
          }`}
          data-has-source={imagePreviewUrl ? "true" : "false"}
          tabIndex={0}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
          onAuxClick={handleCanvasAuxClick}
        >
          <div className="canvas-workspace">
            <div
              className={`generation-stage${direction ? ` stage-${direction}` : ""}`}
              style={stageStyle}
            >
              <div className="source-frame">
                {imagePreviewUrl ? (
                  <Image
                    src={imagePreviewUrl}
                    alt={selectedFileLabel}
                    width={512}
                    height={512}
                    unoptimized
                  />
                ) : (
                <label
                  className="source-placeholder"
                  htmlFor="image"
                  tabIndex={0}
                  onMouseEnter={() => setIsSourcePasteTargetActive(true)}
                  onMouseLeave={() => setIsSourcePasteTargetActive(false)}
                  onFocus={() => setIsSourcePasteTargetActive(true)}
                  onBlur={() => setIsSourcePasteTargetActive(false)}
                  onPaste={handlePaste}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      document.getElementById("image")?.click();
                    }
                  }}
                >
                  <span>
                    <ImagePlus aria-hidden="true" />
                  </span>
                  <strong>Drop, paste, or add source image</strong>
                </label>
              )}
            </div>
            {imagePreviewUrl ? (
              <div className="source-selection-hint">
                {direction ? `Extend ${direction}` : "Select a frame"}
              </div>
            ) : null}

            {imagePreviewUrl ? (
                <>
                  {direction ? (
                    <>
                      <div className="generation-frame-shell">
                        <div className="generation-frame" aria-hidden="true">
                          <div className="frame-label">Generation frame</div>
                          <div className="generation-fill" />
                          <div className="transparent-area" />
                        </div>
                      </div>
                      <div className="generation-slider-anchor">
                        <div className="frame-sliders" aria-label="Generation frame controls">
                          <label className="frame-slider">
                            <span>Size {extensionPercent}%</span>
                            <Slider
                              className="h-40"
                              aria-label="Generated area size"
                              orientation="vertical"
                              min={25}
                              max={100}
                              step={1}
                              value={[extensionPercent]}
                              onValueChange={([nextValue]) =>
                                setExtensionScale((nextValue ?? 100) / 100)
                              }
                            />
                          </label>
                          <label className="frame-slider">
                            <span>Crop +{overflowPercent}%</span>
                            <Slider
                              className="h-40"
                              aria-label="Reaction overflow"
                              orientation="vertical"
                              min={0}
                              max={50}
                              step={1}
                              value={[overflowPercent]}
                              onValueChange={([nextValue]) =>
                                setOverflowScale((nextValue ?? 0) / 100)
                              }
                            />
                          </label>
                        </div>
                      </div>
                    </>
                  ) : null}

                  <div className="direction-zones" aria-label="Generation frame placement">
                    {DIRECTION_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={`direction-zone zone-${option.value}${
                          direction === option.value ? " is-selected" : ""
                        }${
                          previewDirection === option.value ? " is-previewed" : ""
                        }`}
                        type="button"
                        aria-label={option.label}
                        title={option.label}
                        onClick={() => setDirection(option.value)}
                        onFocus={() => setHoveredDirection(option.value)}
                        onBlur={() => setHoveredDirection(null)}
                        onMouseEnter={() => setHoveredDirection(option.value)}
                        onMouseLeave={() => setHoveredDirection(null)}
                      >
                        <option.icon aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="tool-tray" aria-label="Canvas tools">
          <button className="tool-button is-active" type="button" aria-label="Select tool">
            <MousePointer2 aria-hidden="true" />
          </button>
          <button className="tool-button" type="button" aria-label="Pan tool">
            <Hand aria-hidden="true" />
          </button>
          <span className="tool-divider" />
          {DIRECTION_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`tool-button${direction === option.value ? " is-active" : ""}`}
              type="button"
              aria-label={option.label}
              title={option.label}
              disabled={!imagePreviewUrl}
              onClick={() => setDirection(option.value)}
            >
              <option.icon aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="zoom-tray" aria-label="Zoom controls">
          <button className="tool-button" type="button" aria-label="Zoom out">
            <ZoomOut aria-hidden="true" />
          </button>
          <button className="tool-button" type="button" aria-label="Zoom in">
            <ZoomIn aria-hidden="true" />
          </button>
        </div>

      </section>

      {error ? <p className="error-line">{error}</p> : null}

      {result ? (
        <section className="output-drawer" id="outputs">
          <article className="output-primary">
            <header>
              <strong>
                {outputMode === "reaction" ? "Reaction only" : "Full video"}
              </strong>
              <div className="output-actions">
                <button
                  className={outputMode === "full" ? "is-active" : ""}
                  type="button"
                  onClick={() => setOutputMode("full")}
                >
                  Full
                </button>
                <button
                  className={outputMode === "reaction" ? "is-active" : ""}
                  type="button"
                  onClick={() => setOutputMode("reaction")}
                >
                  Reaction
                </button>
                {activeOutputUrl ? (
                  <a href={activeOutputUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                ) : null}
              </div>
            </header>
            {activeOutputUrl?.endsWith(".gif") ? (
              <Image
                src={activeOutputUrl}
                alt={result.prompt}
                width={1280}
                height={720}
                unoptimized
              />
            ) : (
              <video controls playsInline src={activeOutputUrl} poster={activePosterUrl} />
            )}
          </article>

          <article className="output-card">
            <header>
              <strong>
                {result.reactionOnlyGifUrl
                  ? "Matted AI continuation"
                  : "Raw AI continuation"}
              </strong>
              <a
                href={result.reactionOnlyGifUrl ?? result.reactionOnlyVideoUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open
              </a>
            </header>
            {result.reactionOnlyGifUrl ? (
              <Image
                src={result.reactionOnlyGifUrl}
                alt={result.prompt}
                width={1280}
                height={720}
                unoptimized
              />
            ) : (
              <video
                controls
                playsInline
                src={result.reactionOnlyVideoUrl}
                poster={result.reactionOnlyImageUrl}
              />
            )}
          </article>

          <article className="output-card">
            <header>
              <strong>Before frame</strong>
              <a href={result.beforeFrameUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </header>
            <Image
              src={result.beforeFrameUrl}
              alt="Before frame sent to fal"
              width={1536}
              height={1024}
              unoptimized
            />
          </article>

          <article className="output-card">
            <header>
              <strong>After frame</strong>
              <a href={result.afterFrameUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </header>
            <Image
              src={result.afterFrameUrl}
              alt={result.prompt}
              width={1536}
              height={1024}
              unoptimized
            />
          </article>

          <article className="output-card">
            <header>
              <strong>Video</strong>
              <a href={result.videoUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </header>
            <video controls playsInline src={result.videoUrl} poster={result.posterImageUrl} />
          </article>
        </section>
      ) : null}

      {debugLog.length > 0 ? (
        <details className="debug-panel">
          <summary>
            Debug
            <span>{debugLog.length} entries</span>
          </summary>
          <pre>{debugLog.join("\n\n")}</pre>
        </details>
      ) : null}
    </main>
  );
}
