"""Build a Git export from current files and consume it through Composer dist."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def run(command, directory, **kwargs):
    return subprocess.run(command, cwd=directory, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--composer", nargs="+", default=["composer"])
    parser.add_argument("--php", default="php")
    args = parser.parse_args()
    composer = [str((ROOT / part).resolve()) if part.endswith(".phar") and not Path(part).is_absolute() else part for part in args.composer]
    artifact_directory = ROOT / ".artifacts"
    artifact_directory.mkdir(exist_ok=True)
    archive = artifact_directory / "think-ai-php.zip"
    with tempfile.TemporaryDirectory(prefix="thinkai-package-", dir=artifact_directory) as directory:
        temporary = Path(directory)
        snapshot = temporary / "snapshot"
        snapshot.mkdir()
        names = (
            subprocess
            .check_output(["git", "-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT)
            .split(b"\0")
        )  # fmt: skip
        for raw_name in names:
            if not raw_name:
                continue
            relative = Path(raw_name.decode("utf8"))
            source = ROOT / relative
            if source.is_file():
                destination = snapshot / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
        run(["git", "init", "--quiet"], snapshot)
        run(["git", "-c", "core.autocrlf=false", "add", "--all"], snapshot, stdout=subprocess.DEVNULL)
        tree = (
            subprocess
            .check_output(["git", "write-tree"], cwd=snapshot)
            .decode()
            .strip()
        )  # fmt: skip
        run(["git", "archive", "--format=zip", f"--output={archive}", tree], snapshot)
        with zipfile.ZipFile(archive) as package:
            files = package.namelist()
            forbidden = ["python/", "typescript/", "go/", "java/", "dotnet/", "tests/", "scripts/", ".github/", "docs/"]
            assert not any(name.startswith(tuple(forbidden)) for name in files), files
            assert "composer.json" in files and "php/src/Client.php" in files
            assert "src/Client.php" not in files
        metadata = json.loads((ROOT / "composer.json").read_text())
        metadata.update({"version": "1.0.2", "dist": {"type": "zip", "url": archive.as_uri()}})
        # Repackage the real installed dependencies as local dist archives so
        # consumer installation is independent of network and user-level caches.
        lock = json.loads((ROOT / "composer.lock").read_text())
        dependencies = temporary / "dependencies"
        dependencies.mkdir()
        for dependency in lock["packages"]:
            source = ROOT / "vendor" / dependency["name"]
            if not source.is_dir():
                raise RuntimeError("Run composer install before this check: " + dependency["name"])
            dependency_zip = dependencies / (dependency["name"].replace("/", "-") + ".zip")
            with zipfile.ZipFile(dependency_zip, "w", zipfile.ZIP_DEFLATED) as bundle:
                for file in source.rglob("*"):
                    if file.is_file():
                        bundle.write(file, "package/" + file.relative_to(source).as_posix())
            dependency["dist"] = {"type": "zip", "url": dependency_zip.as_uri()}
        consumer = temporary / "consumer"
        consumer.mkdir()
        (consumer / "composer.json").write_text(json.dumps({"require": {"topthink/think-ai": "1.0.2"}, "repositories": [{"type": "package", "package": [metadata, *lock["packages"]]}, {"packagist.org": False}]}))
        environment = os.environ.copy()
        environment["COMPOSER_DISABLE_NETWORK"] = "1"
        run(composer + ["install", "--prefer-dist", "--no-scripts", "--no-interaction", "--no-progress"], consumer, env=environment)
        installed = consumer / "vendor" / "topthink" / "think-ai"
        assert not any((installed / name.rstrip("/")).exists() for name in forbidden)
        smoke = consumer / "smoke.php"
        smoke.write_text("<?php require __DIR__ . '/vendor/autoload.php'; $client = new think\\ai\\Client('offline-token'); foreach (['chat','responses','images','videos','audio','avatar','music','embeddings','rerank','decision','plugin','model','sandbox','skill'] as $resource) { if (!is_object($client->$resource())) throw new RuntimeException($resource); } echo 'Composer consumer: 14 resources OK' . PHP_EOL;")
        run([args.php, str(smoke)], consumer)
        print(json.dumps({"archive": str(archive), "entries": len(files), "composer_dist_install": "passed", "source_install_isolation": "not guaranteed by design"}))


if __name__ == "__main__":
    main()
