"""The cas tool, hosted: POST {code, prelude, timeoutMs} -> {ok, text}. Called by the Node app (lib/tools.mjs).

Claude writes the code, so it runs in a child process with a clean environment, resource limits and, where the
kernel allows it, no network (a fresh network namespace). The caller must send Authorization: Bearer
<HW_INTERNAL_TOKEN>.
"""
import ctypes
import hmac
import json
import importlib.util
import os
import resource
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler

TOKEN = os.environ.get("HW_INTERNAL_TOKEN", "")
MAX_OUT = 60000

# Keep a same-user child from reading this process's environment through /proc/<pid>/environ.
try:
    ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 0
except Exception:
    pass


def _limits(timeout_s, isolate):
    def run():
        for lim, v in ((resource.RLIMIT_CPU, timeout_s + 1), (resource.RLIMIT_AS, 1 << 30), (resource.RLIMIT_FSIZE, 16 << 20)):
            try:
                resource.setrlimit(lim, (v, v))
            except (ValueError, OSError):
                pass
        if isolate:
            os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
    return run


def _can_isolate():
    try:
        r = subprocess.run([sys.executable, "-c", "import os; os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)"], env={}, timeout=10, capture_output=True)
        return r.returncode == 0
    except Exception:
        return False


ISOLATE = None


def _libpath():
    # Where sympy and mpmath actually live (on Vercel, the function's vendored folder, not a site-packages dir),
    # then the interpreter's own entries. The child gets a clean env, so it needs these spelled out.
    out = []
    for mod in ("sympy", "mpmath"):
        try:
            spec = importlib.util.find_spec(mod)
            if spec and spec.origin: out.append(os.path.dirname(os.path.dirname(spec.origin)))
        except Exception:
            pass
    out += [p for p in sys.path if p and os.path.isdir(p)]
    return list(dict.fromkeys(out))


def run_cas(code, prelude, timeout_ms):
    global ISOLATE
    if ISOLATE is None:
        ISOLATE = _can_isolate()
    timeout_s = max(1, min(60, int(timeout_ms / 1000)))
    with tempfile.TemporaryDirectory(prefix="hw-cas-") as d:
        with open(os.path.join(d, "main.py"), "w") as f:
            f.write(code)
        with open(os.path.join(d, "run.py"), "w") as f:
            f.write(prelude)
        site = _libpath()
        env = {"PATH": "/usr/bin:/bin", "HOME": d, "MPLBACKEND": "Agg", "PYTHONPATH": os.pathsep.join(site)}
        killed = False
        try:
            p = subprocess.run([sys.executable, "-B", "run.py"], cwd=d, env=env, capture_output=True, timeout=timeout_s, preexec_fn=_limits(timeout_s, ISOLATE))
            out, err, rc = p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace"), p.returncode
        except subprocess.TimeoutExpired as e:
            out, err, rc, killed = (e.stdout or b"").decode(errors="replace"), (e.stderr or b"").decode(errors="replace"), -9, True
    parts = []
    if out:
        parts.append(out[:MAX_OUT].rstrip())
    if err:
        parts.append("[stderr]\n" + err[:20000].rstrip())
    if killed:
        parts.append(f"[killed after {timeout_s} s]")
    return {"ok": rc == 0 and not killed, "text": "\n".join(parts) or "(no output; use print())", "isolated": ISOLATE}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        auth = self.headers.get("authorization", "")
        if not TOKEN or not hmac.compare_digest(auth, f"Bearer {TOKEN}"):
            return self._send(401, {"ok": False, "text": "unauthorized"})
        try:
            n = int(self.headers.get("content-length") or 0)
            req = json.loads(self.rfile.read(min(n, 1 << 20)) or b"{}")
            code, prelude = req.get("code"), req.get("prelude")
            if not isinstance(code, str) or not isinstance(prelude, str):
                return self._send(400, {"ok": False, "text": "code and prelude are required"})
            return self._send(200, run_cas(code, prelude, int(req.get("timeoutMs") or 20000)))
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"ok": False, "text": f"cas service error: {e}"})

    def do_GET(self):
        self._send(405, {"ok": False, "text": "POST only"})
