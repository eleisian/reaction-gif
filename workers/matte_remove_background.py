import argparse
import os
import subprocess
import sys


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    print("$ " + " ".join(command), flush=True)
    process = subprocess.run(command, text=True, capture_output=True)

    if process.stdout.strip():
        print(process.stdout.strip(), flush=True)

    if process.stderr.strip():
        print(process.stderr.strip(), file=sys.stderr, flush=True)

    if process.returncode != 0:
        raise SystemExit(process.returncode)

    return process


def run_binary(command: list[str]) -> bytes:
    print("$ " + " ".join(command), flush=True)
    process = subprocess.run(command, capture_output=True)

    if process.stderr.strip():
        print(process.stderr.decode(errors="replace").strip(), file=sys.stderr, flush=True)

    if process.returncode != 0:
        raise SystemExit(process.returncode)

    return process.stdout


def median(values: list[int]) -> int:
    values.sort()
    return values[len(values) // 2]


def sample_background_color(pixels: bytes, width: int, height: int, sample_px: int) -> str:
    sample = max(1, min(sample_px, width // 2, height // 2))
    channels = [[], [], []]

    def add_pixel(x: int, y: int) -> None:
        offset = (y * width + x) * 3
        channels[0].append(pixels[offset])
        channels[1].append(pixels[offset + 1])
        channels[2].append(pixels[offset + 2])

    for y in range(sample):
        for x in range(sample):
            add_pixel(x, y)
            add_pixel(width - 1 - x, y)
            add_pixel(x, height - 1 - y)
            add_pixel(width - 1 - x, height - 1 - y)

    red = median(channels[0])
    green = median(channels[1])
    blue = median(channels[2])
    return f"0x{red:02x}{green:02x}{blue:02x}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove a flat generated-video background and export an alpha GIF."
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-gif", required=True)
    parser.add_argument("--key-color")
    parser.add_argument("--similarity", default="0.18")
    parser.add_argument("--blend", default="0.04")
    parser.add_argument("--size", type=int, default=720)
    parser.add_argument("--sample-px", type=int, default=16)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output_gif), exist_ok=True)

    sample_frame = run_binary(
        [
            args.ffmpeg,
            "-v",
            "error",
            "-i",
            args.input,
            "-frames:v",
            "1",
            "-vf",
            f"scale={args.size}:{args.size}:force_original_aspect_ratio=decrease,pad={args.size}:{args.size}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    key_color = args.key_color or sample_background_color(
        sample_frame,
        args.size,
        args.size,
        args.sample_px,
    )
    print(f"Auto matte key color: {key_color}", flush=True)

    matte_filter = (
        f"fps=12,scale={args.size}:{args.size}:force_original_aspect_ratio=decrease,"
        f"pad={args.size}:{args.size}:(ow-iw)/2:(oh-ih)/2:color={key_color},"
        f"setsar=1,colorkey={key_color}:{args.similarity}:{args.blend},format=rgba,"
        "split[s0][s1];"
        "[s0]palettegen=stats_mode=single:reserve_transparent=1:transparency_color=ffffff[p];"
        "[s1][p]paletteuse=new=1:alpha_threshold=128"
    )

    run(
        [
            args.ffmpeg,
            "-y",
            "-i",
            args.input,
            "-filter_complex",
            matte_filter,
            args.output_gif,
        ]
    )


if __name__ == "__main__":
    main()
