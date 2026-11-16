#!/usr/bin/env python3
"""Omarchy Server connector: joins this Linux computer to an Omarchy Server's local swarm.

It dials out to the server (wss://, trusting only that server's own certificate authority), so this
computer opens no ports. It runs as you (a systemd user service), never as root.

What it does, each only if allowed when it was installed (see ABILITIES in its config, which the
server can't widen):
  watch     always: CPU, memory, disks, temperature, uptime, updates waiting
  terminal  a shell, as you
  desktop   your screen (wayvnc on Hyprland/Sway and other wlroots desktops, x11vnc on X11),
            shared only through a private socket in your runtime folder
  manage    a short fixed list: Omarchy plugins (verified, pinned), Omarchy theme, restart

Standard library only, so it runs on any distribution with Python 3.8+.
"""
import base64
import fcntl
import hashlib
import json
import os
import pty
import pwd
import re
import select
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1"
CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "omarchy-connector")
CONFIG = os.path.join(CONFIG_DIR, "config.json")
CA_FILE = os.path.join(CONFIG_DIR, "server-ca.crt")
RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
VNC_SOCK = os.path.join(RUNTIME, "omarchy-connector", "vnc.sock")


def log(*a):
    print("[connector]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------
# A small WebSocket client (RFC 6455), enough for this: text and binary frames, ping/pong, close.
class WS:
    def __init__(self, url, headers, cafile):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "wss":
            raise ValueError("The server address must start with https://")
        host, port = u.hostname, u.port or 443
        ctx = ssl.create_default_context(cafile=cafile)
        # Trust only this server's own certificate authority (pinned when installing). Its
        # certificate names the server's addresses, which can change, so the name isn't checked:
        # the private authority is what proves it's your server.
        ctx.check_hostname = False
        raw = socket.create_connection((host, port), timeout=20)
        self.sock = ctx.wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        req = [f"GET {path} HTTP/1.1", f"Host: {u.netloc}", "Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        req += [f"{k}: {v}" for k, v in headers.items()]
        self.sock.sendall(("\r\n".join(req) + "\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("The server closed the connection")
            resp += chunk
        head, self.buf = resp.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status + " ":
            raise PermissionError(status) if " 401" in status else ConnectionError(status)
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if accept.encode() not in head:
            raise ConnectionError("Bad handshake")
        self.sock.settimeout(None)
        self.lock = threading.Lock()

    def _send(self, opcode, data):
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data)) if n < 4096 else _xor(data, mask)
        with self.lock:
            self.sock.sendall(head + mask + body)

    def send_text(self, s):
        self._send(0x1, s.encode())

    def send_binary(self, b):
        self._send(0x2, b)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("Connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Returns (opcode, payload) for text (1) and binary (2); handles ping and close."""
        message, first_op = b"", None
        while True:
            b1, b2 = self._read(2)
            fin, op, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = _xor(data, mask)
            if op == 0x9:
                self._send(0xA, data)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                raise ConnectionError("Closed by the server")
            if op in (0x1, 0x2):
                first_op, message = op, data
            elif op == 0x0:
                message += data
            if fin:
                return first_op, message

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _xor(data, mask):
    # Fast XOR via int arithmetic (no numpy): repeat the mask to the data's length.
    n = len(data)
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big") if n else b""


# ---------------------------------------------------------------------------------------------
# Facts about this computer.
def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def os_release():
    out = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v.strip().strip('"')
    return out


def package_manager():
    for name in ("apt", "dnf", "pacman", "zypper"):
        if shutil.which(name if name != "apt" else "apt-get"):
            return name
    return ""


def update_command(pkg, omarchy):
    if omarchy:
        return "omarchy update"
    return {"apt": "sudo apt update && sudo apt upgrade", "dnf": "sudo dnf upgrade --refresh", "pacman": "sudo pacman -Syu", "zypper": "sudo zypper update"}.get(pkg, "")


def omarchy_facts():
    if not shutil.which("omarchy"):
        return {"omarchy": False}
    plugins = []
    pdir = os.path.expanduser("~/.config/omarchy/plugins")
    for name in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
        if name.startswith("."):
            continue
        try:
            with open(os.path.join(pdir, name, "manifest.json")) as f:
                plugins.append(str(json.load(f).get("id") or name))
        except (OSError, ValueError):
            plugins.append(name)
    themes = []
    if shutil.which("omarchy-theme-list"):
        try:
            themes = [t for t in subprocess.run(["omarchy-theme-list"], capture_output=True, text=True, timeout=10).stdout.splitlines() if t.strip()]
        except (OSError, subprocess.SubprocessError):
            pass
    theme = read(os.path.expanduser("~/.local/state/omarchy/current/theme.name")).strip()
    return {"omarchy": True, "plugins": plugins, "themes": themes, "theme": theme}


def info():
    rel = os_release()
    pkg = package_manager()
    om = omarchy_facts()
    return {
        "hostname": socket.gethostname(),
        "os": rel.get("PRETTY_NAME") or rel.get("NAME") or "Linux",
        "osId": rel.get("ID", ""),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "version": VERSION,
        "pkg": pkg,
        "updateCommand": update_command(pkg, om.get("omarchy")),
        "desktop": desktop_kind(),
        **om,
    }


_cpu_last = None


def cpu_percent():
    global _cpu_last
    parts = read("/proc/stat").split("\n", 1)[0].split()[1:]
    vals = [int(x) for x in parts] if parts else []
    if len(vals) < 4:
        return None
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)
    last, _cpu_last = _cpu_last, (idle, total)
    if not last or total == last[1]:
        return None
    return round(100 * (1 - (idle - last[0]) / (total - last[1])), 1)


def meminfo():
    m = {}
    for line in read("/proc/meminfo").splitlines():
        k, _, rest = line.partition(":")
        if rest.strip():
            m[k] = int(rest.split()[0]) * 1024
    total = m.get("MemTotal", 0)
    return {"total": total, "used": total - m.get("MemAvailable", m.get("MemFree", 0))}, {"total": m.get("SwapTotal", 0), "used": m.get("SwapTotal", 0) - m.get("SwapFree", 0)}


REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "bcachefs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs"}


def disks():
    out, seen = [], set()
    for line in read("/proc/mounts").splitlines():
        p = line.split()
        if len(p) < 3 or p[2] not in REAL_FS or p[0] in seen:
            continue
        mount = p[1].replace("\\040", " ")
        if mount.startswith(("/boot", "/snap", "/var/lib/docker", "/var/lib/containers")):
            continue
        seen.add(p[0])
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total:
            out.append({"mount": mount, "total": total, "used": total - st.f_bfree * st.f_frsize})
    return out[:12]


def temperature():
    best = None
    for base in ("/sys/class/hwmon", "/sys/class/thermal"):
        for d in os.listdir(base) if os.path.isdir(base) else []:
            path = os.path.join(base, d)
            for f in os.listdir(path) if os.path.isdir(path) else []:
                if re.fullmatch(r"temp\d*_input|temp", f):
                    try:
                        v = int(read(os.path.join(path, f)).strip()) / 1000
                    except ValueError:
                        continue
                    if 0 < v < 130:
                        best = v if best is None else max(best, v)
    return None if best is None else round(best, 1)


_updates = {"at": 0, "n": None, "busy": False}


def updates_waiting(pkg):
    """How many updates are waiting: checked in the background at most every 30 minutes (without
    root; some package managers take a minute or two), so reporting never waits for it."""
    if not _updates["busy"] and time.time() - _updates["at"] >= 1800:
        _updates["busy"], _updates["at"] = True, time.time()
        threading.Thread(target=_check_updates, args=(pkg,), daemon=True).start()
    return _updates["n"]


def _check_updates(pkg):
    cmd = {"apt": ["apt", "list", "--upgradable"], "dnf": ["dnf", "-q", "check-update"], "pacman": ["checkupdates"] if shutil.which("checkupdates") else ["pacman", "-Qu"], "zypper": ["zypper", "-q", "lu"]}.get(pkg)
    try:
        if cmd:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            _updates["n"] = len([l for l in r.stdout.splitlines() if l.strip() and not l.startswith(("Listing", "Last metadata", "S |", "--+", "Loading", "Repository", "Obsoleting"))])
    except (OSError, subprocess.SubprocessError):
        _updates["n"] = None
    finally:
        _updates["busy"] = False


def metrics(pkg):
    mem, swap = meminfo()
    return {
        "cpu": cpu_percent(),
        "cores": os.cpu_count(),
        "load": list(os.getloadavg()),
        "mem": mem,
        "swap": swap,
        "disks": disks(),
        "temp": temperature(),
        "uptime": float(read("/proc/uptime", "0").split()[0] or 0),
        "updates": updates_waiting(pkg),
    }


# ---------------------------------------------------------------------------------------------
# Desktop: which kind this computer has, and a VNC server on a private socket when one is shown.
def _hypr_signature():
    d = os.path.join(RUNTIME, "hypr")
    sigs = sorted(os.listdir(d), key=lambda s: os.path.getmtime(os.path.join(d, s)), reverse=True) if os.path.isdir(d) else []
    return sigs[0] if sigs else None


def _wayland_display():
    socks = sorted(f for f in os.listdir(RUNTIME) if re.fullmatch(r"wayland-\d+", f)) if os.path.isdir(RUNTIME) else []
    return socks[0] if socks else None


def _x_display():
    xs = sorted(f for f in os.listdir("/tmp/.X11-unix") if re.fullmatch(r"X\d+", f)) if os.path.isdir("/tmp/.X11-unix") else []
    for x in xs:
        try:
            if os.stat(os.path.join("/tmp/.X11-unix", x)).st_uid in (os.getuid(), 0):
                return ":" + x[1:]
        except OSError:
            pass
    return None


def _xauthority():
    for p in [os.environ.get("XAUTHORITY"), os.path.expanduser("~/.Xauthority"), os.path.join(RUNTIME, "gdm", "Xauthority")]:
        if p and os.path.exists(p):
            return p
    for f in os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []:
        if f.startswith("xauth_"):
            return os.path.join(RUNTIME, f)
    return None


def desktop_kind():
    wl = _wayland_display()
    wlroots = _hypr_signature() or any(f.startswith("sway-ipc.") for f in (os.listdir(RUNTIME) if os.path.isdir(RUNTIME) else []))
    if wl and wlroots:
        return {"kind": "wlroots", "ok": bool(shutil.which("wayvnc")), "why": "" if shutil.which("wayvnc") else "wayvnc isn’t installed. Run the connector installer again with the desktop switched on."}
    if wl:
        return {"kind": "wayland", "ok": False, "why": "This desktop (GNOME or KDE on Wayland) can’t be shared yet. Sign in with an X11 session, or use Hyprland or Sway."}
    if _x_display():
        return {"kind": "x11", "ok": bool(shutil.which("x11vnc")), "why": "" if shutil.which("x11vnc") else "x11vnc isn’t installed. Run the connector installer again with the desktop switched on."}
    return {"kind": "none", "ok": False, "why": "Nobody is signed in to a desktop on this computer."}


_vnc = {"proc": None, "users": 0, "stop_at": None}
_vnc_lock = threading.Lock()


def vnc_start():
    with _vnc_lock:
        if _vnc["proc"] and _vnc["proc"].poll() is None and os.path.exists(VNC_SOCK):
            _vnc["users"] += 1
            return
        d = desktop_kind()
        if not d["ok"]:
            raise RuntimeError(d["why"])
        os.makedirs(os.path.dirname(VNC_SOCK), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(VNC_SOCK), 0o700)
        if os.path.exists(VNC_SOCK):
            os.unlink(VNC_SOCK)
        env = dict(os.environ, XDG_RUNTIME_DIR=RUNTIME)
        if d["kind"] == "wlroots":
            env["WAYLAND_DISPLAY"] = _wayland_display()
            sig = _hypr_signature()
            if sig:
                env["HYPRLAND_INSTANCE_SIGNATURE"] = sig
            cmd = ["wayvnc", "--max-fps=30", "--unix-socket", VNC_SOCK]
        else:
            env["DISPLAY"] = _x_display()
            auth = _xauthority()
            cmd = ["x11vnc", "-display", env["DISPLAY"], "-unixsock", VNC_SOCK, "-rfbport", "0", "-forever", "-shared", "-nopw", "-quiet", "-noxdamage"]
            if auth:
                cmd[3:3] = ["-auth", auth]
        _vnc["proc"] = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(50):
            if os.path.exists(VNC_SOCK):
                break
            if _vnc["proc"].poll() is not None:
                raise RuntimeError("The screen sharing program stopped straight away.")
            time.sleep(0.1)
        else:
            raise RuntimeError("The screen sharing program didn’t start.")
        _vnc["users"] = 1


def vnc_release():
    with _vnc_lock:
        _vnc["users"] = max(0, _vnc["users"] - 1)
        if _vnc["users"] == 0 and _vnc["proc"]:
            p, _vnc["proc"] = _vnc["proc"], None
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass


# ---------------------------------------------------------------------------------------------
# Channels: a shell or the screen, joined to the server by a channel number.
class Channel:
    def __init__(self, conn, ch):
        self.conn, self.ch, self.closed = conn, ch, False
        self.head = struct.pack(">I", ch)

    def out(self, data):
        try:
            self.conn.ws.send_binary(self.head + data)
        except OSError:
            self.close()

    def ended(self, reason="", code=1000):
        if not self.closed:
            self.close()
            self.conn.send({"op": "closed", "ch": self.ch, "reason": reason, "code": code})


class Shell(Channel):
    def __init__(self, conn, ch, cols, rows):
        super().__init__(conn, ch)
        me = pwd.getpwuid(os.getuid())
        shell = me.pw_shell if me.pw_shell and os.path.exists(me.pw_shell) else "/bin/bash"
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(me.pw_dir)
            env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", HOME=me.pw_dir, SHELL=shell, USER=me.pw_name, LANG=os.environ.get("LANG") or "C.UTF-8")
            os.execvpe(shell, [shell, "-l"], env)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(4, int(rows or 24)), max(10, int(cols or 80)), 0, 0))
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while not self.closed:
            try:
                r, _, _ = select.select([self.fd], [], [], 1)
                if r:
                    data = os.read(self.fd, 65536)
                    if not data:
                        break
                    self.out(data)
            except OSError:
                break
        self.ended("Shell ended")

    def write(self, data):
        try:
            os.write(self.fd, data)
        except OSError:
            self.ended("Shell ended")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except OSError:
            pass


class Screen(Channel):
    def __init__(self, conn, ch):
        super().__init__(conn, ch)
        vnc_start()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.connect(VNC_SOCK)
        except OSError:
            vnc_release()
            raise
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while not self.closed:
            try:
                data = self.sock.recv(65536)
            except OSError:
                break
            if not data:
                break
            self.out(data)
        self.ended("The screen sharing ended")

    def write(self, data):
        try:
            self.sock.sendall(data)
        except OSError:
            self.ended("The screen sharing ended")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass
        vnc_release()


# ---------------------------------------------------------------------------------------------
# Manage: the only things the server can ask for (there is no "run this command").
PLUGIN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
REPO = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA = re.compile(r"^[0-9a-f]{40}$")
THEME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$")


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 300), **kw)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or f"{cmd[0]} failed").strip().splitlines()[-1][:300])
    return r.stdout


def plugin_install(args):
    pid, repo, commit = str(args.get("id", "")), str(args.get("repo", "")), str(args.get("commit", ""))
    if not (PLUGIN_ID.match(pid) and ".." not in pid and REPO.match(repo) and SHA.match(commit)):
        raise RuntimeError("That plugin’s details don’t look right")
    if not shutil.which("omarchy-plugin-validate"):
        raise RuntimeError("This computer’s Omarchy doesn’t support plugins yet. Update Omarchy first.")
    pdir = os.path.expanduser("~/.config/omarchy/plugins")
    os.makedirs(pdir, exist_ok=True)
    target = os.path.join(pdir, pid)
    if os.path.exists(target):
        raise RuntimeError("That plugin is already installed")
    stage = os.path.join(pdir, f".add.tmp.{os.urandom(6).hex()}")
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        if shutil.which("omarchy-git-url-check"):
            run(["omarchy-git-url-check", repo + ".git"])
        os.mkdir(stage)
        run(["git", "init", "-q"], cwd=stage, env=env)
        run(["git", "fetch", "-q", "--depth", "1", "--", repo + ".git", commit], cwd=stage, env=env)
        run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", commit], cwd=stage, env=env)
        if run(["git", "rev-parse", "HEAD"], cwd=stage).strip() != commit:
            raise RuntimeError("The plugin’s code didn’t match the verified version")
        run(["omarchy-plugin-validate", stage])
        with open(os.path.join(stage, "manifest.json")) as f:
            if json.load(f).get("id") != pid:
                raise RuntimeError("The plugin’s manifest doesn’t match its listing")
        os.rename(stage, target)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    subprocess.run(["omarchy-shell", "shell", "rescanPlugins"], capture_output=True, timeout=30)
    for _ in range(20):
        if subprocess.run(["omarchy-plugin-enable", pid], capture_output=True, timeout=30).returncode == 0:
            return True
        time.sleep(0.25)
    raise RuntimeError("Added, but it couldn’t be turned on. Turn it on from the Omarchy menu → Plugins.")


def plugin_remove(args):
    pid = str(args.get("id", ""))
    if not (PLUGIN_ID.match(pid) and ".." not in pid):
        raise RuntimeError("Unknown plugin")
    if not os.path.isdir(os.path.expanduser(f"~/.config/omarchy/plugins/{pid}")):
        raise RuntimeError("That plugin isn’t installed")
    run(["omarchy-plugin-remove", pid, "--yes"])
    return True


def theme_set(args):
    name = str(args.get("name", ""))
    if not THEME.match(name) or not shutil.which("omarchy-theme-set"):
        raise RuntimeError("That theme can’t be set here")
    run(["omarchy-theme-set", name], timeout=120)
    return True


def reboot(_args):
    run(["systemctl", "reboot"], timeout=30)
    return True


ACTIONS = {"plugin-install": plugin_install, "plugin-remove": plugin_remove, "theme-set": theme_set, "reboot": reboot}


# ---------------------------------------------------------------------------------------------
class Connection:
    def __init__(self, cfg):
        self.cfg = cfg
        self.allowed = cfg.get("abilities", {})
        self.channels = {}
        self.ws = None
        self.pkg = package_manager()

    def send(self, msg):
        try:
            self.ws.send_text(json.dumps(msg))
        except (OSError, AttributeError):
            pass

    def run(self):
        url = self.cfg["server"].replace("https://", "wss://", 1).rstrip("/") + "/connector/ws"
        self.ws = WS(url, {"Authorization": f"Bearer {self.cfg['id']}:{self.cfg['key']}", "User-Agent": f"omarchy-connector/{VERSION}"}, CA_FILE)
        log("connected to", self.cfg["server"])
        self.send({"op": "hello", "info": info(), "abilities": self.allowed})
        stop = threading.Event()

        def report():
            cpu_percent()
            while not stop.wait(10):
                self.send({"op": "metrics", "metrics": metrics(self.pkg)})
                # Facts change now and then (plugins, theme, a desktop session starting).
                if int(time.time()) % 300 < 10:
                    self.send({"op": "hello", "info": info(), "abilities": self.allowed})

        threading.Thread(target=report, daemon=True).start()
        self.send({"op": "metrics", "metrics": metrics(self.pkg)})
        try:
            while True:
                op, data = self.ws.recv()
                if op == 0x2:
                    if len(data) >= 4:
                        ch = self.channels.get(struct.unpack(">I", data[:4])[0])
                        if ch:
                            ch.write(data[4:])
                    continue
                self.handle(json.loads(data))
        finally:
            stop.set()
            for ch in list(self.channels.values()):
                ch.close()
            self.channels.clear()
            self.ws.close()

    def handle(self, msg):
        op = msg.get("op")
        if op == "open":
            ch = int(msg.get("ch", 0))
            kind = msg.get("kind")
            ability = "terminal" if kind == "pty" else "desktop" if kind == "vnc" else None
            if not ability or not self.allowed.get(ability):
                return self.send({"op": "closed", "ch": ch, "code": 1011, "reason": f"This computer doesn’t allow the {ability or 'that'}"})
            try:
                self.channels[ch] = Shell(self, ch, msg.get("cols"), msg.get("rows")) if kind == "pty" else Screen(self, ch)
            except Exception as e:  # noqa: BLE001 - said back to the person, in plain words
                self.send({"op": "closed", "ch": ch, "code": 1011, "reason": str(e)[:200]})
        elif op == "close":
            ch = self.channels.pop(int(msg.get("ch", 0)), None)
            if ch:
                ch.close()
        elif op == "call":
            threading.Thread(target=self.call, args=(msg,), daemon=True).start()
        elif op == "removed":
            log("removed from the server's swarm: stopping for good")
            forget()

    def call(self, msg):
        name = msg.get("name")
        try:
            if not self.allowed.get("manage"):
                raise RuntimeError("This computer doesn’t allow managing")
            fn = ACTIONS.get(name)
            if not fn:
                raise RuntimeError("Unknown action")
            data = fn(msg.get("args") or {})
            self.send({"op": "result", "id": msg.get("id"), "ok": True, "data": data})
            if name in ("plugin-install", "plugin-remove", "theme-set"):
                self.send({"op": "hello", "info": info(), "abilities": self.allowed})
        except Exception as e:  # noqa: BLE001
            self.send({"op": "result", "id": msg.get("id"), "ok": False, "error": str(e)[:300]})


def forget():
    try:
        os.unlink(CONFIG)
    except OSError:
        pass
    subprocess.run(["systemctl", "--user", "disable", "omarchy-connector.service"], capture_output=True)
    os._exit(0)


# ---------------------------------------------------------------------------------------------
def enroll(server, token, abilities):
    body = json.dumps({"token": token, "info": info(), "abilities": abilities}).encode()
    ctx = ssl.create_default_context(cafile=CA_FILE)
    ctx.check_hostname = False
    req = urllib.request.Request(server.rstrip("/") + "/connector/enroll", data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            raise SystemExit(json.load(e).get("error") or f"The server said {e.code}")
        except ValueError:
            raise SystemExit(f"The server said {e.code}")


def main():
    args = sys.argv[1:]
    if args[:1] == ["enroll"]:
        server, token = args[1], args[2]
        abilities = {k: k in args[3].split(",") for k in ("terminal", "desktop", "manage")} if len(args) > 3 else {}
        r = enroll(server, token, abilities)
        os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
        cfg = {"server": server, "id": r["id"], "key": r["key"], "abilities": abilities}
        fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f)
        print(r.get("name", ""))
        return
    if args[:1] == ["info"]:
        print(json.dumps({"info": info(), "metrics": metrics(package_manager())}, indent=2))
        return
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        sys.exit("Not joined to a server yet. Run the install command from Machines → Local swarm → Add a computer.")
    delay = 2
    while True:
        try:
            Connection(cfg).run()
            delay = 2
        except PermissionError:
            # The server doesn't know this computer any more (removed from the swarm).
            log("the server refused this computer's key; it was removed from the swarm")
            forget()
        except Exception as e:  # noqa: BLE001
            log("connection:", e)
        time.sleep(delay)
        delay = min(60, delay * 2)


if __name__ == "__main__":
    main()
