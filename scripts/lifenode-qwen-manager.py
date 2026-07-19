#!/usr/bin/env python3

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MIB = 1024 * 1024


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class LlamaQwenManager:
    def __init__(self) -> None:
        self.manager_host = os.getenv("LLAMACPP_MANAGER_HOST", "0.0.0.0")
        self.manager_port = env_int("LLAMACPP_MANAGER_PORT", 8080)
        self.internal_host = os.getenv("LLAMACPP_INTERNAL_HOST", "0.0.0.0")
        self.internal_port = env_int("LLAMACPP_INTERNAL_PORT", 8081)
        self.ngl = env_int("LLAMACPP_NGL", 0)
        self.no_mmap = env_bool("LLAMACPP_NO_MMAP", True)
        self.mlock = env_bool("LLAMACPP_MLOCK", True)
        self.memory_guard_enabled = env_bool("LLAMACPP_MEMORY_GUARD_ENABLED", True)
        self.memory_guard_headroom_mib = env_int("LLAMACPP_MEMORY_GUARD_HEADROOM_MIB", 1536)
        self.context_overhead_per_token_kib = env_int(
            "LLAMACPP_CONTEXT_OVERHEAD_PER_TOKEN_KIB",
            128,
        )
        self.runtime_overhead_mib = env_int("LLAMACPP_RUNTIME_OVERHEAD_MIB", 192)
        self.readiness_timeout_secs = env_int("LLAMACPP_READINESS_TIMEOUT_SECS", 300)
        self.stop_timeout_secs = env_int("LLAMACPP_STOP_TIMEOUT_SECS", 20)
        self.default_model_id = os.getenv("LLAMACPP_DEFAULT_MODEL_ID", "qwen3.5-0.8b")
        self.models = {
            "qwen3.5-0.8b": {
                "id": "qwen3.5-0.8b",
                "label": "Qwen3.5 0.8B",
                "path": os.getenv(
                    "LLAMACPP_QWEN_0_8B_MODEL_PATH",
                    "/models/Qwen3.5-0.8B-UD-Q3_K_XL.gguf",
                ),
                "context_length": env_int("LLAMACPP_QWEN_0_8B_CTX", 4096),
                "description": "Fastest local Qwen option. Best for quick drafting and low RAM usage.",
            },
            "qwen3.5-2b": {
                "id": "qwen3.5-2b",
                "label": "Qwen3.5 2B",
                "path": os.getenv(
                    "LLAMACPP_QWEN_2B_MODEL_PATH",
                    "/models/Qwen3.5-2B-UD-Q4_K_XL.gguf",
                ),
                "context_length": env_int("LLAMACPP_QWEN_2B_CTX", 2048),
                "description": "Higher quality and more reliable than 0.8B, with a heavier load.",
            },
            "qwen3.5-4b": {
                "id": "qwen3.5-4b",
                "label": "Qwen3.5 4B",
                "path": os.getenv(
                    "LLAMACPP_QWEN_4B_MODEL_PATH",
                    "/models/Qwen3.5-4B-UD-Q3_K_XL.gguf",
                ),
                "context_length": env_int("LLAMACPP_QWEN_4B_CTX", 1024),
                "description": "Best local Qwen quality in this stack, with the heaviest memory footprint.",
            },
        }
        self.lock = threading.RLock()
        self.proc = None
        self.switch_thread = None
        self.state = "starting"
        self.active_model_id = None
        self.desired_model_id = None
        self.last_error = None
        self.log_tail = deque(maxlen=120)

        initial_model_id = self._pick_initial_model_id()
        if initial_model_id is None:
            self.state = "error"
            self.last_error = (
                "No configured Qwen model can be safely loaded with the current memory "
                "budget. Lower context sizes or disable LLAMACPP_NO_MMAP/LLAMACPP_MLOCK."
            )
        else:
            self._start_switch_locked(initial_model_id)

    def _pick_initial_model_id(self):
        if self._is_selectable(self.default_model_id):
            return self.default_model_id
        for model_id in self.models:
            if self._is_selectable(model_id):
                return model_id
        return None

    def _is_available(self, model_id: str) -> bool:
        model = self.models.get(model_id)
        return bool(model) and Path(model["path"]).is_file()

    def _bytes_to_mib(self, value: int | None) -> int | None:
        if value is None:
            return None
        return max(1, (value + MIB - 1) // MIB)

    def _runtime_memory_mode(self) -> str:
        flags = []
        if self.no_mmap:
            flags.append("--no-mmap")
        if self.mlock:
            flags.append("--mlock")
        return " ".join(flags) if flags else "default mmap"

    def _read_int_file(self, path: Path) -> int | None:
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        if not raw or raw == "max":
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    def _read_meminfo(self) -> dict[str, int]:
        info = {}
        try:
            with open("/proc/meminfo", encoding="utf-8") as handle:
                for raw_line in handle:
                    name, _, rest = raw_line.partition(":")
                    if name not in {"MemTotal", "MemAvailable"}:
                        continue
                    parts = rest.strip().split()
                    if not parts:
                        continue
                    info[name] = int(parts[0]) * 1024
        except OSError:
            return {}
        return info

    def _read_cgroup_limit_bytes(self) -> int | None:
        candidates = (
            Path("/sys/fs/cgroup/memory.max"),
            Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        )
        for path in candidates:
            limit = self._read_int_file(path)
            if limit is None or limit <= 0 or limit >= 1 << 60:
                continue
            return limit
        return None

    def _read_cgroup_available_bytes(self, limit_bytes: int | None) -> int | None:
        if limit_bytes is None:
            return None
        usage_candidates = (
            Path("/sys/fs/cgroup/memory.current"),
            Path("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
        )
        for path in usage_candidates:
            usage = self._read_int_file(path)
            if usage is None:
                continue
            return max(0, limit_bytes - usage)
        return None

    def _memory_snapshot(self) -> dict[str, int | None]:
        meminfo = self._read_meminfo()
        host_total = meminfo.get("MemTotal")
        host_available = meminfo.get("MemAvailable")
        cgroup_limit = self._read_cgroup_limit_bytes()
        cgroup_available = self._read_cgroup_available_bytes(cgroup_limit)

        total_bytes = host_total
        if total_bytes is None:
            total_bytes = cgroup_limit
        elif cgroup_limit is not None:
            total_bytes = min(total_bytes, cgroup_limit)

        available_candidates = [value for value in (host_available, cgroup_available) if value is not None]
        if available_candidates:
            available_bytes = min(available_candidates)
        else:
            available_bytes = host_available if host_available is not None else cgroup_available

        return {
            "total_bytes": total_bytes,
            "available_bytes": available_bytes,
        }

    def _estimate_model_ram_bytes(self, model_id: str) -> int | None:
        model = self.models.get(model_id)
        if not model:
            return None
        model_path = Path(model["path"])
        if not model_path.is_file():
            return None

        multiplier_pct = 110
        if self.no_mmap:
            multiplier_pct += 35
        if self.mlock:
            multiplier_pct += 10

        model_bytes = model_path.stat().st_size
        weighted_model_bytes = (model_bytes * multiplier_pct + 99) // 100
        context_bytes = model["context_length"] * self.context_overhead_per_token_kib * 1024
        fixed_overhead_bytes = self.runtime_overhead_mib * MIB
        return weighted_model_bytes + context_bytes + fixed_overhead_bytes

    def _model_loadability(
        self,
        model_id: str,
        memory_snapshot: dict[str, int | None] | None = None,
    ) -> tuple[bool, str | None, int | None, int | None]:
        if not self._is_available(model_id):
            return False, "Model file not found.", None, None

        estimated_ram_bytes = self._estimate_model_ram_bytes(model_id)
        if estimated_ram_bytes is None:
            return False, "Could not inspect the model file.", None, None

        required_free_bytes = estimated_ram_bytes + self.memory_guard_headroom_mib * MIB
        if not self.memory_guard_enabled:
            return True, None, estimated_ram_bytes, required_free_bytes

        snapshot = memory_snapshot or self._memory_snapshot()
        total_bytes = snapshot.get("total_bytes")
        available_bytes = snapshot.get("available_bytes")
        mode = self._runtime_memory_mode()

        if total_bytes is not None and required_free_bytes > total_bytes:
            return (
                False,
                (
                    f"Needs about {self._bytes_to_mib(required_free_bytes)} MiB total RAM "
                    f"including safety headroom with {mode}; host limit is "
                    f"{self._bytes_to_mib(total_bytes)} MiB."
                ),
                estimated_ram_bytes,
                required_free_bytes,
            )
        if available_bytes is not None and estimated_ram_bytes > available_bytes:
            return (
                False,
                (
                    f"Needs about {self._bytes_to_mib(estimated_ram_bytes)} MiB free before "
                    f"loading with {mode}; only {self._bytes_to_mib(available_bytes)} MiB "
                    "is available right now."
                ),
                estimated_ram_bytes,
                required_free_bytes,
            )
        return True, None, estimated_ram_bytes, required_free_bytes

    def _is_selectable(self, model_id: str) -> bool:
        selectable, _, _, _ = self._model_loadability(model_id)
        return selectable

    def _model_view(self, model_id: str, memory_snapshot: dict[str, int | None] | None = None):
        model = self.models[model_id]
        selectable, reason, estimated_ram_bytes, required_free_bytes = self._model_loadability(
            model_id,
            memory_snapshot,
        )
        return {
            "id": model["id"],
            "label": model["label"],
            "filename": Path(model["path"]).name,
            "context_length": model["context_length"],
            "description": model["description"],
            "available": self._is_available(model_id),
            "selectable": selectable,
            "availability_reason": reason,
            "estimated_ram_mib": self._bytes_to_mib(estimated_ram_bytes),
            "required_free_ram_mib": self._bytes_to_mib(required_free_bytes),
        }

    def _refresh_state_locked(self) -> None:
        if self.proc is not None and self.proc.poll() is not None:
            if self.state != "loading":
                self.state = "error"
            self.last_error = f"llama-server exited with code {self.proc.returncode}"
            self.proc = None
            self.active_model_id = None

    def get_status(self):
        with self.lock:
            self._refresh_state_locked()
            memory_snapshot = self._memory_snapshot()
            return {
                "state": self.state,
                "active_model_id": self.active_model_id,
                "desired_model_id": self.desired_model_id,
                "last_error": self.last_error,
                "models": [self._model_view(model_id, memory_snapshot) for model_id in self.models],
            }

    def select_model(self, model_id: str):
        with self.lock:
            self._refresh_state_locked()
            if model_id not in self.models:
                raise ValueError(f"Unknown model_id: {model_id}")
            if self.state == "loading":
                if self.desired_model_id == model_id:
                    return self.get_status()
                raise RuntimeError("Another model switch is already in progress.")
            if self.state == "ready" and self.active_model_id == model_id:
                self.desired_model_id = model_id
                return self.get_status()
            selectable, reason, _, _ = self._model_loadability(model_id)
            if not selectable:
                raise ValueError(reason or f"Model {model_id} is not selectable right now.")
            self._start_switch_locked(model_id)
            return self.get_status()

    def _start_switch_locked(self, model_id: str) -> None:
        self.state = "loading"
        self.active_model_id = None
        self.desired_model_id = model_id
        self.last_error = None
        self.switch_thread = threading.Thread(
            target=self._switch_worker,
            args=(model_id,),
            daemon=True,
        )
        self.switch_thread.start()

    def _switch_worker(self, model_id: str) -> None:
        model = self.models[model_id]
        try:
            self._terminate_current_process()
            selectable, reason, _, _ = self._model_loadability(model_id)
            if not selectable:
                raise RuntimeError(reason or f"Model {model_id} is not selectable right now.")
            command = [
                "llama-server",
                "-m",
                model["path"],
                "--host",
                self.internal_host,
                "--port",
                str(self.internal_port),
                "-c",
                str(model["context_length"]),
                "-ngl",
                str(self.ngl),
            ]
            if self.no_mmap:
                command.append("--no-mmap")
            if self.mlock:
                command.append("--mlock")

            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            with self.lock:
                self.proc = proc
                self.log_tail.append(f"starting {' '.join(command)}")

            threading.Thread(
                target=self._drain_logs,
                args=(proc,),
                daemon=True,
            ).start()
            self._wait_until_ready(proc)

            with self.lock:
                if self.proc is proc:
                    self.state = "ready"
                    self.active_model_id = model_id
                    self.desired_model_id = model_id
                    self.last_error = None
        except Exception as exc:
            self._terminate_current_process()
            with self.lock:
                self.state = "error"
                self.active_model_id = None
                self.last_error = str(exc)

    def _terminate_current_process(self) -> None:
        with self.lock:
            proc = self.proc
            self.proc = None
            self.active_model_id = None
        if proc is None:
            return
        if proc.poll() is not None:
            return
        proc.terminate()
        deadline = time.time() + self.stop_timeout_secs
        while time.time() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.25)
        proc.kill()
        proc.wait(timeout=5)

    def _drain_logs(self, proc: subprocess.Popen) -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            text = line.rstrip()
            if not text:
                continue
            with self.lock:
                self.log_tail.append(text)

    def _wait_until_ready(self, proc: subprocess.Popen) -> None:
        deadline = time.time() + self.readiness_timeout_secs
        health_url = f"http://127.0.0.1:{self.internal_port}/health"
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"llama-server exited with code {proc.returncode}")
            try:
                with urllib.request.urlopen(health_url, timeout=2.0) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(1.0)
        raise RuntimeError("Timed out while waiting for llama-server to become ready")


MANAGER = LlamaQwenManager()


class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._json_response(200, {"status": "ok", **MANAGER.get_status()})
            return
        if self.path == "/v1/status":
            self._json_response(200, MANAGER.get_status())
            return
        self._json_response(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/models/select":
            self._json_response(404, {"error": "not found"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
            model_id = str(payload.get("model_id", "")).strip()
            if not model_id:
                raise ValueError("model_id is required")
            status = MANAGER.select_model(model_id)
            response_code = 200 if status["state"] == "ready" else 202
            self._json_response(response_code, status)
        except ValueError as exc:
            self._json_response(400, {"error": str(exc), **MANAGER.get_status()})
        except RuntimeError as exc:
            self._json_response(409, {"error": str(exc), **MANAGER.get_status()})
        except json.JSONDecodeError:
            self._json_response(400, {"error": "invalid json", **MANAGER.get_status()})

    def log_message(self, format: str, *args) -> None:
        return

    def _json_response(self, status_code: int, payload) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    server = ThreadingHTTPServer((MANAGER.manager_host, MANAGER.manager_port), RequestHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
