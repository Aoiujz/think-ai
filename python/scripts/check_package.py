"""Build and install each local artifact into a fresh environment outside src.

Run with the development environment's Python; --pip-python is useful for
bundled runtimes without pip. No package is uploaded or published.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import venv
import zipfile

project = Path(__file__).resolve().parents[1]
metadata = tomllib.loads((project / "pyproject.toml").read_text(encoding="utf-8"))["project"]
version = metadata["version"]
distribution = re.sub(r"[-_.]+", "_", metadata["name"]).lower()
parser = argparse.ArgumentParser()
parser.add_argument("--pip-python", default=sys.executable)
args = parser.parse_args()

def run(command, cwd):
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    subprocess.run(command, cwd=cwd, env=environment, check=True)

workspace = project / ".package-check"
workspace.mkdir(exist_ok=True)
environment = os.environ.copy()
environment["TMP"] = str(workspace)
environment["TEMP"] = str(workspace)
subprocess.run([sys.executable, "-m", "build", str(project), "--no-isolation"], cwd=project, env=environment, check=True)
artifacts = [project / f"dist/{distribution}-{version}-py3-none-any.whl", project / f"dist/{distribution}-{version}.tar.gz"]
for artifact in artifacts:
    assert artifact.is_file(), artifact
    if artifact.suffix == ".whl":
        with zipfile.ZipFile(artifact) as archive:
            assert any(name.endswith("LICENSE") for name in archive.namelist())
    else:
        with tarfile.open(artifact) as archive:
            assert any(name.endswith("LICENSE") for name in archive.getnames())
    with tempfile.TemporaryDirectory(prefix="consumer-", dir=workspace) as directory:
        consumer = Path(directory)
        assert consumer.resolve().is_relative_to(workspace.resolve())
        target = consumer / "venv"
        venv.EnvBuilder(with_pip=False).create(target)
        executable = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        # Install build backend separately so sdist is built without fetching an
        # untracked isolated backend; wheel installation uses the same process.
        base = [args.pip_python, "-m", "pip", "--python", str(executable), "install", "--index-url", "https://pypi.org/simple"]
        run(base + ["hatchling>=1.26"], consumer)
        run(base + ["--no-build-isolation", str(artifact)], consumer)
        code = f"import pathlib, thinkai; from thinkai import Client, AsyncClient; assert thinkai.__version__ == {version!r}; assert 'site-packages' in str(pathlib.Path(thinkai.__file__).resolve()); assert hasattr(Client, 'close'); print(thinkai.__file__)"
        run([str(executable), "-I", "-c", code], consumer)
        print(f"Verified installed {artifact.name}", flush=True)
