"""File store for the code runner: <root>/<storage_session_id>/<file_id>(.json)."""

from __future__ import annotations

import json
import secrets
import shutil
import time
from dataclasses import asdict, dataclass
from pathlib import Path

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
ID_PATTERN = r"^[A-Za-z0-9_-]{21}$"


def nanoid(size: int = 21) -> str:
    """LibreChat only accepts 21-character nanoid-style ids for sessions and files."""
    return "".join(secrets.choice(ALPHABET) for _ in range(size))


def safe_relative_path(name: str) -> str | None:
    """Normalises a mount name; None for absolute paths, '..' or empty names."""
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or name.startswith("/"):
        return None
    return "/".join(parts)


@dataclass
class FileMeta:
    file_id: str
    session_id: str
    name: str
    size: int
    created: float
    kind: str
    owner: str
    read_only: bool = False


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _paths(self, session_id: str, file_id: str) -> tuple[Path, Path]:
        base = self.root / session_id
        return base / file_id, base / f"{file_id}.json"

    def put(self, session_id: str, name: str, data_path: Path, *, kind: str, owner: str, read_only: bool = False) -> FileMeta:
        file_id = nanoid()
        blob, meta_path = self._paths(session_id, file_id)
        blob.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(data_path, blob)
        meta = FileMeta(file_id, session_id, name, blob.stat().st_size, time.time(), kind, owner, read_only)
        meta_path.write_text(json.dumps(asdict(meta)))
        return meta

    def get(self, session_id: str, file_id: str) -> tuple[FileMeta, Path] | None:
        blob, meta_path = self._paths(session_id, file_id)
        if not blob.is_file() or not meta_path.is_file():
            return None
        return FileMeta(**json.loads(meta_path.read_text())), blob

    def list(self, session_id: str) -> list[FileMeta] | None:
        base = self.root / session_id
        if not base.is_dir():
            return None
        return [FileMeta(**json.loads(p.read_text())) for p in sorted(base.glob("*.json"))]

    def delete(self, session_id: str, file_id: str) -> bool:
        blob, meta_path = self._paths(session_id, file_id)
        existed = blob.exists()
        blob.unlink(missing_ok=True)
        meta_path.unlink(missing_ok=True)
        return existed

    def prune(self, max_age_seconds: float) -> int:
        """Removes sessions whose newest file is older than max_age_seconds."""
        removed = 0
        cutoff = time.time() - max_age_seconds
        for session in self.root.iterdir():
            if not session.is_dir():
                continue
            newest = max((p.stat().st_mtime for p in session.iterdir()), default=0)
            if newest < cutoff:
                shutil.rmtree(session, ignore_errors=True)
                removed += 1
        return removed
