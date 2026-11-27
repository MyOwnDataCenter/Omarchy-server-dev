#!/usr/bin/env python3
"""Restic password files (backup-*) must not outlive a stop, a swarm removal, or the next start.

Safe on a desktop: restic is a stand-in, forget() never reaches systemctl or os._exit,
and the startup check runs the connector against temp XDG directories.
"""
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

CONNECTOR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "connector"))
sys.path.insert(0, CONNECTOR)
import agent  # noqa: E402


def _names(path):
    try:
        return set(os.listdir(path))
    except OSError:
        return set()


def _write(path, text):
    with open(path, "w") as f:
        f.write(text)


class BackupPasswordFiles(unittest.TestCase):
    def setUp(self):
        self._runtime = agent.RUNTIME
        self._data = agent.DATA_DIR
        self._config = agent.CONFIG
        self._exit = os._exit
        self._run = subprocess.run

    def tearDown(self):
        agent.RUNTIME = self._runtime
        agent.DATA_DIR = self._data
        agent.CONFIG = self._config
        os._exit = self._exit
        subprocess.run = self._run

    def test_sigterm_during_run_restic_deletes_password_file(self):
        root = tempfile.mkdtemp(prefix="restic-pw-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        runtime = os.path.join(root, "run")
        os.makedirs(runtime)
        standin = os.path.join(root, "bin")
        os.makedirs(standin)
        ready = os.path.join(root, "ready")
        script = textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import sys, time
            if sys.argv[1:2] == ["version"]:
                sys.stdout.write("restic 0.18.1\\n")
                sys.stdout.flush()
                raise SystemExit(0)
            open({ready!r}, "w").close()
            time.sleep(60)
            """
        )
        restic = os.path.join(standin, "restic")
        _write(restic, script)
        os.chmod(restic, stat.S_IRWXU)
        env = os.environ.copy()
        env["PATH"] = standin + os.pathsep + env.get("PATH", "")
        env["XDG_RUNTIME_DIR"] = runtime
        env["XDG_DATA_HOME"] = os.path.join(root, "share")
        proc = subprocess.Popen(
            [sys.executable, __file__, "--child", runtime, standin],
            env=env,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        err = b""
        try:
            deadline = time.time() + 10
            pwdir = os.path.join(runtime, "omarchy-connector")
            while time.time() < deadline:
                if proc.poll() is not None:
                    err = proc.stderr.read()
                    self.fail(f"child exited early ({proc.returncode}): {err.decode(errors='replace')}")
                if os.path.exists(ready) and any(n.startswith("backup-") for n in _names(pwdir)):
                    break
                time.sleep(0.05)
            else:
                err = b""
                self.fail("timed out waiting for the password file and restic stand-in")
            os.kill(proc.pid, signal.SIGTERM)
            try:
                err = proc.communicate(timeout=10)[1]
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                err = proc.communicate()[1]
                self.fail(f"child did not exit after SIGTERM: {err.decode(errors='replace')}")
            self.assertEqual(proc.returncode, 0, err.decode(errors="replace"))
            self.assertEqual([n for n in _names(pwdir) if n.startswith("backup-")], [])
        finally:
            # The stand-in stays in this session after the child exits. Don't leave it sleeping.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                pass

    def test_forget_deletes_password_files_before_exit(self):
        root = tempfile.mkdtemp(prefix="restic-forget-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        runtime = os.path.join(root, "run")
        data = os.path.join(root, "data")
        pwdir = os.path.join(runtime, "omarchy-connector")
        os.makedirs(pwdir)
        os.makedirs(data)
        _write(os.path.join(pwdir, "backup-aaa"), "secret-one")
        _write(os.path.join(pwdir, "backup-bbb"), "secret-two")
        _write(os.path.join(pwdir, "vnc.sock"), "keep")
        _write(os.path.join(data, "backup-other"), "not-this-dir")
        cfg = os.path.join(root, "config.json")
        _write(cfg, "{}")
        agent.RUNTIME = runtime
        agent.DATA_DIR = data
        agent.CONFIG = cfg
        exited = []
        calls = []

        def fake_exit(code):
            exited.append(code)

        def fake_run(args, **_kwargs):
            calls.append(list(args))

        # forget() disables the user unit and then os._exit. Never let that reach this machine.
        os._exit = fake_exit
        subprocess.run = fake_run
        self.assertIs(os._exit, fake_exit)
        agent.forget()
        self.assertEqual(exited, [0])
        self.assertEqual(calls, [["systemctl", "--user", "disable", "--now", "--no-block", "omarchy-connector.service"]])
        self.assertEqual(_names(pwdir), {"vnc.sock"})
        self.assertFalse(os.path.exists(cfg))
        self.assertTrue(os.path.exists(os.path.join(data, "backup-other")))

    def test_startup_sweep_deletes_stale_password_files(self):
        root = tempfile.mkdtemp(prefix="restic-sweep-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        runtime = os.path.join(root, "run")
        pwdir = os.path.join(runtime, "omarchy-connector")
        os.makedirs(pwdir)
        _write(os.path.join(pwdir, "backup-stale"), "secret")
        _write(os.path.join(pwdir, "vnc.sock"), "keep")
        agent.RUNTIME = runtime
        agent._backup_password_dir(True)
        self.assertEqual(_names(pwdir), {"vnc.sock"})

        data = os.path.join(root, "data")
        os.makedirs(data)
        _write(os.path.join(data, "backup-stale"), "secret")
        _write(os.path.join(data, "state.json"), "keep")
        agent.RUNTIME = os.path.join(root, "not-a-directory")
        agent.DATA_DIR = data
        agent._backup_password_dir(True)
        self.assertEqual(_names(data), {"state.json"})

    def test_connector_start_sweeps_password_file(self):
        root = tempfile.mkdtemp(prefix="restic-main-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        runtime = os.path.join(root, "run")
        config_home = os.path.join(root, ".config")
        conf = os.path.join(config_home, "omarchy-connector")
        data = os.path.join(root, ".local", "share")
        os.makedirs(runtime)
        os.makedirs(conf)
        os.makedirs(data)
        pwdir = os.path.join(runtime, "omarchy-connector")
        os.makedirs(pwdir)
        _write(os.path.join(pwdir, "backup-stale"), "secret")
        _write(os.path.join(pwdir, "vnc.sock"), "keep")
        with open(os.path.join(conf, "config.json"), "w") as f:
            json.dump({"server": "https://127.0.0.1:9", "id": "abc", "key": "def", "abilities": {}}, f)
        env = os.environ.copy()
        env.update({
            "HOME": root,
            "XDG_CONFIG_HOME": config_home,
            "XDG_DATA_HOME": data,
            "XDG_RUNTIME_DIR": runtime,
        })
        proc = subprocess.Popen(
            [sys.executable, os.path.join(CONNECTOR, "agent.py")],
            env=env,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            deadline = time.time() + 5
            while time.time() < deadline and "backup-stale" in _names(pwdir):
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
            names = _names(pwdir)
            err = b""
            if "backup-stale" in names and proc.poll() is not None:
                err = proc.stderr.read()
            self.assertNotIn("backup-stale", names, err.decode(errors="replace"))
            self.assertIn("vnc.sock", names)
        finally:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
            try:
                proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                proc.communicate()


def _child(runtime, standin):
    os.environ["PATH"] = standin + os.pathsep + os.environ.get("PATH", "")
    os.environ["XDG_RUNTIME_DIR"] = runtime
    import importlib
    importlib.reload(agent)
    agent.RUNTIME = runtime
    found = __import__("shutil").which("restic")
    if not found or os.path.dirname(found) != standin:
        sys.stderr.write(f"refusing real restic: {found}\n")
        sys.exit(2)

    class Conn:
        def send(self, _msg):
            pass

    agent._run_restic(Conn(), "1", ["backup", "--json"], "rest:http://127.0.0.1/unused", "secret-password", "Backing up")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--child":
        _child(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
