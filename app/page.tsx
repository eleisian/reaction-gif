"use client";

import Image from "next/image";
import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useState
} from "react";

type MotionDirection = "up" | "right" | "down" | "left";

type GenerateResponse = {
  jobId: string;
  prompt: string;
  direction: MotionDirection;
  model: string;
  requestId: string;
  inputFileName: string;
  inputMimeType: string;
  uploadedAssetUrl: string;
  sourceImageUrl: string;
  videoUrl: string;
  posterImageUrl: string;
  gifUrl: string;
  debugLog: string[];
};

type ErrorResponse = {
  error: string;
  debugLog?: string[];
};

type DirectionCell =
  | { id: string; kind: "empty" }
  | { id: string; kind: "center"; label: string }
  | {
      id: string;
      kind: "direction";
      label: string;
      direction: MotionDirection;
    };

const DIRECTION_CELLS: DirectionCell[] = [
  { id: "top-left", kind: "empty" },
  { id: "up", kind: "direction", label: "Up", direction: "up" },
  { id: "top-right", kind: "empty" },
  { id: "left", kind: "direction", label: "Left", direction: "left" },
  { id: "center", kind: "center", label: "Source" },
  { id: "right", kind: "direction", label: "Right", direction: "right" },
  { id: "bottom-left", kind: "empty" },
  { id: "down", kind: "direction", label: "Down", direction: "down" },
  { id: "bottom-right", kind: "empty" }
];

const DEFAULT_PROMPT =
  "The subject gives a quick skeptical side-eye, then a tiny dramatic head tilt, with subtle natural motion and a meme-ready reaction beat.";

export default function HomePage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [direction, setDirection] = useState<MotionDirection>("right");
  const [selectedFileLabel, setSelectedFileLabel] = useState("No file selected yet.");
  const [status, setStatus] = useState("Ready to render.");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  useEffect(() => {
    if (!imageFile) {
      setImagePreviewUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(imageFile);
    setImagePreviewUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [imageFile]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    setImageFile(nextFile);
    setSelectedFileLabel(nextFile ? nextFile.name : "No file selected yet.");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!imageFile) {
      setError("Choose an image or GIF before generating.");
      setStatus("The render failed.");
      setDebugLog(["No input file was selected in the browser."]);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setResult(null);
    setDebugLog([
      "Preparing multipart form submission.",
      `Selected file: ${imageFile.name} (${imageFile.type || "unknown type"})`,
      `Selected motion tile: ${direction}`
    ]);
    setStatus("Uploading the source image and generating a short video with fal.");

    try {
      const formData = new FormData();
      formData.set("prompt", prompt);
      formData.set("image", imageFile);
      formData.set("direction", direction);

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData
      });

      const data = (await response.json()) as GenerateResponse | ErrorResponse;

      if (!response.ok) {
        setDebugLog(
          "debugLog" in data && Array.isArray(data.debugLog)
            ? data.debugLog
            : ["No debug log returned from the server."]
        );
        throw new Error("error" in data ? data.error : "Generation failed.");
      }

      const successData = data as GenerateResponse;
      setResult(successData);
      setDebugLog(successData.debugLog);
      setStatus("Video generated. GIF is ready.");
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : "Something went wrong while generating the GIF.";

      setError(message);
      setStatus("The render failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Proof Of Concept</p>
          <h1>Reaction GIF Lab</h1>
        </div>
        <p>
          Upload an image or GIF, generate a short image-to-video reaction clip with
          <code> fal-ai/ltx-video/image-to-video </code>, then convert the MP4 into a
          looping GIF locally with <code>ffmpeg</code>.
        </p>
      </section>

      <section className="layout">
        <div className="panel controls">
          <h2>Create a reaction clip</h2>
          <p>
            Start from a still image, or from the first frame of an uploaded GIF. Then
            pick the grid tile where the reaction should expand, then describe the
            motion beat you want the model to animate from that image.
          </p>

          <form className="form" onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="image">Source image or GIF</label>
              <input
                id="image"
                name="image"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleFileChange}
                required
              />
              <span className="hint">
                {selectedFileLabel} Supported: PNG, JPG, WEBP, GIF. We normalize to a
                768 x 512 source frame for the current LTX endpoint.
              </span>
            </div>

            <div className="field">
              <label>Reaction grid</label>
              <div className="extend-grid" role="radiogroup" aria-label="Reaction direction">
                {DIRECTION_CELLS.map((cell) => {
                  if (cell.kind === "center") {
                    return (
                      <div key={cell.id} className="grid-cell grid-cell-center">
                        {imagePreviewUrl ? (
                          <Image
                            src={imagePreviewUrl}
                            alt="Uploaded preview"
                            width={240}
                            height={160}
                            unoptimized
                          />
                        ) : (
                          <div className="grid-placeholder">
                            <strong>Source</strong>
                            <span>Upload an image to preview it here</span>
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (cell.kind === "empty") {
                    return <div key={cell.id} className="grid-cell grid-cell-empty" />;
                  }

                  const isActive = direction === cell.direction;

                  return (
                    <button
                      key={cell.id}
                      type="button"
                      className={`grid-cell grid-cell-selectable${isActive ? " is-active" : ""}`}
                      onClick={() => setDirection(cell.direction)}
                      aria-pressed={isActive}
                    >
                      <span>{cell.label}</span>
                    </button>
                  );
                })}
              </div>
              <span className="hint">
                The selected tile nudges the model to animate the reaction toward that
                side, similar to a lightweight extend-image composition control.
              </span>
            </div>

            <div className="field">
              <label htmlFor="prompt">Motion prompt</label>
              <textarea
                id="prompt"
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the motion beat you want."
                required
              />
              <span className="hint">
                Tip: focus on small readable motion like blink, side-eye, smug nod,
                recoil, or dramatic glance at camera.
              </span>
            </div>

            <button className="submit" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Generating..." : "Generate video and GIF"}
            </button>
          </form>

          <p className="footer-note">
            This version generates a short hosted MP4 with fal, then builds a GIF
            locally and writes both files to{" "}
            <code>public/outputs</code>.
          </p>
        </div>

        <div className="panel preview">
          <h2>Preview</h2>
          <p>Once the render completes, you’ll get the normalized source frame, the generated MP4, and the looped GIF.</p>

          <div className="status">
            <strong>{status}</strong>
            <span>
              {error
                ? error
                : "fal handles the hosted image-to-video generation; ffmpeg handles the local GIF export."}
            </span>
          </div>

          {result ? (
            <div className="result-grid">
              <article className="media-card">
                <header>
                  <strong>Source Frame</strong>
                  <span>{result.direction}</span>
                </header>
                <Image
                  src={result.sourceImageUrl}
                  alt={result.inputFileName}
                  width={1024}
                  height={1024}
                  unoptimized
                />
                <div className="media-actions">
                  <a href={result.sourceImageUrl} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                </div>
              </article>

              <article className="media-card">
                <header>
                  <strong>Generated MP4</strong>
                  <span>{result.model}</span>
                </header>
                <video controls playsInline src={result.videoUrl} poster={result.posterImageUrl} />
                <div className="media-actions">
                  <a href={result.videoUrl} target="_blank" rel="noreferrer">
                    Open video
                  </a>
                </div>
              </article>

              <article className="media-card">
                <header>
                  <strong>Reaction GIF</strong>
                  <span>Looped locally</span>
                </header>
                <Image
                  src={result.gifUrl}
                  alt={result.prompt}
                  width={1280}
                  height={720}
                  unoptimized
                />
                <div className="media-actions">
                  <a href={result.gifUrl} target="_blank" rel="noreferrer">
                    Open GIF
                  </a>
                </div>
              </article>
            </div>
          ) : (
            <div className="empty-state">
              <div>
                <h3>Nothing rendered yet</h3>
                <p>
                  Start with a portrait, pet photo, screenshot, or meme template, then
                  ask for a short reaction motion like side-eye, confusion, smug approval,
                  or a dramatic blink at camera.
                </p>
              </div>
            </div>
          )}

          <div className="debug-console">
            <div className="debug-header">
              <strong>Debug Console</strong>
              <span>{debugLog.length} entries</span>
            </div>
            <pre className="debug-output">
              {debugLog.length > 0
                ? debugLog.join("\n\n")
                : "No debug output yet. Submit a render to see the full backend trace."}
            </pre>
          </div>
        </div>
      </section>
    </main>
  );
}
