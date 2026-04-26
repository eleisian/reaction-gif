import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OUTPUT_DIR = path.join(process.cwd(), "public", "outputs");
export type DebugLogger = (message: string) => void;

export async function ensureOutputDirectory() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

function formatCommand(command: string, args: string[]) {
  return `${command} ${args.join(" ")}`;
}

async function runCommand(
  command: string,
  args: string[],
  logger?: DebugLogger
) {
  logger?.(`$ ${formatCommand(command, args)}`);

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

    throw error;
  }
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
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function normalizeSourceFrame(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await runCommand("ffmpeg", [
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

export async function convertMp4ToGif(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "fps=12,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=new=1",
    outputPath
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

export async function createPosterFrameFromVideo(
  inputPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    outputPath
  ], logger);
}

export async function createReactionGif(
  sourceFramePath: string,
  videoPath: string,
  outputPath: string,
  logger?: DebugLogger
) {
  await runCommand("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-t",
    "0.6",
    "-i",
    sourceFramePath,
    "-i",
    videoPath,
    "-filter_complex",
    "[0:v]scale=768:512:flags=lanczos,setsar=1,fps=12,split=2[source_a][source_b];[1:v]scale=768:512:flags=lanczos,setsar=1,fps=12[generated];[source_a][generated][source_b]concat=n=3:v=1:a=0,split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=new=1",
    outputPath
  ], logger);
}
