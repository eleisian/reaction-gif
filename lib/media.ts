import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import type { MotionDirection } from "@/lib/fal-video";

const execFileAsync = promisify(execFile);
const LOCAL_FFMPEG_COMMAND = path.join(
  process.cwd(),
  "node_modules",
  "ffmpeg-static",
  "ffmpeg.exe"
);
const FFMPEG_COMMAND =
  process.env.FFMPEG_PATH ??
  (existsSync(LOCAL_FFMPEG_COMMAND) ? LOCAL_FFMPEG_COMMAND : ffmpegStaticPath) ??
  "ffmpeg";

export const OUTPUT_DIR = path.join(process.cwd(), "public", "outputs");
export type DebugLogger = (message: string) => void;
export type ImageDimensions = {
  width: number;
  height: number;
};
export type CropBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function getFfmpegCommand() {
  return FFMPEG_COMMAND;
}

function getPythonCommand() {
  const localVenvPython = path.join(
    process.cwd(),
    ".venv",
    "Scripts",
    "python.exe"
  );
  const bundledPython = path.join(
    process.env.USERPROFILE ?? "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );

  return (
    process.env.PYTHON_PATH ??
    (existsSync(localVenvPython)
      ? localVenvPython
      : existsSync(bundledPython)
        ? bundledPython
        : "python")
  );
}

export async function ensureOutputDirectory() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

function formatCommand(command: string, args: string[]) {
  return `${command} ${args.join(" ")}`;
}

function getProcessErrorCode(error: Error & { code?: unknown }) {
  return typeof error.code === "string" || typeof error.code === "number"
    ? error.code
    : null;
}

async function runCommand(
  command: string,
  args: string[],
  logger?: DebugLogger
) {
  const formattedCommand = formatCommand(command, args);
  logger?.(`$ ${formattedCommand}`);

  try {
    const result = await execFileAsync(command, args);

    if (result.stdout?.trim()) {
      logger?.(`stdout:\n${result.stdout.trim()}`);
    }

    if (result.stderr?.trim()) {
      logger?.(`stderr:\n${result.stderr.trim()}`);
    }

    return result;
  } catch (error) {
    const commandError = error as Error & {
      stdout?: string;
      stderr?: string;
    };

    if (commandError.stdout?.trim()) {
      logger?.(`stdout:\n${commandError.stdout.trim()}`);
    }

    if (commandError.stderr?.trim()) {
      logger?.(`stderr:\n${commandError.stderr.trim()}`);
    }

    const code = getProcessErrorCode(commandError);

    if (code === "ENOENT") {
      throw new Error(
        "ffmpeg was not found. Install ffmpeg-static or add ffmpeg to PATH to process GIF/video frames locally."
      );
    }

    const stderr = commandError.stderr?.trim();
    const stdout = commandError.stdout?.trim();
    const details = [
      `Command failed: ${formattedCommand}`,
      code ? `Exit code: ${code}` : null,
      stderr ? `stderr: ${stderr}` : null,
      stdout ? `stdout: ${stdout}` : null
    ].filter(Boolean);

    throw new Error(details.join("\n"));
  }
}

async function ensureParentDirectory(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
}

export function isMissingFfmpegError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("ffmpeg was not found")
  );
}

export function extensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return "bin";
  }
}

export async function writeBufferAsset(
  fileName: string,
  buffer: Buffer | Uint8Array | ArrayBuffer
) {
  await ensureOutputDirectory();

  const assetPath = path.join(OUTPUT_DIR, fileName);
  const normalizedBuffer =
    buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(buffer);

  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, normalizedBuffer);

  return {
    path: assetPath,
    url: `/outputs/${fileName}`
  };
}

export async function extractStillFrame(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function extractLastFrame(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "reverse",
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function resizeImageToMatch(
  inputPath: string,
  referencePath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  const reference = await getImageDimensions(referencePath);

  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `scale=${reference.width}:${reference.height}:flags=neighbor`,
    "-frames:v",
    "1",
    outputPath
  ], logger);

  return reference;
}

export async function resizeImageForModelInput(
  inputPath: string,
  outputPath: string,
  minSize: number,
  logger?: DebugLogger
) {
  const source = await getImageDimensions(inputPath);

  if (source.width >= minSize && source.height >= minSize) {
    return {
      path: inputPath,
      dimensions: source,
      resized: false
    };
  }

  const scale = Math.max(minSize / source.width, minSize / source.height);
  const evenDimension = (value: number) => Math.ceil(value / 2) * 2;
  const width = evenDimension(source.width * scale);
  const height = evenDimension(source.height * scale);

  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `scale=${width}:${height}:flags=lanczos`,
    "-frames:v",
    "1",
    outputPath
  ], logger);

  return {
    path: outputPath,
    dimensions: { width, height },
    resized: true
  };
}

export async function createReferenceVideoForModel(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "fps=12,scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath
  ], logger);
}

export async function normalizeSourceFrame(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=768:512:force_original_aspect_ratio=decrease,pad=768:512:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    outputPath
  ], logger);
}

export async function copyAsset(
  inputPath: string,
  fileName: string
) {
  await ensureOutputDirectory();

  const assetPath = path.join(OUTPUT_DIR, fileName);
  await mkdir(path.dirname(assetPath), { recursive: true });
  await copyFile(inputPath, assetPath);

  return {
    path: assetPath,
    url: `/outputs/${fileName.replaceAll("\\", "/")}`
  };
}

export async function convertMp4ToGif(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=new=1",
    outputPath
  ], logger);
}

function fitForConcat(label: string, transparentBackground = false) {
  const format = transparentBackground ? "format=rgba," : "";
  const padColor = transparentBackground ? "black@0" : "black";
  return `[${label}:v]fps=12,${format}scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1`;
}

function paletteForGif(transparentBackground = false) {
  const palettegen = transparentBackground
    ? "palettegen=stats_mode=single:reserve_transparent=1:transparency_color=ffffff"
    : "palettegen=stats_mode=single";
  const paletteuse = transparentBackground
    ? "paletteuse=new=1:alpha_threshold=128"
    : "paletteuse=new=1";

  return `split[s0][s1];[s0]${palettegen}[p];[s1][p]${paletteuse}`;
}

export async function createContinuationVideo(
  sourcePath: string,
  sourceIsAnimated: boolean,
  generatedVideoPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  const sourceArgs = sourceIsAnimated
    ? ["-i", sourcePath]
    : ["-loop", "1", "-t", "0.8", "-i", sourcePath];

  await runCommand(FFMPEG_COMMAND, [
    "-y",
    ...sourceArgs,
    "-i",
    generatedVideoPath,
    "-filter_complex",
    `${fitForConcat("0")}[src];${fitForConcat("1")}[gen];[src][gen]concat=n=2:v=1:a=0[out]`,
    "-map",
    "[out]",
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath
  ], logger);
}

export async function createContinuationGif(
  sourcePath: string,
  sourceIsAnimated: boolean,
  generatedVideoPath: string,
  outputPath: string,
  logger?: DebugLogger,
  options: { transparentBackground?: boolean } = {}
) {
  await ensureParentDirectory(outputPath);
  const sourceArgs = sourceIsAnimated
    ? ["-i", sourcePath]
    : ["-loop", "1", "-t", "0.8", "-i", sourcePath];
  const transparentBackground = Boolean(options.transparentBackground);

  await runCommand(FFMPEG_COMMAND, [
    "-y",
    ...sourceArgs,
    "-i",
    generatedVideoPath,
    "-filter_complex",
    `${fitForConcat("0", transparentBackground)}[src];${fitForConcat("1", transparentBackground)}[gen];[src][gen]concat=n=2:v=1:a=0,${paletteForGif(transparentBackground)}`,
    outputPath
  ], logger);
}

export async function compositeChromaReaction(
  sourcePath: string,
  generatedVideoPath: string,
  outputVideoPath: string,
  outputGifPath: string | null,
  logger?: DebugLogger
) {
  const scriptPath = path.join(
    process.cwd(),
    "workers",
    "composite_reaction.py"
  );
  const args = [
    scriptPath,
    "--ffmpeg",
    FFMPEG_COMMAND,
    "--source",
    sourcePath,
    "--generated",
    generatedVideoPath,
    "--output-video",
    outputVideoPath,
    "--mode",
    "chroma"
  ];

  if (outputGifPath) {
    args.push("--output-gif", outputGifPath);
  }

  await runCommand(getPythonCommand(), args, logger);
}

export async function createMattedTransparentGif(
  inputVideoPath: string,
  outputGifPath: string,
  logger?: DebugLogger
) {
  const scriptPath = path.join(
    process.cwd(),
    "workers",
    "matte_remove_background.py"
  );

  await runCommand(getPythonCommand(), [
    scriptPath,
    "--ffmpeg",
    FFMPEG_COMMAND,
    "--input",
    inputVideoPath,
    "--output-gif",
    outputGifPath
  ], logger);
}

export async function downloadUrlToFile(
  url: string,
  outputPath: string,
  logger?: DebugLogger
) {
  logger?.(`Downloading generated video from ${url}`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download generated video: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(arrayBuffer));
}

export async function readFileToNodeFile(
  inputPath: string,
  fileName: string,
  mimeType: string
) {
  const buffer = await readFile(inputPath);
  return new File([buffer], fileName, { type: mimeType });
}

export async function hasTransparentBackground(inputPath: string) {
  const buffer = await readFile(inputPath);

  if (
    buffer.length >= 26 &&
    buffer.toString("ascii", 1, 4) === "PNG"
  ) {
    const colorType = buffer[25];
    return colorType === 4 || colorType === 6;
  }

  if (buffer.length >= 13 && buffer.toString("ascii", 0, 3) === "GIF") {
    for (let index = 0; index < buffer.length - 7; index += 1) {
      const isGraphicControlExtension =
        buffer[index] === 0x21 &&
        buffer[index + 1] === 0xf9 &&
        buffer[index + 2] === 0x04;

      if (isGraphicControlExtension && (buffer[index + 3] & 0x01) === 0x01) {
        return true;
      }
    }
  }

  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    buffer.toString("ascii", 12, 16) === "VP8X"
  ) {
    return (buffer[20] & 0x10) === 0x10;
  }

  return false;
}

function readPngDimensions(buffer: Buffer) {
  if (
    buffer.length >= 24 &&
    buffer.toString("ascii", 1, 4) === "PNG"
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  return null;
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);

    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readWebpDimensions(buffer: Buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  const chunkType = buffer.toString("ascii", 12, 16);

  if (chunkType === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }

  if (chunkType === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  if (chunkType === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  return null;
}

export async function getImageDimensions(inputPath: string) {
  const buffer = await readFile(inputPath);
  const dimensions =
    readPngDimensions(buffer) ??
    readJpegDimensions(buffer) ??
    readWebpDimensions(buffer);

  if (!dimensions) {
    throw new Error("Could not read source image dimensions.");
  }

  return dimensions satisfies ImageDimensions;
}

export function getOutpaintCanvasLayout(
  source: ImageDimensions,
  direction: MotionDirection,
  extensionScale = 1
) {
  const roundUpToMultiple = (value: number, multiple: number) =>
    Math.ceil(value / multiple) * multiple;
  const scale = Math.max(0.25, Math.min(extensionScale, 1));
  const autoMargin = {
    width: roundUpToMultiple(source.width * scale * 0.5, 16),
    height: roundUpToMultiple(source.height * scale * 0.5, 16)
  };

  if (direction === "auto") {
    const canvas = {
      width: roundUpToMultiple(source.width + autoMargin.width * 2, 16),
      height: roundUpToMultiple(source.height + autoMargin.height * 2, 16)
    };
    const sourceOffset = {
      x: Math.round((canvas.width - source.width) / 2),
      y: Math.round((canvas.height - source.height) / 2)
    };
    const maskBox = {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height
    } satisfies CropBox;
    const maskBoxes = [
      {
        x: 0,
        y: 0,
        width: canvas.width,
        height: sourceOffset.y
      },
      {
        x: 0,
        y: sourceOffset.y + source.height,
        width: canvas.width,
        height: canvas.height - sourceOffset.y - source.height
      },
      {
        x: 0,
        y: sourceOffset.y,
        width: sourceOffset.x,
        height: source.height
      },
      {
        x: sourceOffset.x + source.width,
        y: sourceOffset.y,
        width: canvas.width - sourceOffset.x - source.width,
        height: source.height
      }
    ].filter((box) => box.width > 0 && box.height > 0) satisfies CropBox[];

    return { canvas, sourceOffset, maskBox, maskBoxes };
  }

  const extendsHorizontally = direction === "left" || direction === "right";
  const extension = {
    width: roundUpToMultiple(
      extendsHorizontally ? source.width * scale : source.width,
      16
    ),
    height: roundUpToMultiple(
      extendsHorizontally ? source.height : source.height * scale,
      16
    )
  };
  const idealCanvas = {
    width: extendsHorizontally ? source.width + extension.width : source.width,
    height: extendsHorizontally ? source.height : source.height + extension.height
  };
  const canvas = {
    width: roundUpToMultiple(idealCanvas.width, 16),
    height: roundUpToMultiple(idealCanvas.height, 16)
  };
  const sourceOffset = {
    x: direction === "left" ? canvas.width - source.width : 0,
    y: direction === "up" ? canvas.height - source.height : 0
  };
  const maskBox = {
    x: direction === "right" ? source.width : 0,
    y: direction === "down" ? source.height : 0,
    width: extendsHorizontally ? canvas.width - source.width : canvas.width,
    height: extendsHorizontally ? canvas.height : canvas.height - source.height
  } satisfies CropBox;

  return { canvas, sourceOffset, maskBox, maskBoxes: [maskBox] };
}

export function getReactionCropBox(
  source: ImageDimensions,
  direction: MotionDirection,
  extensionScale = 1,
  overflowScale = 0
) {
  const { canvas, sourceOffset, maskBox } = getOutpaintCanvasLayout(
    source,
    direction,
    extensionScale
  );

  if (direction === "auto") {
    return {
      cropBox: { x: 0, y: 0, width: canvas.width, height: canvas.height },
      canvas,
      sourceOffset,
      sourceOverflow: 0
    };
  }

  const extendsHorizontally = direction === "left" || direction === "right";
  const sourceOverflow = Math.round(
    (extendsHorizontally ? source.width : source.height) *
      Math.max(0, Math.min(overflowScale, 0.5))
  );

  const cropBox = { ...maskBox };

  if (direction === "left") {
    cropBox.width += sourceOverflow;
  }

  if (direction === "right") {
    cropBox.x = Math.max(0, cropBox.x - sourceOverflow);
    cropBox.width += sourceOverflow;
  }

  if (direction === "up") {
    cropBox.height += sourceOverflow;
  }

  if (direction === "down") {
    cropBox.y = Math.max(0, cropBox.y - sourceOverflow);
    cropBox.height += sourceOverflow;
  }

  cropBox.x = Math.max(0, Math.min(cropBox.x, canvas.width - 1));
  cropBox.y = Math.max(0, Math.min(cropBox.y, canvas.height - 1));
  cropBox.width = Math.min(cropBox.width, canvas.width - cropBox.x);
  cropBox.height = Math.min(cropBox.height, canvas.height - cropBox.y);

  return { cropBox, canvas, sourceOffset, sourceOverflow };
}

export function scaleCropBox(
  cropBox: CropBox,
  sourceCanvas: ImageDimensions,
  targetCanvas: ImageDimensions
) {
  const xRatio = targetCanvas.width / sourceCanvas.width;
  const yRatio = targetCanvas.height / sourceCanvas.height;
  const scaled = {
    x: Math.round(cropBox.x * xRatio),
    y: Math.round(cropBox.y * yRatio),
    width: Math.round(cropBox.width * xRatio),
    height: Math.round(cropBox.height * yRatio)
  };

  scaled.x = Math.max(0, Math.min(scaled.x, targetCanvas.width - 1));
  scaled.y = Math.max(0, Math.min(scaled.y, targetCanvas.height - 1));
  scaled.width = Math.max(1, Math.min(scaled.width, targetCanvas.width - scaled.x));
  scaled.height = Math.max(1, Math.min(scaled.height, targetCanvas.height - scaled.y));

  return scaled satisfies CropBox;
}

export async function createOutpaintEditInput(
  sourcePath: string,
  expandedCanvasPath: string,
  maskPath: string,
  direction: MotionDirection,
  extensionScale = 1,
  logger?: DebugLogger
) {
  const source = await getImageDimensions(sourcePath);
  const { canvas, sourceOffset, maskBox, maskBoxes } = getOutpaintCanvasLayout(
    source,
    direction,
    extensionScale
  );

  logger?.(
    `GPT Image 2 edit layout: source=${source.width}x${source.height}; canvas=${canvas.width}x${canvas.height}; extensionScale=${extensionScale}; sourceOffset=${sourceOffset.x},${sourceOffset.y}; maskBox=${maskBox.x},${maskBox.y},${maskBox.width},${maskBox.height}`
  );

  await ensureParentDirectory(expandedCanvasPath);
  await ensureParentDirectory(maskPath);

  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    sourcePath,
    "-vf",
    `pad=${canvas.width}:${canvas.height}:${sourceOffset.x}:${sourceOffset.y}:color=white`,
    "-frames:v",
    "1",
    expandedCanvasPath
  ], logger);

  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=black:s=${canvas.width}x${canvas.height}`,
    "-vf",
    maskBoxes
      .map(
        (box) =>
          `drawbox=x=${box.x}:y=${box.y}:w=${box.width}:h=${box.height}:color=white:t=fill`
      )
      .join(","),
    "-frames:v",
    "1",
    maskPath
  ], logger);

  return { source, canvas, sourceOffset, maskBox };
}

export async function cropImageRegion(
  inputPath: string,
  outputPath: string,
  cropBox: CropBox,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `crop=${cropBox.width}:${cropBox.height}:${cropBox.x}:${cropBox.y}`,
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function cropVideoRegion(
  inputPath: string,
  outputPath: string,
  cropBox: CropBox,
  sourceCanvas: ImageDimensions,
  logger?: DebugLogger
) {
  const xRatio = cropBox.x / sourceCanvas.width;
  const yRatio = cropBox.y / sourceCanvas.height;
  const widthRatio = cropBox.width / sourceCanvas.width;
  const heightRatio = cropBox.height / sourceCanvas.height;

  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `crop=trunc(iw*${widthRatio}/2)*2:trunc(ih*${heightRatio}/2)*2:trunc(iw*${xRatio}/2)*2:trunc(ih*${yRatio}/2)*2`,
    "-an",
    outputPath
  ], logger);
}

export async function createPosterFrameFromVideo(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await ensureParentDirectory(outputPath);
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function createReactionGif(
  startFramePath: string,
  videoPath: string,
  endFramePath: string,
  outputPath: string,
  logger?: DebugLogger,
  options: { transparentBackground?: boolean } = {}
) {
  await ensureParentDirectory(outputPath);
  const format = options.transparentBackground ? "format=rgba," : "";
  const palette = paletteForGif(Boolean(options.transparentBackground));
  await runCommand(FFMPEG_COMMAND, [
    "-y",
    "-loop",
    "1",
    "-t",
    "0.6",
    "-i",
    startFramePath,
    "-i",
    videoPath,
    "-loop",
    "1",
    "-t",
    "0.6",
    "-i",
    endFramePath,
    "-filter_complex",
    `[0:v]${format}scale=768:512:flags=lanczos,setsar=1,fps=12[start];[1:v]${format}scale=768:512:flags=lanczos,setsar=1,fps=12[generated];[2:v]${format}scale=768:512:flags=lanczos,setsar=1,fps=12[end];[start][generated][end]concat=n=3:v=1:a=0,${palette}`,
    outputPath
  ], logger);
}
