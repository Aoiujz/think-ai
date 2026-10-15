"""Compare and run both SDK snapshots without modifying the main Git index."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default="978af2d")
    parser.add_argument("--php", default="php")
    args = parser.parse_args()
    files = (
        subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", args.baseline, "src/"], cwd=ROOT
        )
        .decode()
        .splitlines()
    )
    if len(files) != 18:
        raise RuntimeError("Expected the original 18-file PHP SDK snapshot")
    with tempfile.TemporaryDirectory(prefix="thinkai-php-baseline-") as directory:
        snapshot = Path(directory)
        for name in files:
            original = subprocess.check_output(["git", "show", f"{args.baseline}:{name}"], cwd=ROOT)
            migrated = (ROOT / "php" / name).read_bytes()
            if original.replace(b"\r\n", b"\n") != migrated.replace(b"\r\n", b"\n"):
                raise RuntimeError(f"PHP behavior source changed: {name}")
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(original)
        results = []
        for source in [snapshot / "src", ROOT / "php" / "src"]:
            environment = os.environ.copy()
            environment["THINKAI_SDK_SOURCE"] = str(source)
            result = subprocess.check_output(
                [args.php, "tests/php/compatibility.php"], cwd=ROOT, env=environment
            )
            results.append(json.loads(result))
        for result in results:
            result.pop("source")
        if results[0] != results[1]:
            raise RuntimeError(f"PHP compatibility snapshots differ: {results}")
        print(json.dumps({"baseline": args.baseline, "unchanged_files": len(files), **results[1]}))


if __name__ == "__main__":
    main()
