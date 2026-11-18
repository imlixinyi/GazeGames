"""Download MediaPipe Face Landmarker files into ./vendor so the MediaPipe tracker works
without reaching cdn.jsdelivr.net / storage.googleapis.com at experiment time
(useful offline, on slow networks, or where Google services are blocked).

    python3 tools/download_models.py
"""
import sys
import urllib.request
from pathlib import Path

VERSION = "0.10.3"
CDN = f"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{VERSION}"
ROOT = Path(__file__).resolve().parent.parent / "vendor"
FILES = [
    (CDN, ROOT / "tasks-vision" / "vision_bundle.mjs"),
    *[(f"{CDN}/wasm/{name}", ROOT / "tasks-vision" / "wasm" / name) for name in (
        "vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm")],
    ("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", ROOT / "face_landmarker.task"),
]


def main():
    failed = 0
    for url, dest in FILES:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            dest.write_bytes(data)
            print(f"ok   {dest.relative_to(ROOT.parent)}  ({len(data) / 1e6:.1f} MB)")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {url}\n     {e}")
    if failed:
        print(f"\n{failed} file(s) failed. The tracker will fall back to the online CDN.")
        sys.exit(1)
    print("\nDone. The MediaPipe tracker will now load from ./vendor.")


if __name__ == "__main__":
    main()
