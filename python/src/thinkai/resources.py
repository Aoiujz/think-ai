"""Resource methods follow the existing PHP SDK; JSON fields are never filtered."""

from __future__ import annotations
import asyncio
import time
from pathlib import Path
from urllib.parse import quote
from .transport import OperationTimeout, ProtocolError


def _segment(value):
    return quote(str(value), safe="")


def _wait_seconds(wait):
    if wait is False or wait == 0 or wait is None:
        return None
    if wait is True:
        return 300.0
    if not isinstance(wait, (int, float)) or wait <= 0:
        raise ValueError("wait must be false, true or a positive number of seconds")
    return float(wait)


class Resource:
    def __init__(self, client):
        self._client = client


class Chat(Resource):
    def completions(self, params):
        params = {"stream": True, **params}
        return self._client._request("POST", "chat/completions", body=params)


class Responses(Resource):
    def create(self, params):
        return self._client._request("POST", "responses", body=params)


class Images(Resource):
    def generations(self, params):
        return self._client._request("POST", "images/generations", body=params)

    def inpainting(self, params):
        return self._client._request("POST", "images/inpainting", body=params)

    def outpainting(self, params):
        return self._client._request("POST", "images/outpainting", body=params)

    def upscale(self, params):
        return self._client._request("POST", "images/upscale", body=params)

    def poster(self, params):
        return self._client._request("POST", "images/poster", body=params)

    def edit(self, params):
        return self._client._request("POST", "images/edit", body=params)


class Videos(Resource):
    def generations(self, params):
        return self._client._request("POST", "videos/generations", body=params)

    def query(self, params):
        return self._client._request("POST", "videos/query", body=params)


class Audio(Resource):
    def speech(self, params):
        return self._client._request("POST", "audio/speech", body=params)

    def transcriptions(self, params):
        return self._client._request("POST", "audio/transcriptions", body=params)


class Avatar(Resource):
    def query(self, params):
        return self._client._request("POST", "avatar/query", body=params)

    def video(self, params, wait=False):
        seconds = _wait_seconds(wait)
        result = self._client._request("POST", "avatar/video", body=params)
        if seconds is None:
            return result
        if not isinstance(result, dict) or not result.get("id"):
            raise ProtocolError("Avatar generation did not return a task ID")
        task_id = result["id"]
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OperationTimeout("Avatar wait timed out")
            result = self._client._request(
                "POST",
                "avatar/query",
                body={"model": params["model"], "id": task_id},
                timeout=min(self._client.timeout, remaining),
            )
            status = result.get("status") if isinstance(result, dict) else None
            if status in ("success", "fail"):
                return result
            if status != "processing":
                raise ProtocolError("Unknown Avatar task status")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OperationTimeout("Avatar wait timed out")
            time.sleep(min(self._client.poll_interval, remaining))


class Music(Resource):
    def song(self, params):
        return self._client._request("POST", "music/song", body=params)

    def bgm(self, params):
        return self._client._request("POST", "music/bgm", body=params)

    def query(self, params):
        return self._client._request("POST", "music/query", body=params)


class Embeddings(Resource):
    def create(self, params):
        return self._client._request("POST", "embeddings", body=params)


class Rerank(Resource):
    def create(self, params):
        return self._client._request("POST", "rerank", body=params)


class Decision(Resource):
    def evaluate(self, params):
        return self._client._request("POST", "decisions", body=params)


class Plugin(Resource):
    def list(self, params=None):
        return self._client._request("GET", "plugin", query=params)


class Model(Resource):
    def list(self, params=None):
        return self._client._request("GET", "model", query=params)

    def show(self, type, code):
        return self._client._request("GET", f"model/{_segment(type)}/{_segment(code)}")


class Skill(Resource):
    def list(self, params=None):
        return self._client._request("GET", "skill", query=params)

    def categories(self):
        return self._client._request("GET", "skill/category")

    def download(self, path):
        return self._client._request("GET", "skill/download", query={"path": path}, binary=True)


class Sandbox(Resource):
    def create(self, name=None):
        return self._client._request("POST", "sandbox", body={"name": name})

    def get(self, id):
        return self._client._request("GET", f"sandbox/{_segment(id)}")

    def delete(self, id):
        return self._client._request("DELETE", f"sandbox/{_segment(id)}")

    def list_file(self, id, path=None):
        return self._client._request("GET", f"sandbox/{_segment(id)}/list", query={"path": path})

    def read_file(self, id, path):
        return self._client._request("GET", f"sandbox/{_segment(id)}/read", query={"path": path})

    def write_file(self, id, path, content):
        return self._client._request(
            "POST", f"sandbox/{_segment(id)}/write", body={"path": path, "content": content}
        )

    def edit_file(self, id, path, old_str, new_str=""):
        return self._client._request(
            "POST",
            f"sandbox/{_segment(id)}/edit",
            body={"path": path, "old_str": old_str, "new_str": new_str},
        )

    def download_file(self, id, path):
        return self._client._request(
            "GET", f"sandbox/{_segment(id)}/download", query={"path": path}, binary=True
        )

    def run_code(self, id, code, files=None):
        return self._client._request(
            "POST",
            f"sandbox/{_segment(id)}/code",
            body={"code": code, "files": [] if files is None else files},
        )

    def run_command(self, id, command, stream=False):
        return self._client._request(
            "POST", f"sandbox/{_segment(id)}/command", body={"command": command, "stream": stream}
        )

    def upload_file(self, id, path, file):
        owned = isinstance(file, (str, Path))
        content = open(file, "rb") if owned else file
        try:
            return self._client._request(
                "POST",
                f"sandbox/{_segment(id)}/upload",
                data={"path": path},
                files={"file": (Path(path).name, content, "application/octet-stream")},
            )
        finally:
            if owned:
                content.close()


class AsyncChat(Resource):
    async def completions(self, params):
        params = {"stream": True, **params}
        return await self._client._request("POST", "chat/completions", body=params)


class AsyncResponses(Resource):
    async def create(self, params):
        return await self._client._request("POST", "responses", body=params)


class AsyncImages(Resource):
    async def generations(self, params):
        return await self._client._request("POST", "images/generations", body=params)

    async def inpainting(self, params):
        return await self._client._request("POST", "images/inpainting", body=params)

    async def outpainting(self, params):
        return await self._client._request("POST", "images/outpainting", body=params)

    async def upscale(self, params):
        return await self._client._request("POST", "images/upscale", body=params)

    async def poster(self, params):
        return await self._client._request("POST", "images/poster", body=params)

    async def edit(self, params):
        return await self._client._request("POST", "images/edit", body=params)


class AsyncVideos(Resource):
    async def generations(self, params):
        return await self._client._request("POST", "videos/generations", body=params)

    async def query(self, params):
        return await self._client._request("POST", "videos/query", body=params)


class AsyncAudio(Resource):
    async def speech(self, params):
        return await self._client._request("POST", "audio/speech", body=params)

    async def transcriptions(self, params):
        return await self._client._request("POST", "audio/transcriptions", body=params)


class AsyncAvatar(Resource):
    async def query(self, params):
        return await self._client._request("POST", "avatar/query", body=params)

    async def video(self, params, wait=False):
        seconds = _wait_seconds(wait)
        result = await self._client._request("POST", "avatar/video", body=params)
        if seconds is None:
            return result
        if not isinstance(result, dict) or not result.get("id"):
            raise ProtocolError("Avatar generation did not return a task ID")
        task_id = result["id"]
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OperationTimeout("Avatar wait timed out")
            result = await self._client._request(
                "POST",
                "avatar/query",
                body={"model": params["model"], "id": task_id},
                timeout=min(self._client.timeout, remaining),
            )
            status = result.get("status") if isinstance(result, dict) else None
            if status in ("success", "fail"):
                return result
            if status != "processing":
                raise ProtocolError("Unknown Avatar task status")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OperationTimeout("Avatar wait timed out")
            await asyncio.sleep(min(self._client.poll_interval, remaining))


class AsyncMusic(Resource):
    async def song(self, params):
        return await self._client._request("POST", "music/song", body=params)

    async def bgm(self, params):
        return await self._client._request("POST", "music/bgm", body=params)

    async def query(self, params):
        return await self._client._request("POST", "music/query", body=params)


class AsyncEmbeddings(Resource):
    async def create(self, params):
        return await self._client._request("POST", "embeddings", body=params)


class AsyncRerank(Resource):
    async def create(self, params):
        return await self._client._request("POST", "rerank", body=params)


class AsyncDecision(Resource):
    async def evaluate(self, params):
        return await self._client._request("POST", "decisions", body=params)


class AsyncPlugin(Resource):
    async def list(self, params=None):
        return await self._client._request("GET", "plugin", query=params)


class AsyncModel(Resource):
    async def list(self, params=None):
        return await self._client._request("GET", "model", query=params)

    async def show(self, type, code):
        return await self._client._request("GET", f"model/{_segment(type)}/{_segment(code)}")


class AsyncSkill(Resource):
    async def list(self, params=None):
        return await self._client._request("GET", "skill", query=params)

    async def categories(self):
        return await self._client._request("GET", "skill/category")

    async def download(self, path):
        return await self._client._request(
            "GET", "skill/download", query={"path": path}, binary=True
        )


class AsyncSandbox(Resource):
    async def create(self, name=None):
        return await self._client._request("POST", "sandbox", body={"name": name})

    async def get(self, id):
        return await self._client._request("GET", f"sandbox/{_segment(id)}")

    async def delete(self, id):
        return await self._client._request("DELETE", f"sandbox/{_segment(id)}")

    async def list_file(self, id, path=None):
        return await self._client._request(
            "GET", f"sandbox/{_segment(id)}/list", query={"path": path}
        )

    async def read_file(self, id, path):
        return await self._client._request(
            "GET", f"sandbox/{_segment(id)}/read", query={"path": path}
        )

    async def write_file(self, id, path, content):
        return await self._client._request(
            "POST", f"sandbox/{_segment(id)}/write", body={"path": path, "content": content}
        )

    async def edit_file(self, id, path, old_str, new_str=""):
        return await self._client._request(
            "POST",
            f"sandbox/{_segment(id)}/edit",
            body={"path": path, "old_str": old_str, "new_str": new_str},
        )

    async def download_file(self, id, path):
        return await self._client._request(
            "GET", f"sandbox/{_segment(id)}/download", query={"path": path}, binary=True
        )

    async def run_code(self, id, code, files=None):
        return await self._client._request(
            "POST",
            f"sandbox/{_segment(id)}/code",
            body={"code": code, "files": [] if files is None else files},
        )

    async def run_command(self, id, command, stream=False):
        return await self._client._request(
            "POST", f"sandbox/{_segment(id)}/command", body={"command": command, "stream": stream}
        )

    async def upload_file(self, id, path, file):
        owned = isinstance(file, (str, Path))
        content = open(file, "rb") if owned else file
        try:
            return await self._client._request(
                "POST",
                f"sandbox/{_segment(id)}/upload",
                data={"path": path},
                files={"file": (Path(path).name, content, "application/octet-stream")},
            )
        finally:
            if owned:
                content.close()
