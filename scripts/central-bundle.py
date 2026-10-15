"""Bundle already accepted and detached-signed artifacts; no builds or credentials."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def build_bundle(manifest_path: Path, output_path: Path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("Expected a stable Maven release version")
    stem = f"think-ai-{version}"
    expected = {f"{stem}.jar", f"{stem}-sources.jar", f"{stem}-javadoc.jar", f"{stem}.pom"}
    files = manifest["files"]
    if len(files) != 4 or {item["name"] for item in files} != expected:
        raise ValueError("Bundle requires exactly the four accepted Maven artifacts")
    directory = output_path.parent.resolve(strict=True)
    prefix = f"com/topthink/think-ai/{version}/"
    entries = {}
    for item in files:
        path, signature_path = (
            Path(item["path"]).resolve(strict=True),
            Path(item["signature"]).resolve(strict=True),
        )
        if (
            path.parent != directory
            or signature_path.parent != directory
            or path.name != item["name"]
            or signature_path.name != path.name + ".asc"
        ):
            raise ValueError("Artifacts and signatures must remain in the bundle output directory")
        contents, signature = path.read_bytes(), signature_path.read_bytes()
        if len(contents) != item["size"] or hashlib.sha256(contents).hexdigest() != item["sha256"]:
            raise ValueError(f"Accepted artifact changed: {path.name}")
        if (
            not signature.startswith(b"-----BEGIN PGP SIGNATURE-----")
            or b"-----END PGP SIGNATURE-----" not in signature
        ):
            raise ValueError(f"Missing armored detached signature: {path.name}")
        entries[prefix + path.name] = contents
        entries[prefix + path.name + ".asc"] = signature
        for algorithm in ("md5", "sha1", "sha256", "sha512"):
            entries[prefix + path.name + "." + algorithm] = (
                hashlib.new(algorithm, contents).hexdigest().encode("ascii")
            )
    with zipfile.ZipFile(
        output_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as bundle:
        for name, contents in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, contents)
    return {
        "bundle": str(output_path),
        "sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(build_bundle(arguments.manifest, arguments.output)))
