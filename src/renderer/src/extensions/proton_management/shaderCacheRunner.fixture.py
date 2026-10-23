"""Disposable Linux fixtures; no Steam installation, game, account or network needed."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


RUNNER = Path(os.environ["VORTEX_SHADER_TEST_RUNNER"])
APP = "22380"
MARKER = ".vortex-steam-source.json"


@unittest.skipUnless(sys.platform == "linux", "requires Linux flock and renameat2")
class ShaderCacheRunnerTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="vortex-shader-fixture-")
        self.root = Path(self.sandbox.name)
        self.addCleanup(self.sandbox.cleanup)
        self.runner = self.root / "bin" / RUNNER.name
        self.runner.parent.mkdir()
        shutil.copyfile(RUNNER, self.runner)
        self.runner.chmod(0o755)
        self.source = self.root / "Steam library:with spaces" / "shadercache" / APP
        self.source.mkdir(parents=True)
        self.private = self.root / "private"
        self.cache = self.private / APP
        self.config = self.runner.parent / "shader-cache-settings" / (APP + ".json")
        self.config.parent.mkdir()
        self.settings()
        self.env = os.environ.copy()
        for key in list(self.env):
            if key.startswith("VORTEX_SHADER_"):
                self.env.pop(key)
        self.env["HOME"] = str(self.root / "home")

    def settings(self, private=None, sources=None):
        self.config.write_text(json.dumps({
            "privateRoot": str(private or self.private),
            "sourceRoots": [str(root) for root in (sources if sources is not None
                                                  else [self.source])],
        }), encoding="utf-8")

    def put(self, relative, content=b"steam baseline"):
        target = self.source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return target

    def invoke(self, *arguments, ok=True, env=None):
        result = subprocess.run([sys.executable, str(self.runner), *arguments],
                                env=env or self.env, text=True, capture_output=True,
                                timeout=15)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def reset(self, **kwargs):
        return self.invoke("--reset", APP, **kwargs)

    def launch(self, **kwargs):
        return self.invoke(APP, sys.executable, "-c", "pass", **kwargs)

    def marker(self):
        return json.loads((self.cache / MARKER).read_text(encoding="utf-8"))

    def snapshot(self):
        return {str(file.relative_to(self.source)): file.read_bytes()
                for file in self.source.rglob("*") if file.is_file()}

    def test_seed_unchanged_launch_reset_and_content_update(self):
        original = self.put("DXVK_state_cache/game.dxvk-cache", b"original")
        self.put("downloads/steam.foz", b"download must survive")
        before = self.snapshot()
        self.reset()
        self.assertEqual(self.marker()["appId"], APP)
        self.assertEqual(self.marker()["version"], 1)
        self.assertEqual(self.marker()["source"], str(self.source))
        copied = self.cache / "DXVK_state_cache/game.dxvk-cache"
        self.assertEqual(copied.read_bytes(), b"original")
        self.assertEqual(copied.stat().st_mtime_ns, original.stat().st_mtime_ns)
        self.assertFalse((self.cache / "downloads").exists())
        copied.write_bytes(b"private modified")
        added = self.cache / "mod-only.bin"
        added.write_bytes(b"local")
        marker_time = (self.cache / MARKER).stat().st_mtime_ns
        self.launch()
        self.launch()
        self.assertEqual(copied.read_bytes(), b"private modified")
        self.assertEqual((self.cache / MARKER).stat().st_mtime_ns, marker_time)
        self.assertTrue(added.exists())
        self.assertEqual(self.snapshot(), before)
        self.reset()
        self.assertEqual(copied.read_bytes(), b"original")
        self.assertFalse(added.exists())
        old_fingerprint = self.marker()["fingerprint"]
        previous = original.stat()
        original.write_bytes(b"newbytes")  # Same length and mtime: content hash must detect it.
        os.utime(original, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        self.launch()
        self.assertEqual(copied.read_bytes(), b"newbytes")
        self.assertNotEqual(self.marker()["fingerprint"], old_fingerprint)
        self.assertEqual((self.source / "downloads/steam.foz").read_bytes(),
                         b"download must survive")
        self.assertEqual(list(self.private.glob("." + APP + ".tmp-*")), [])

    def test_first_nonempty_source_and_json_override(self):
        self.put("downloads/only.bin")
        alternate = self.root / "second source:json" / APP
        alternate.mkdir(parents=True)
        (alternate / "baseline").write_bytes(b"second source")
        env = dict(self.env, VORTEX_SHADER_SOURCE_ROOTS_JSON=json.dumps([
            str(self.root / "missing"), str(self.source), str(alternate)]),
            VORTEX_SHADER_CACHE_ROOT=str(self.root / "override private"))
        self.reset(env=env)
        self.assertEqual((self.root / "override private" / APP / "baseline").read_bytes(),
                         b"second source")
        self.assertFalse(self.private.exists())

    def test_missing_and_empty_source_initialize_owned_empty_cache(self):
        self.settings(sources=[self.root / "missing", self.source])
        self.reset()
        self.assertEqual(list(self.cache.iterdir()), [self.cache / MARKER])
        self.assertIsNone(self.marker()["source"])
        (self.cache / "private-only").write_text("discard on reset")
        self.reset()
        self.assertFalse((self.cache / "private-only").exists())

    def test_download_changes_do_not_reseed_private_changes(self):
        self.put("baseline")
        download = self.put("downloads/payload")
        self.reset()
        (self.cache / "private-only").write_bytes(b"keep")
        marker = self.marker()
        download.write_bytes(b"download update")
        self.launch()
        self.assertEqual(self.marker(), marker)
        self.assertEqual((self.cache / "private-only").read_bytes(), b"keep")

    def test_unknown_existing_cache_is_never_deleted_even_when_empty(self):
        self.cache.mkdir(parents=True)
        self.reset(ok=False)
        precious = self.cache / "precious"
        precious.write_bytes(b"keep")
        self.reset(ok=False)
        self.assertEqual(precious.read_bytes(), b"keep")
        (self.cache / MARKER).write_text(json.dumps({"version": 1, "appId": "999",
                                                  "source": None,
                                                  "fingerprint": "0" * 64}))
        self.reset(ok=False)
        self.assertEqual(precious.read_bytes(), b"keep")

    def test_source_private_overlap_in_both_directions_is_refused(self):
        for private, source in ((self.source, self.source),
                                (self.source / "nested", self.source),
                                (self.private, self.private / "nested")):
            with self.subTest(private=private, source=source):
                self.settings(private=private, sources=[source])
                self.assertIn("overlap", self.reset(ok=False).stderr)

    def test_symlinks_inside_source_tree_and_special_files_are_refused(self):
        real = self.put("real")
        link = self.source / "link"
        link.symlink_to(real)
        self.reset(ok=False)
        self.assertFalse(self.cache.exists())
        link.unlink()
        os.mkfifo(link)
        self.reset(ok=False)  # O_NONBLOCK also prevents racing a regular file into a FIFO.
        link.unlink()
        self.assertEqual(real.read_bytes(), b"steam baseline")

    def test_configured_source_aliases_resolve_and_both_prefixes_remap(self):
        self.put("baseline")
        direct_alias = self.root / "Steam alias:client"
        direct_alias.symlink_to(self.source, target_is_directory=True)
        ancestor_alias = self.root / "Steam library alias"
        ancestor_alias.symlink_to(self.source.parent, target_is_directory=True)
        inherited_alias = ancestor_alias / APP
        self.settings(sources=[direct_alias, inherited_alias])
        unconfigured_alias = self.root / "unconfigured alias"
        unconfigured_alias.symlink_to(self.source, target_is_directory=True)
        receipt = self.root / "alias-receipt.json"
        code = ("import json,os,sys; from pathlib import Path; "
                "Path(sys.argv[1]).write_text(json.dumps(dict(os.environ)))")
        env = dict(self.env,
                   DXVK_STATE_CACHE_PATH=str(direct_alias / "DXVK_state_cache"),
                   MESA_SHADER_CACHE_DIR=str(inherited_alias / "mesa_shader_cache_sf"),
                   STEAM_FOSSILIZE_DUMP_PATH=str(self.source / "canonical/output.foz"),
                   MESA_SHADER_CACHE_READ_ONLY_FOZ_DBS=(
                       str(direct_alias / "alias.foz") + ":" + str(self.source / "canonical.foz")),
                   STEAM_FOSSILIZE_UNCONFIGURED_PATH=str(unconfigured_alias / "keep.foz"))
        self.invoke(APP, sys.executable, "-c", code, str(receipt), env=env)
        actual = json.loads(receipt.read_text())
        self.assertEqual(self.marker()["source"], str(self.source.resolve()))
        self.assertEqual((self.cache / "baseline").read_bytes(), b"steam baseline")
        self.assertEqual(actual["DXVK_STATE_CACHE_PATH"], str(self.cache / "DXVK_state_cache"))
        self.assertEqual(actual["MESA_SHADER_CACHE_DIR"], str(self.cache / "mesa_shader_cache_sf"))
        self.assertEqual(actual["STEAM_FOSSILIZE_DUMP_PATH"],
                         str(self.cache / "canonical/output.foz"))
        self.assertEqual(actual["MESA_SHADER_CACHE_READ_ONLY_FOZ_DBS"],
                         str(self.cache / "alias.foz") + ":" + str(self.cache / "canonical.foz"))
        self.assertEqual(actual["STEAM_FOSSILIZE_UNCONFIGURED_PATH"],
                         str(unconfigured_alias / "keep.foz"))
        self.settings(sources=[ancestor_alias / "missing-app"])
        self.reset()
        self.assertIsNone(self.marker()["source"])
        self.assertFalse((self.source.parent / "missing-app").exists())

    def test_source_alias_resolving_into_private_root_is_refused_before_creation(self):
        alias = self.root / "source alias"
        alias.symlink_to(self.private, target_is_directory=True)
        for source in (alias, alias / APP):
            with self.subTest(source=source):
                self.settings(sources=[source])
                self.assertIn("overlap", self.reset(ok=False).stderr)
                self.assertFalse(self.private.exists())

    def test_private_root_cache_file_and_marker_symlinks_are_refused(self):
        self.put("baseline")
        outside = self.root / "outside"
        outside.mkdir()
        precious = outside / "precious"
        precious.write_bytes(b"keep outside")
        self.private.symlink_to(outside, target_is_directory=True)
        self.reset(ok=False)
        self.private.unlink()
        private_ancestor = self.root / "private ancestor alias"
        private_ancestor.symlink_to(outside, target_is_directory=True)
        self.settings(private=private_ancestor / "cache")
        self.reset(ok=False)
        self.assertFalse((outside / "cache").exists())
        self.settings()
        self.private.mkdir()
        self.cache.symlink_to(outside, target_is_directory=True)
        self.reset(ok=False)
        self.cache.unlink()
        self.reset()
        (self.cache / "escape").symlink_to(precious)
        self.reset(ok=False)
        (self.cache / "escape").unlink()
        (self.cache / MARKER).unlink()
        (self.cache / MARKER).symlink_to(precious)
        self.reset(ok=False)
        self.assertEqual(precious.read_bytes(), b"keep outside")

    def test_hardlinked_private_file_and_lock_symlink_are_refused(self):
        self.put("baseline")
        self.reset()
        outside = self.root / "outside"
        outside.write_bytes(b"keep")
        os.link(outside, self.cache / "hardlink")
        self.reset(ok=False)
        (self.cache / "hardlink").unlink()
        lock = self.private / ("." + APP + ".lock")
        lock.unlink()
        lock.symlink_to(outside)
        self.reset(ok=False)
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_appid_config_and_environment_traversal_are_refused(self):
        for app in ("../22380", "", "１２３", "22380/child", " 22380", "22380\n"):
            with self.subTest(app=app):
                self.invoke("--reset", app, ok=False)
        self.settings(sources=[str(self.source) + "/../22380"])
        self.reset(ok=False)
        self.settings()
        env = dict(self.env, DXVK_STATE_CACHE_PATH=str(self.source) + "/../escape")
        self.launch(env=env, ok=False)
        self.assertFalse((self.private / "escape").exists())
        for roots in ('"not-an-array"', '["relative"]', '[123]', '{broken'):
            self.reset(env=dict(self.env, VORTEX_SHADER_SOURCE_ROOTS_JSON=roots), ok=False)

    def test_literal_child_argv_environment_remapping_and_exit_status(self):
        self.put("baseline")
        receipt = self.root / "receipt.json"
        arguments = ["with spaces", "'\"$;`()", "--literal", "line\nbreak", "ümlaut"]
        code = ("import json,os,sys; from pathlib import Path; "
                "Path(sys.argv[1]).write_text(json.dumps({'args':sys.argv[2:],"
                "'env':dict(os.environ)})); sys.exit(37)")
        env = dict(self.env, DXVK_STATE_CACHE_PATH=str(self.source / "DXVK_state_cache"),
                   MESA_SHADER_CACHE_DIR=str(self.source / "mesa_shader_cache_sf"),
                   __GL_SHADER_DISK_CACHE_PATH=str(self.source / "nvidia"),
                   STEAM_FOSSILIZE_DUMP_PATH=str(self.source / "fozpipelinesv6/output.foz"),
                   MESA_SHADER_CACHE_READ_ONLY_FOZ_DBS="/outside/keep.foz:" + str(
                       self.source / "mesa_shader_cache_sf/steam.foz"),
                   TEST_PRESERVED="unchanged value")
        result = self.invoke(APP, sys.executable, "-c", code, str(receipt), *arguments,
                             env=env, ok=False)
        self.assertEqual(result.returncode, 37, result.stderr)
        value = json.loads(receipt.read_text())
        self.assertEqual(value["args"], arguments)
        actual = value["env"]
        self.assertEqual(actual["TEST_PRESERVED"], "unchanged value")
        for key, relative in (("DXVK_STATE_CACHE_PATH", "DXVK_state_cache"),
                              ("MESA_SHADER_CACHE_DIR", "mesa_shader_cache_sf"),
                              ("__GL_SHADER_DISK_CACHE_PATH", "nvidia"),
                              ("STEAM_FOSSILIZE_DUMP_PATH", "fozpipelinesv6/output.foz")):
            self.assertEqual(actual[key], str(self.cache / relative))
        self.assertEqual(actual["MESA_SHADER_CACHE_READ_ONLY_FOZ_DBS"],
                         "/outside/keep.foz:" + str(self.cache / "mesa_shader_cache_sf/steam.foz"))

    def test_prepared_steam_environment_and_seeded_layout_defaults(self):
        self.put("DXVK_state_cache/seed.bin", b"dxvk seed")
        self.put("nvidiav1/seed.bin", b"nvidia seed")
        receipt = self.root / "prepared-env.json"
        code = ("import json,os,sys; from pathlib import Path; "
                "Path(sys.argv[1]).write_text(json.dumps(dict(os.environ)))")
        for inherited in (None, "0"):
            with self.subTest(inherited=inherited):
                env = dict(self.env, TEST_PRESERVED="keep")
                for key in ("SteamEnv", "DXVK_STATE_CACHE_PATH", "MESA_SHADER_CACHE_DIR",
                            "__GL_SHADER_DISK_CACHE_PATH", "STEAM_COMPAT_SHADER_PATH"):
                    env.pop(key, None)
                if inherited is not None:
                    env["SteamEnv"] = inherited
                self.invoke(APP, sys.executable, "-c", code, str(receipt), env=env)
                actual = json.loads(receipt.read_text())
                self.assertEqual(actual["SteamEnv"], "1")
                self.assertEqual(actual["STEAM_COMPAT_SHADER_PATH"], str(self.cache))
                self.assertEqual(actual["MESA_SHADER_CACHE_DIR"], str(self.cache))
                self.assertEqual(actual["DXVK_STATE_CACHE_PATH"], str(self.cache / "DXVK_state_cache"))
                self.assertEqual(actual["__GL_SHADER_DISK_CACHE_PATH"], str(self.cache / "nvidiav1"))
                self.assertEqual(actual["TEST_PRESERVED"], "keep")
                self.assertEqual((self.cache / "DXVK_state_cache/seed.bin").read_bytes(), b"dxvk seed")
                self.assertEqual((self.cache / "nvidiav1/seed.bin").read_bytes(), b"nvidia seed")

    def start_waiting_child(self, code=None):
        receipt = self.root / "child-ready"
        code = code or ("import os,sys,time; from pathlib import Path; "
                        "Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)")
        process = subprocess.Popen([sys.executable, str(self.runner), APP, sys.executable,
                                    "-c", code, str(receipt)], env=self.env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

        def cleanup():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if receipt.exists():
                try:
                    os.killpg(int(receipt.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.stderr.close()

        self.addCleanup(cleanup)
        deadline = time.monotonic() + 10
        while not receipt.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(receipt.exists(), "Child did not start: " + (
            process.stderr.read() if process.poll() is not None else "timeout"))
        return process

    def test_launch_and_reset_refuse_while_child_holds_lock_then_release(self):
        process = self.start_waiting_child()
        self.assertIn("in use", self.reset(ok=False).stderr)
        self.assertIn("in use", self.launch(ok=False).stderr)
        process.terminate()
        self.assertEqual(process.wait(timeout=5), -signal.SIGTERM)
        self.reset()

    def test_signal_is_forwarded_and_child_exit_code_preserved(self):
        code = ("import os,signal,sys,time; from pathlib import Path; "
                "signal.signal(signal.SIGTERM, lambda *_: sys.exit(43)); "
                "Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)")
        process = self.start_waiting_child(code)
        process.terminate()
        self.assertEqual(process.wait(timeout=5), 43)
        self.reset()

    def test_abrupt_wrapper_death_keeps_lock_until_child_exits(self):
        process = self.start_waiting_child()
        child_pid = int((self.root / "child-ready").read_text())
        process.kill()
        self.assertEqual(process.wait(timeout=5), -signal.SIGKILL)
        self.assertIn("in use", self.reset(ok=False).stderr)
        os.killpg(child_pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while True:
            result = subprocess.run([sys.executable, str(self.runner), "--reset", APP],
                                    env=self.env, text=True, capture_output=True, timeout=15)
            if result.returncode == 0:
                break
            self.assertIn("in use", result.stderr)
            self.assertLess(time.monotonic(), deadline, "Killed child retained lock")
            time.sleep(0.02)

    def test_direct_executable_entry(self):
        result = subprocess.run([str(self.runner), "--reset", APP], env=self.env,
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_does_not_create_missing_private_ancestors_or_locks(self):
        private = self.root / "missing ancestor" / "private"
        self.settings(private=private, sources=[self.root / "missing source"])
        before = set(self.root.rglob("*"))
        self.invoke("--check", APP)
        self.assertEqual(set(self.root.rglob("*")), before)
        self.assertFalse(private.parent.exists())

    def test_check_preserves_owned_cache_content_and_creates_no_lock(self):
        self.put("baseline")
        self.reset()
        (self.private / ("." + APP + ".lock")).unlink()
        (self.cache / "private-change").write_bytes(b"keep")

        def contents():
            return {str(path.relative_to(self.private)):
                    (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
                    for path in self.private.rglob("*") if path.is_file()}

        before = contents()
        self.invoke("--check", APP)
        self.assertEqual(contents(), before)
        self.assertFalse((self.private / ("." + APP + ".lock")).exists())

    def test_check_refuses_malformed_unsafe_and_unowned_paths_without_creation(self):
        self.config.write_text("{broken JSON")
        self.invoke("--check", APP, ok=False)
        self.assertFalse(self.private.exists())
        self.settings()
        self.invoke("--check", "../22380", ok=False)
        outside = self.root / "outside"
        outside.mkdir()
        alias = self.root / "private ancestor alias"
        alias.symlink_to(outside, target_is_directory=True)
        self.settings(private=alias / "private")
        self.invoke("--check", APP, ok=False)
        self.assertEqual(list(outside.iterdir()), [])
        self.settings()
        source_link = self.source / "linked cache entry"
        source_link.symlink_to(outside / "missing")
        self.invoke("--check", APP, ok=False)
        self.assertFalse(self.private.exists())
        source_link.unlink()
        self.cache.mkdir(parents=True)
        (self.cache / "keep").write_bytes(b"unknown owner")
        self.invoke("--check", APP, ok=False)
        self.assertEqual((self.cache / "keep").read_bytes(), b"unknown owner")
        self.assertEqual(list(self.private.iterdir()), [self.cache])

    def test_installed_wrapper_ancestor_alias_supports_check_and_launch(self):
        self.put("baseline")
        alias = self.root / ".local-share-alias"
        alias.symlink_to(self.runner.parent, target_is_directory=True)
        aliased_runner = alias / self.runner.name
        checked = subprocess.run([str(aliased_runner), "--check", APP], env=self.env,
                                 text=True, capture_output=True, timeout=15)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertFalse(self.private.exists())
        launched = subprocess.run([str(aliased_runner), APP, sys.executable, "-c", "pass"],
                                  env=self.env, text=True, capture_output=True, timeout=15)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        self.assertEqual((self.cache / "baseline").read_bytes(), b"steam baseline")
        self.assertEqual(self.marker()["source"], str(self.source.resolve()))

    def test_python_version_requirement_is_explicit_and_precedes_path_creation(self):
        code = ("import runpy,sys\n"
                "namespace=runpy.run_path(sys.argv[1])\n"
                "sys.version_info=(3,9,0)\n"
                "try:\n"
                "    namespace['main'](['--check',sys.argv[2]])\n"
                "except namespace['Refused'] as error:\n"
                "    print(str(error))\n"
                "    raise SystemExit(0)\n"
                "raise SystemExit(2)\n")
        result = subprocess.run([sys.executable, "-c", code, str(self.runner), APP],
                                env=self.env, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Python 3.10 or newer is required", result.stdout)
        self.assertFalse(self.private.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
