import argparse
import os
import subprocess
import sys


def run(command: list[str]) -> None:
    print("$ " + " ".join(command), flush=True)
    process = subprocess.run(command, text=True, capture_output=True)

    if process.stdout.strip():
        print(process.stdout.strip(), flush=True)

    if process.stderr.strip():
        print(process.stderr.strip(), file=sys.stderr, flush=True)

    if process.returncode != 0:
        raise SystemExit(process.returncode)


def fit(label: str, size: int, pad_color: str) -> str:
    return (
        f"[{label}:v]fps=12,"
        f"scale={size}:{size}:force_original_aspect_ratio=decrease,"
        f"pad={size}:{size}:(ow-iw)/2:(oh-ih)/2:color={pad_color},"
        "setsar=1"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Composite original source motion over generated reaction video."
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--source", required=True)
    parser.add_argument("--generated", required=True)
    parser.add_argument("--output-video", required=True)
    parser.add_argument("--output-gif")
    parser.add_argument("--mode", choices=["chroma"], default="chroma")
    parser.add_argument("--key-color", default="0x00ff00")
    parser.add_argument("--similarity", default="0.22")
    parser.add_argument("--blend", default="0.06")
    parser.add_argument("--size", type=int, default=720)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output_video), exist_ok=True)

    source_fit = fit("0", args.size, args.key_color)
    generated_fit = fit("1", args.size, "black")
    alpha_filter = (
        f"{source_fit},"
        f"chromakey={args.key_color}:{args.similarity}:{args.blend},"
        "format=rgba[fg];"
        f"{generated_fit}[bg];"
        "[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[out]"
    )

    run(
        [
            args.ffmpeg,
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            args.source,
            "-i",
            args.generated,
            "-filter_complex",
            alpha_filter,
            "-map",
            "[out]",
            "-an",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            args.output_video,
        ]
    )

    if args.output_gif:
      os.makedirs(os.path.dirname(args.output_gif), exist_ok=True)
      gif_filter = (
          f"{source_fit},"
          f"chromakey={args.key_color}:{args.similarity}:{args.blend},"
          "format=rgba[fg];"
          f"{generated_fit}[bg];"
          "[bg][fg]overlay=shortest=1:format=auto,"
          "split[s0][s1];[s0]palettegen=stats_mode=single[p];"
          "[s1][p]paletteuse=new=1"
      )

      run(
          [
              args.ffmpeg,
              "-y",
              "-stream_loop",
              "-1",
              "-i",
              args.source,
              "-i",
              args.generated,
              "-filter_complex",
              gif_filter,
              args.output_gif,
          ]
      )


if __name__ == "__main__":
    main()
