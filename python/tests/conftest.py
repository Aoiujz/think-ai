import json
from pathlib import Path
import subprocess
import sys
import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

@pytest.fixture(scope="session")
def endpoint():
    script = Path(__file__).parents[2] / "tests/contracts/server.mjs"
    process = subprocess.Popen(["node", str(script)], stdout=subprocess.PIPE, text=True)
    try:
        yield json.loads(process.stdout.readline())["endpoint"]
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
