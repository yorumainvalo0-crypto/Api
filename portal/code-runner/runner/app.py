"""HTTP API compatible with LibreChat's Code API (LIBRECHAT_CODE_BASEURL=http://code-runner:8000/v1)."""

from __future__ import annotations

import os
import re
import tempfile
import threading
import time
from email.utils import formatdate
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from .sandbox import ExecResult, InputFile, Limits, Sandbox
from .storage import ID_PATTERN, Store, nanoid, safe_relative_path

ID_RE = re.compile(ID_PATTERN)


def _check_id(*values: str) -> None:
    if not all(ID_RE.match(v) for v in values):
        raise HTTPException(status_code=400, detail="invalid id")


def create_app(store: Store, sandbox: Sandbox, *, max_parallel: int = 4, max_upload_bytes: int = 100 * 1024 * 1024) -> FastAPI:
    app = FastAPI(title="portal code runner", docs_url=None, redoc_url=None, openapi_url=None)
    slots = threading.BoundedSemaphore(max_parallel)

    @app.get("/health")
    @app.get("/v1/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/v1/exec")
    async def execute(request: Request) -> dict[str, Any]:
        body = await request.json()
        lang = str(body.get("lang", ""))
        code = body.get("code")
        if not isinstance(code, str):
            raise HTTPException(status_code=400, detail="code is required")
        args = body.get("args") or []
        inputs = [
            InputFile(
                session_id=str(f.get("storage_session_id") or body.get("session_id") or ""),
                file_id=str(f.get("id", "")),
                name=str(f.get("name", "")),
            )
            for f in body.get("files") or []
            if isinstance(f, dict)
        ]
        owner = str(body.get("user_id") or request.headers.get("user-id") or "")

        def run() -> ExecResult:
            with slots:
                return sandbox.run(lang, code, list(args) if isinstance(args, list) else [], inputs, owner)

        result = await run_in_threadpool(run)
        response: dict[str, Any] = {
            "session_id": result.session_id,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "files": result.files,
        }
        if result.deleted_files:
            response["deleted_files"] = result.deleted_files
        if result.status:
            response["status"] = result.status
        return response

    async def _receive_files(request: Request) -> tuple[dict[str, str], list[tuple[str, Path]]]:
        form = await request.form(max_part_size=max_upload_bytes)
        fields: dict[str, str] = {}
        files: list[tuple[str, Path]] = []
        for key, value in form.multi_items():
            if isinstance(value, str):
                fields[key] = value
                continue
            name = safe_relative_path(value.filename or "") or os.path.basename(value.filename or "") or "datei"
            handle, tmp = tempfile.mkstemp()
            with os.fdopen(handle, "wb") as out:
                while chunk := await value.read(1 << 20):
                    out.write(chunk)
            files.append((name, Path(tmp)))
        return fields, files

    @app.post("/v1/upload")
    async def upload(request: Request) -> dict[str, Any]:
        fields, files = await _receive_files(request)
        if not files:
            return JSONResponse({"message": "error", "error": "no file provided"}, status_code=400)
        session_id = nanoid()
        name, tmp = files[0]
        try:
            meta = store.put(session_id, name, tmp, kind=fields.get("kind", "user"), owner=fields.get("id", ""))
        finally:
            for _, path in files:
                path.unlink(missing_ok=True)
        return {"message": "success", "storage_session_id": session_id, "files": [{"fileId": meta.file_id, "filename": meta.name}]}

    @app.post("/v1/upload/batch")
    async def upload_batch(request: Request) -> dict[str, Any]:
        fields, files = await _receive_files(request)
        if not files:
            return JSONResponse({"message": "error", "error": "no files provided"}, status_code=400)
        session_id = nanoid()
        read_only = fields.get("read_only") == "true"
        results = []
        try:
            for name, tmp in files:
                meta = store.put(session_id, name, tmp, kind=fields.get("kind", "skill"), owner=fields.get("id", ""), read_only=read_only)
                results.append({"status": "success", "fileId": meta.file_id, "filename": meta.name})
        finally:
            for _, path in files:
                path.unlink(missing_ok=True)
        return {"message": "success", "storage_session_id": session_id, "files": results, "succeeded": len(results), "failed": 0}

    @app.get("/v1/download/{session_id}/{file_id}")
    def download(session_id: str, file_id: str) -> FileResponse:
        _check_id(session_id, file_id)
        found = store.get(session_id, file_id)
        if not found:
            raise HTTPException(status_code=404, detail="not found")
        meta, blob = found
        return FileResponse(blob, filename=os.path.basename(meta.name), media_type="application/octet-stream")

    @app.get("/v1/sessions/{session_id}/objects/{file_id}")
    def object_info(session_id: str, file_id: str) -> dict[str, Any]:
        _check_id(session_id, file_id)
        found = store.get(session_id, file_id)
        if not found:
            raise HTTPException(status_code=404, detail="not found")
        meta, _ = found
        return {
            "name": meta.name,
            "originalFilename": meta.name,
            "size": meta.size,
            "lastModified": formatdate(meta.created, usegmt=True),
            "readOnly": meta.read_only,
        }

    @app.get("/v1/files/{session_id}")
    def list_files(session_id: str) -> list[dict[str, Any]]:
        _check_id(session_id)
        files = store.list(session_id)
        if files is None:
            raise HTTPException(status_code=404, detail="not found")
        return [
            {
                "fileId": m.file_id,
                "id": m.file_id,
                "name": m.name,
                "filename": m.name,
                "size": m.size,
                "lastModified": formatdate(m.created, usegmt=True),
            }
            for m in files
        ]

    @app.delete("/v1/files/{session_id}/{file_id}")
    @app.delete("/v1/sessions/{session_id}/objects/{file_id}")
    def delete_file(session_id: str, file_id: str) -> dict[str, bool]:
        _check_id(session_id, file_id)
        if not store.delete(session_id, file_id):
            raise HTTPException(status_code=404, detail="not found")
        return {"ok": True}

    return app


def _prune_forever(store: Store, max_age_days: float) -> None:
    while True:
        store.prune(max_age_days * 86_400)
        time.sleep(3600)


def app_from_env() -> FastAPI:
    store = Store(Path(os.environ.get("STORE_DIR", "/data/store")))
    limits = Limits(
        timeout_seconds=int(os.environ.get("EXEC_TIMEOUT_SECONDS", "60")),
        memory=os.environ.get("EXEC_MEMORY", "1g"),
        cpus=float(os.environ.get("EXEC_CPUS", "1")),
    )
    sandbox = Sandbox(store, Path(os.environ["WORK_DIR"]), os.environ.get("SANDBOX_IMAGE", "portal-sandbox:latest"), limits)
    threading.Thread(target=_prune_forever, args=(store, float(os.environ.get("RETENTION_DAYS", "7"))), daemon=True).start()
    return create_app(store, sandbox, max_parallel=int(os.environ.get("MAX_PARALLEL", "4")))
