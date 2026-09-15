#!/usr/bin/env python3
"""Generate small, silent, synthetic audio metadata fixtures.

The script requires an ffmpeg binary supplied by FIXTURE_FFMPEG.  It never
reads music from the network and writes only beneath src-tauri/tests/data.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.id3 import ID3, TCON, TDAT, TDRC, TIME, TIT2, TORY, TPE1
from mutagen.mp4 import MP4
from mutagen.oggvorbis import OggVorbis


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "tests" / "fixtures" / "metadata"
FFMPEG = os.environ["FIXTURE_FFMPEG"]


def encode(name: str, codec: str, extra: list[str] | None = None) -> Path:
    path = OUT / name
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "anullsrc=r=8000:cl=mono", "-t", "0.08", "-c:a", codec,
    ]
    cmd.extend(extra or [])
    cmd.extend(["-y", str(path)])
    subprocess.run(cmd, check=True)
    return path


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    for name, version, date in (("id3v23.mp3", 3, "2024"), ("id3v24.mp3", 4, "2023-02-03")):
        path = encode(name, "libmp3lame", ["-id3v2_version", str(version)])
        tags = ID3()
        tags.add(TIT2(encoding=3, text=[f"Synthetic {version}"]))
        tags.add(TPE1(encoding=3, text=["Fixture Artist"]))
        tags.add(TCON(encoding=3, text=["Funkot", "Breakbeat"]))
        tags.add(TDRC(encoding=3, text=[date]))
        tags.save(path, v2_version=version)

    path = encode("vorbis.flac", "flac")
    tags = FLAC(path)
    tags["TITLE"] = "Synthetic FLAC"
    tags["ARTIST"] = "Fixture Artist"
    tags["DATE"] = "2024-02-29"
    tags["GENRE"] = ["Funkot", "Breakbeat"]
    tags.save()

    path = encode("vorbis.ogg", "libvorbis")
    tags = OggVorbis(path)
    tags["TITLE"] = "Synthetic Ogg"
    tags["ARTIST"] = "Fixture Artist"
    tags["YEAR"] = "2023"
    tags["GENRE"] = ["Funkot", "Breakbeat"]
    tags.save()

    path = encode("conflicting.flac", "flac")
    tags = FLAC(path)
    tags["TITLE"] = "Conflicting years"
    tags["ARTIST"] = "Fixture Artist"
    tags["DATE"] = ["2023", "2024"]
    tags["GENRE"] = ["Funkot", "Breakbeat"]
    tags.save()

    path = encode("invalid.flac", "flac")
    tags = FLAC(path)
    tags["TITLE"] = "Invalid date"
    tags["ARTIST"] = "Fixture Artist"
    tags["DATE"] = "2024-13-01"
    tags["GENRE"] = ["Funkot", "Breakbeat"]
    tags.save()

    path = encode("release-only.m4a", "aac", ["-movflags", "+faststart"])
    tags = MP4(path)
    tags["\xa9nam"] = ["Synthetic M4A"]
    tags["\xa9ART"] = ["Fixture Artist"]
    tags["\xa9day"] = ["2022-06-01"]
    tags["\xa9gen"] = ["Funkot"]
    tags.save()

    path = encode("future.mp3", "libmp3lame", ["-id3v2_version", "4"])
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Future recording"]))
    tags.add(TPE1(encoding=3, text=["Fixture Artist"]))
    tags.add(TCON(encoding=3, text=["Funkot", "Breakbeat"]))
    tags.add(TDRC(encoding=3, text=["2099-01-01T00:00:00+09:00"]))
    tags.save(path, v2_version=4)

    path = encode("id3-time-only.mp3", "libmp3lame", ["-id3v2_version", "3"])
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Partial ID3 dates"]))
    tags.add(TPE1(encoding=3, text=["Fixture Artist"]))
    tags.add(TDAT(encoding=3, text=["1806"]))
    tags.add(TIME(encoding=3, text=["2024"]))
    tags.save(path, v2_version=3)

    path = encode("original-only.mp3", "libmp3lame", ["-id3v2_version", "3"])
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Original only"]))
    tags.add(TPE1(encoding=3, text=["Fixture Artist"]))
    tags.add(TORY(encoding=3, text=["1999"]))
    tags.save(path, v2_version=3)

    encode(
        "riff-info.wav", "pcm_s16le",
        ["-metadata", "title=Synthetic WAV", "-metadata", "artist=Fixture Artist",
         "-metadata", "ICRD=2024", "-metadata", "IGNR=Funkot"],
    )
    encode("tagless.wav", "pcm_s16le")


if __name__ == "__main__":
    main()
