"""Runs one code execution in a fresh, network-less container with /mnt/data bind-mounted."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass, field
from pathlib import Path

import docker
from docker.errors import NotFound
from docker.types import LogConfig

from .storage import FileMeta, Store, nanoid, safe_relative_path

LANGUAGES = {
    "bash": ("main.sh", ["bash", "/code/main.sh"]),
    "sh": ("main.sh", ["bash", "/code/main.sh"]),
    "py": ("main.py", ["python3", "/code/main.py"]),
    "python": ("main.py", ["python3", "/code/main.py"]),
    "js": ("main.js", ["node", "/code/main.js"]),
    "javascript": ("main.js", ["node", "/code/main.js"]),
    "node": ("main.js", ["node", "/code/main.js"]),
}


@dataclass
class Limits:
    timeout_seconds: int = 60
    memory: str = "1g"
    cpus: float = 1.0
    pids: int = 256
    output_bytes: int = 64 * 1024
    max_files: int = 50
    max_file_bytes: int = 50 * 1024 * 1024


@dataclass
class InputFile:
    session_id: str
    file_id: str
    name: str


@dataclass
class ExecResult:
    session_id: str
    stdout: str
    stderr: str
    files: list[dict] = field(default_factory=list)
    deleted_files: list[str] = field(default_factory=list)
    status: str | None = None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hand_over(data_dir: Path) -> None:
    """Lets the sandbox user (uid 1000) write /mnt/data.

    The runner runs as root in production and simply chowns; without root (CI, local tests)
    the directory is made world-writable instead.
    """
    paths = [data_dir, *data_dir.rglob("*")]
    try:
        for path in paths:
            os.chown(path, 1000, 1000)
    except PermissionError:
        for path in paths:
            path.chmod(0o777 if path.is_dir() else 0o666)


def _read_regular(path: Path, limit: int) -> bytes | None:
    """Reads a file written by the sandbox: never through a symlink, never more than limit bytes.

    The sandbox controls /mnt/data, so a planted symlink must not make the runner (root) read
    its own files.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return None
        return handle.read(limit + 1)[:limit]


def _truncate(data: bytes, limit: int) -> tuple[str, bool]:
    if len(data) <= limit:
        return data.decode("utf-8", errors="replace"), False
    return data[:limit].decode("utf-8", errors="replace") + "\n[… Ausgabe gekürzt]", True


@dataclass
class CadResult:
    ok: bool
    stdout: str
    stderr: str
    info: dict | None = None
    files: dict[str, bytes] = field(default_factory=dict)


CAD_WRAPPER = Path(__file__).with_name("cad_wrapper.py")
CAD_OUTPUTS = ("model.stl", "model.step", "model.3mf", "model.glb", "preview.png")


class Sandbox:
    def __init__(
        self,
        store: Store,
        work_root: Path,
        image: str,
        limits: Limits | None = None,
        cad_image: str | None = None,
        cad_limits: Limits | None = None,
    ) -> None:
        self.store = store
        # Must be the same path on the host and in this container (bind-mounted 1:1),
        # because the sandbox containers mount sub-directories of it
        self.work_root = work_root
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.image = image
        self.limits = limits or Limits()
        self.cad_image = cad_image
        self.cad_limits = cad_limits or Limits(timeout_seconds=90, memory="2g")
        self.client = docker.from_env()

    def run_cad(self, code: str, formats: list[str]) -> CadResult:
        """Runs build123d code in the CAD image and returns the exported files."""
        if not self.cad_image:
            return CadResult(False, "", "CAD ist nicht eingerichtet (CAD_SANDBOX_IMAGE fehlt).")
        job = self.work_root / f"cad-{nanoid()}"
        data_dir, code_dir = job / "data", job / "code"
        data_dir.mkdir(parents=True)
        code_dir.mkdir()
        try:
            (code_dir / "model.py").write_text(code)
            (code_dir / "wrapper.py").write_text(CAD_WRAPPER.read_text())
            (code_dir / "formats.json").write_text(json.dumps([f for f in formats if f in ("step", "3mf")]))
            _hand_over(data_dir)
            stdout, stderr, status = self._execute(
                ["python3", "/code/wrapper.py"], data_dir, code_dir, image=self.cad_image, limits=self.cad_limits
            )
            info_raw = _read_regular(data_dir / "info.json", 64 * 1024)
            if status == "TO" or info_raw is None:
                return CadResult(False, stdout, stderr or "CAD-Ausführung ohne Ergebnis beendet.")
            try:
                info = json.loads(info_raw)
            except ValueError:
                return CadResult(False, stdout, "CAD-Export lieferte ungültige Modelldaten.")
            files = {}
            for name in CAD_OUTPUTS:
                data = _read_regular(data_dir / name, self.cad_limits.max_file_bytes)
                if data is not None:
                    files[name] = data
            return CadResult(True, stdout, stderr, info if isinstance(info, dict) else None, files)
        finally:
            shutil.rmtree(job, ignore_errors=True)

    def run(self, lang: str, code: str, args: list[str], inputs: list[InputFile], owner: str) -> ExecResult:
        session_id = nanoid()
        if lang not in LANGUAGES:
            return ExecResult(session_id, "", f"Sprache „{lang}“ wird nicht unterstützt (bash, py, js).")
        filename, command = LANGUAGES[lang]

        job = self.work_root / session_id
        data_dir, code_dir = job / "data", job / "code"
        data_dir.mkdir(parents=True)
        code_dir.mkdir()
        try:
            input_hashes, read_only = self._mount_inputs(inputs, data_dir)
            (code_dir / filename).write_text(code)
            _hand_over(data_dir)
            for name in read_only:
                (data_dir / name).chmod(0o444)

            stdout, stderr, status = self._execute(command + [str(a) for a in args], data_dir, code_dir)
            files, deleted = self._collect_outputs(session_id, data_dir, input_hashes, owner)
            return ExecResult(session_id, stdout, stderr, files, deleted, status)
        finally:
            shutil.rmtree(job, ignore_errors=True)

    def _mount_inputs(self, inputs: list[InputFile], data_dir: Path) -> tuple[dict[str, str], set[str]]:
        hashes: dict[str, str] = {}
        read_only: set[str] = set()
        for item in inputs:
            name = safe_relative_path(item.name)
            found = self.store.get(item.session_id, item.file_id)
            # First file wins when two refs mount at the same path
            if not name or not found or name in hashes:
                continue
            meta, blob = found
            target = data_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(blob, target)
            hashes[name] = _sha256(target)
            if meta.read_only:
                read_only.add(name)
        return hashes, read_only

    def _execute(
        self,
        command: list[str],
        data_dir: Path,
        code_dir: Path,
        image: str | None = None,
        limits: Limits | None = None,
    ) -> tuple[str, str, str | None]:
        limits = limits or self.limits
        container = self.client.containers.create(
            image or self.image,
            command=command,
            user="1000:1000",
            working_dir="/mnt/data",
            network_disabled=True,
            read_only=True,
            tmpfs={"/tmp": "size=256m,mode=1777"},
            volumes={
                str(data_dir): {"bind": "/mnt/data", "mode": "rw"},
                str(code_dir): {"bind": "/code", "mode": "ro"},
            },
            mem_limit=limits.memory,
            memswap_limit=limits.memory,
            nano_cpus=int(limits.cpus * 1e9),
            pids_limit=limits.pids,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            environment={"HOME": "/mnt/data", "MPLBACKEND": "Agg"},
            labels={"portal.code-runner": "exec"},
            # Keeps docker's log file (and what logs() loads into memory) small
            log_config=LogConfig(type=LogConfig.types.JSON, config={"max-size": "1m", "max-file": "1"}),
        )
        status = None
        notes: list[str] = []
        try:
            container.start()
            try:
                exit_info = container.wait(timeout=limits.timeout_seconds)
                exit_code = exit_info.get("StatusCode", 0)
                if exit_code == 137:
                    notes.append("Prozess beendet (Speicherlimit überschritten?).")
                elif exit_code:
                    notes.append(f"Beendet mit Exit-Code {exit_code}.")
            except Exception:  # requests timeout
                container.kill()
                status = "TO"
                notes.append(f"Ausführung nach {limits.timeout_seconds} s abgebrochen (Zeitlimit).")
            stdout, out_cut = _truncate(container.logs(stdout=True, stderr=False), limits.output_bytes)
            stderr, err_cut = _truncate(container.logs(stdout=False, stderr=True), limits.output_bytes)
            if out_cut or err_cut:
                status = status or "OL"
        finally:
            try:
                container.remove(force=True)
            except NotFound:
                pass
        if notes:
            stderr = (stderr + "\n" if stderr else "") + "\n".join(notes)
        return stdout, stderr, status

    def _collect_outputs(
        self, session_id: str, data_dir: Path, input_hashes: dict[str, str], owner: str
    ) -> tuple[list[dict], list[str]]:
        files: list[dict] = []
        seen: set[str] = set()
        notes: list[str] = []
        for path in sorted(data_dir.rglob("*")):
            rel = path.relative_to(data_dir).as_posix()
            if path.is_symlink() or not path.is_file() or any(part.startswith(".") for part in rel.split("/")):
                continue
            seen.add(rel)
            if input_hashes.get(rel) == _sha256(path):
                continue  # unchanged input
            if path.stat().st_size > self.limits.max_file_bytes or len(files) >= self.limits.max_files:
                notes.append(rel)
                continue
            meta: FileMeta = self.store.put(session_id, rel, path, kind="user", owner=owner)
            files.append({"id": meta.file_id, "name": rel, "storage_session_id": session_id})
        deleted = [name for name in input_hashes if name not in seen]
        return files, deleted
