"""Pack a NuGet artifact and consume it from a private local feed, without source references."""

from pathlib import Path
import json
import os
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET

SDK = Path(__file__).resolve().parents[1]
ROOT = SDK.parent


def run(args, cwd=SDK):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def main():
    version = (
        ET.parse(SDK / "TopThink.ThinkAI/TopThink.ThinkAI.csproj")
        .getroot()
        .findtext("./PropertyGroup/Version")
    )
    if not version or not version.strip():
        raise SystemExit("TopThink.ThinkAI.csproj must declare Version.")
    version = version.strip()
    output = SDK / "artifacts"
    output.mkdir(exist_ok=True)
    run(
        [
            "dotnet",
            "pack",
            SDK / "TopThink.ThinkAI/TopThink.ThinkAI.csproj",
            "-c",
            "Release",
            "-o",
            output,
            "--nologo",
        ]
    )
    artifact = output / f"TopThink.ThinkAI.{version}.nupkg"
    with zipfile.ZipFile(artifact) as archive:
        names = archive.namelist()
        assert "lib/net10.0/TopThink.ThinkAI.dll" in names
        assert "README.md" in names and "LICENSE" in names
        assert not any(
            name.endswith((".cs", ".php", ".java", ".py", ".ts", ".go")) for name in names
        )
        assert not any("contracts/" in name or "Tests" in name for name in names)
    consumer = Path(tempfile.mkdtemp(prefix="package-consumer-", dir=output))
    (consumer / "Consumer.csproj").write_text(
        f'''<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup><PackageReference Include="TopThink.ThinkAI" Version="{version}" /></ItemGroup>
</Project>''',
        encoding="utf-8",
    )
    (consumer / "Program.cs").write_text(
        """using TopThink.ThinkAI;
using System.Text;
using System.Text.Json.Nodes;
if (ThinkAIClient.Version != args[1]) throw new Exception("runtime/package version mismatch");
using var client = new ThinkAIClient("offline-consumer", new ThinkAIOptions { Endpoint = new Uri(args[0]) });
using (var result = await client.Model.ListAsync(new JsonObject { ["type"] = "chat" })) {
    if (result.Json?["query"]?["type"]?.GetValue<string>() != "chat") throw new Exception("JSON");
}
using (var result = await client.Responses.CreateAsync(new JsonObject { ["model"] = "offline" })) {
    int count = 0; await foreach (var item in result.Events!) count++;
    if (count != 3) throw new Exception("SSE");
}
using (var result = await client.Sandbox.DownloadFileAsync("box", "fixture.json")) {
    using var buffer = new MemoryStream(); await result.Binary!.CopyToAsync(buffer);
    if (Encoding.UTF8.GetString(buffer.ToArray()) != "{ \\\"file\\\": true }\\n") throw new Exception("download");
}
Console.WriteLine("NuGet packaged consumer: PASS");
""",
        encoding="utf-8",
    )
    run(
        [
            "dotnet",
            "restore",
            consumer / "Consumer.csproj",
            "--source",
            output,
            "--packages",
            consumer / "packages",
            "--nologo",
        ],
        cwd=consumer,
    )
    run(["dotnet", "build", consumer / "Consumer.csproj", "--no-restore", "--nologo"], cwd=consumer)
    node = subprocess.Popen(
        ["node", str(ROOT / "tests/contracts/server.mjs")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PORT": "0"},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        endpoint = json.loads(node.stdout.readline())["endpoint"]
        run(
            ["dotnet", consumer / "bin/Debug/net10.0/Consumer.dll", endpoint, version], cwd=consumer
        )
    finally:
        node.terminate()
        try:
            node.wait(timeout=10)
        except subprocess.TimeoutExpired:
            node.kill()
    print(f"Artifact verified: {artifact}")


if __name__ == "__main__":
    main()
