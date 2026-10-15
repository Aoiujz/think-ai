"""Build a real Maven artifact, install locally, then run an independent consumer."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET

SDK = Path(__file__).resolve().parents[1]
ROOT = SDK.parent


def run(args, cwd=SDK, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def main():
    version = ET.parse(SDK / "pom.xml").getroot().findtext("{http://maven.apache.org/POM/4.0.0}version")
    if not version or not version.strip():
        raise SystemExit("java/pom.xml must declare its own project version.")
    version = version.strip()
    environment = os.environ.copy()
    maven = shutil.which("mvn")
    if not maven:
        candidates = list((SDK / ".tools").glob("apache-maven-*/bin/mvn.cmd"))
        if not candidates:
            raise SystemExit("Maven is required (mvn on PATH).")
        maven = str(candidates[0])
    if not environment.get("JAVA_HOME"):
        candidates = list((SDK / ".tools").glob("jdk-*"))
        if candidates:
            environment["JAVA_HOME"] = str(candidates[0])
    java = Path(environment["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java") if environment.get("JAVA_HOME") else Path(shutil.which("java") or "java")
    repository = SDK / ".repository"
    common = [maven, "-B", "-q", f"-Dmaven.repo.local={repository}"]
    run([*common, "-DskipTests", "install"], env=environment)
    artifact = SDK / "target" / f"think-ai-{version}.jar"
    with zipfile.ZipFile(artifact) as archive:
        names = archive.namelist()
        assert "com/topthink/ai/ThinkAIClient.class" in names
        assert "META-INF/LICENSE" in names and "META-INF/README.md" in names
        assert all(name.startswith(("com/", "META-INF/")) for name in names), names
        assert not any(name.endswith((".cs", ".php", ".py", ".ts", ".go")) for name in names)
    for classifier in ("sources", "javadoc"):
        assert (SDK / "target" / f"think-ai-{version}-{classifier}.jar").is_file()
    consumer = Path(tempfile.mkdtemp(prefix="package-consumer-", dir=SDK / "target"))
    (consumer / "src/main/java").mkdir(parents=True)
    (consumer / "pom.xml").write_text(
        f"""<project xmlns="http://maven.apache.org/POM/4.0.0">
<modelVersion>4.0.0</modelVersion><groupId>offline.consumer</groupId><artifactId>consumer</artifactId><version>1.0.0</version>
<properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
<dependencies><dependency><groupId>com.topthink</groupId><artifactId>think-ai</artifactId><version>{version}</version></dependency></dependencies>
<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version></plugin></plugins></build>
</project>""",
        encoding="utf-8",
    )
    (consumer / "src/main/java/Consumer.java").write_text(
        """import com.topthink.ai.*;
import java.net.URI;
import java.util.Map;
public class Consumer {
  public static void main(String[] args) throws Exception {
    if (!ThinkAIClient.VERSION.equals(args[1])) throw new AssertionError("runtime/package version mismatch");
    try (var client = ThinkAIClient.builder("offline-consumer").endpoint(URI.create(args[0])).build()) {
      try (var result = client.model().list(Map.of("type", "chat"))) {
        if (!result.json().path("query").path("type").asText().equals("chat")) throw new AssertionError("JSON");
      }
      try (var result = client.responses().create(Map.of("model", "offline"))) {
        int count = 0; for (var event : ((ApiResult.Events) result).stream()) count++;
        if (count != 3) throw new AssertionError("SSE");
      }
      try (var result = client.sandbox().downloadFile("box", "fixture.json")) {
        var bytes = ((ApiResult.Binary) result).stream().readAllBytes();
        if (!new String(bytes, java.nio.charset.StandardCharsets.UTF_8).equals("{ \\\"file\\\": true }\\n")) throw new AssertionError("download");
      }
    }
    System.out.println("Java packaged consumer: PASS");
  }
}""",
        encoding="utf-8",
    )
    classpath_file = consumer / "classpath.txt"
    run([*common, "-f", consumer / "pom.xml", "package", "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath", f"-Dmdep.outputFile={classpath_file}"], cwd=consumer, env=environment)
    node = subprocess.Popen(["node", str(ROOT / "tests/contracts/server.mjs")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**environment, "PORT": "0"}, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        endpoint = json.loads(node.stdout.readline())["endpoint"]
        command = [java]
        if environment.get("THINKAI_JAVA_SOCKET_DIR"):
            command.append("-Djdk.net.unixdomain.tmpdir=" + environment["THINKAI_JAVA_SOCKET_DIR"])
        command += ["-cp", str(consumer / "target/classes") + os.pathsep + classpath_file.read_text(encoding="utf-8").strip(), "Consumer", endpoint, version]
        run(command, cwd=consumer, env=environment)
    finally:
        node.terminate()
        try:
            node.wait(timeout=10)
        except subprocess.TimeoutExpired:
            node.kill()
    print(f"Artifact verified: {artifact}")


if __name__ == "__main__":
    main()
