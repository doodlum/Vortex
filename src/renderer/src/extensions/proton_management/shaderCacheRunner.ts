/** Installed into the user Steam host environment; bundled for ASAR packages. */
export const SHADER_CACHE_SOURCE = String.raw`#!/usr/bin/env python3
"""Linux-only private shader-cache launcher (Python 3.10+)."""

import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import uuid
from contextlib import ExitStack, contextmanager


MARKER = ".vortex-steam-source.json"
VERSION = 1
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class Refused(Exception):
    pass


def absolute_path(value):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise Refused("Cache paths must be absolute Linux paths")
    if any(part in (".", "..") for part in value.split("/")):
        raise Refused("Cache paths must not contain . or .. components")
    return Path(value)


@contextmanager
def directory(path, create=False):
    """Open every component without following a symlink, including ancestors."""
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def regular_file(fd, name):
    result = os.open(name, FILE_FLAGS, dir_fd=fd)
    if not stat.S_ISREG(os.fstat(result).st_mode):
        os.close(result)
        raise Refused("Cache contains a non-regular file: " + name)
    return result


def read_json(fd, name):
    with os.fdopen(regular_file(fd, name), "r", encoding="utf-8") as stream:
        return json.load(stream)


def configuration(app_id):
    try:
        script_root = absolute_path(str(Path(__file__).resolve(strict=True).parent))
    except (OSError, RuntimeError) as error:
        raise Refused("Installed wrapper path cannot be resolved") from error
    settings = {}
    try:
        with directory(script_root / "shader-cache-settings") as fd:
            settings = read_json(fd, app_id + ".json")
    except FileNotFoundError:
        pass
    if not isinstance(settings, dict):
        raise Refused("Shader-cache settings must be an object")
    private = os.environ.get(
        "VORTEX_SHADER_CACHE_ROOT",
        settings.get("privateRoot", str(Path.home() / ".cache/vortex/shadercache")),
    )
    roots = settings.get("sourceRoots", [])
    if "VORTEX_SHADER_SOURCE_ROOTS_JSON" in os.environ:
        roots = json.loads(os.environ["VORTEX_SHADER_SOURCE_ROOTS_JSON"])
    if not isinstance(roots, list) or not all(isinstance(root, str) for root in roots):
        raise Refused("sourceRoots must be a JSON array of absolute per-AppID paths")
    private = absolute_path(private)
    aliases = list(dict.fromkeys(absolute_path(root) for root in roots))
    sources = []
    for alias in aliases:
        # Steam commonly exposes its client/library through a configured symlink.
        # Resolve only that explicit root; never resolve private paths or arbitrary
        # environment values. Opening the result still checks every component.
        try:
            source = absolute_path(str(alias.resolve(strict=False)))
        except (OSError, RuntimeError) as error:
            raise Refused("Configured Steam source root cannot be resolved: " + str(alias)) from error
        if source not in sources:
            sources.append(source)
    for source in sources:
        if source == private or source in private.parents or private in source.parents:
            raise Refused("Steam source and private cache roots overlap")
    source_prefixes = list(dict.fromkeys([*aliases, *sources]))
    return private, sources, source_prefixes


def same_snapshot(before, after):
    return (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size,
                                   after.st_mtime_ns, after.st_ctime_ns)


def source_tree(fd, destination=None):
    """Hash names/types and streamed bytes; optionally copy into an empty directory."""
    digest = hashlib.sha256()
    files = 0

    def record(kind, path):
        encoded = os.fsencode(path)
        digest.update(kind + len(encoded).to_bytes(8, "big") + encoded)

    def visit(current, target, prefix):
        nonlocal files
        before_dir = os.fstat(current)
        for name in sorted(os.listdir(current)):
            if not prefix and name == "downloads":
                continue
            if not prefix and name == MARKER:
                raise Refused("Steam source contains the reserved ownership-marker name")
            relative = prefix + name
            info = os.stat(name, dir_fd=current, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                record(b"D", relative)
                source_fd = os.open(name, DIR_FLAGS, dir_fd=current)
                target_fd = None
                try:
                    if target is not None:
                        os.mkdir(name, mode=0o700, dir_fd=target)
                        target_fd = os.open(name, DIR_FLAGS, dir_fd=target)
                    visit(source_fd, target_fd, relative + "/")
                finally:
                    os.close(source_fd)
                    if target_fd is not None:
                        os.close(target_fd)
            elif stat.S_ISREG(info.st_mode):
                record(b"F", relative)
                source_fd = regular_file(current, name)
                target_fd = None
                try:
                    before = os.fstat(source_fd)
                    digest.update(before.st_size.to_bytes(8, "big"))
                    if target is not None:
                        target_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                            | os.O_NOFOLLOW | os.O_CLOEXEC,
                                            0o600, dir_fd=target)
                    with os.fdopen(os.dup(source_fd), "rb") as stream:
                        while True:
                            block = stream.read(1024 * 1024)
                            if not block:
                                break
                            digest.update(block)
                            if target_fd is not None:
                                view = memoryview(block)
                                while view:
                                    written = os.write(target_fd, view)
                                    view = view[written:]
                    if not same_snapshot(before, os.fstat(source_fd)):
                        raise Refused("Steam source changed while being read; retry later")
                    if target_fd is not None:
                        os.utime(target_fd, ns=(before.st_atime_ns, before.st_mtime_ns))
                    files += 1
                finally:
                    os.close(source_fd)
                    if target_fd is not None:
                        os.close(target_fd)
            else:
                raise Refused("Steam source contains a symlink or special file: " + relative)
        if not same_snapshot(before_dir, os.fstat(current)):
            raise Refused("Steam source directory changed while being read; retry later")

    visit(fd, destination, "")
    return digest.hexdigest(), files


def choose_source(sources):
    selected = None
    fingerprint = hashlib.sha256().hexdigest()
    for source in sources:
        with ExitStack() as stack:
            try:
                fd = stack.enter_context(directory(source))
            except FileNotFoundError:
                continue
            current, count = source_tree(fd)
        if selected is None and count:
            selected, fingerprint = source, current
    return selected, fingerprint


def owned_marker(fd, app_id):
    try:
        marker = read_json(fd, MARKER)
    except (OSError, ValueError) as error:
        raise Refused("Existing private cache has no valid ownership marker") from error
    if (not isinstance(marker, dict) or marker.get("version") != VERSION
            or marker.get("appId") != app_id
            or not isinstance(marker.get("fingerprint"), str)
            or re.fullmatch(r"[0-9a-f]{64}", marker["fingerprint"]) is None
            or "source" not in marker
            or not (marker.get("source") is None or isinstance(marker.get("source"), str))):
        raise Refused("Existing private cache belongs to another owner or format")
    if marker["source"] is not None:
        absolute_path(marker["source"])
    return marker


def safe_private_tree(fd):
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                safe_private_tree(child)
            finally:
                os.close(child)
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Refused("Private cache contains a symlink, special file or hardlink")


def remove_owned(parent, name, app_id):
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        owned_marker(fd, app_id)
        safe_private_tree(fd)

        def remove_contents(current):
            # All deletion is relative to opened no-follow directory descriptors.
            for entry in sorted(os.listdir(current), key=lambda name: name == MARKER):
                info = os.stat(entry, dir_fd=current, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry, DIR_FLAGS, dir_fd=current)
                    try:
                        remove_contents(child)
                    finally:
                        os.close(child)
                    os.rmdir(entry, dir_fd=current)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    os.unlink(entry, dir_fd=current)
                else:
                    raise Refused("Private cache changed during cleanup")

        remove_contents(fd)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)


def require_renameat2():
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise Refused("Atomic cache replacement requires Linux libc renameat2")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                       ctypes.c_uint]
    rename.restype = ctypes.c_int
    return rename


def atomic_rename(parent, first, second, flags):
    """Use NOREPLACE (1) initially and EXCHANGE (2) for an existing owned cache."""
    rename = require_renameat2()
    if rename(parent, os.fsencode(first), parent, os.fsencode(second), flags) != 0:
        code = ctypes.get_errno()
        raise OSError(code, "Atomic cache exchange failed: " + os.strerror(code))


def check_configuration(private, sources, app_id):
    """Read-only preflight; missing private paths are allowed and never created."""
    require_renameat2()  # Symbol presence only; filesystem flag support needs mutation.
    choose_source(sources)
    with ExitStack() as stack:
        try:
            parent = stack.enter_context(directory(private))
        except FileNotFoundError:
            return
        try:
            existing = os.open(app_id, DIR_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            return
        try:
            owned_marker(existing, app_id)
            safe_private_tree(existing)
        finally:
            os.close(existing)


def prepare_cache(parent, app_id, source, fingerprint, reset):
    marker = {"version": VERSION, "appId": app_id,
              "source": str(source) if source is not None else None,
              "fingerprint": fingerprint}
    exists = False
    try:
        existing = os.open(app_id, DIR_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        pass
    else:
        exists = True
        try:
            previous = owned_marker(existing, app_id)
            safe_private_tree(existing)
            if not reset and previous == marker:
                return
        finally:
            os.close(existing)

    temporary = "." + app_id + ".tmp-" + uuid.uuid4().hex
    os.mkdir(temporary, mode=0o700, dir_fd=parent)
    staged = os.open(temporary, DIR_FLAGS, dir_fd=parent)
    marked = False
    try:
        marker_fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                            | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=staged)
        with os.fdopen(marker_fd, "w", encoding="utf-8") as stream:
            json.dump(marker, stream, sort_keys=True)
            stream.write("\n")
        marked = True
        if source is not None:
            with directory(source) as fd:
                copied, _ = source_tree(fd, staged)
            if copied != fingerprint:
                raise Refused("Steam source changed before copying; retry later")
        if exists:
            atomic_rename(parent, temporary, app_id, 2)
        else:
            atomic_rename(parent, temporary, app_id, 1)
            temporary = None
    finally:
        os.close(staged)
        if temporary is not None:
            if marked:
                remove_owned(parent, temporary, app_id)
            else:
                # Only an empty directory that this invocation just created is removable.
                os.rmdir(temporary, dir_fd=parent)


def child_environment(private, source_prefixes, app_id, cache_fd):
    env = os.environ.copy()
    target = private / app_id

    def remap(value):
        for source in sorted(source_prefixes, key=lambda root: len(str(root)), reverse=True):
            if value == str(source) or value.startswith(str(source) + "/"):
                original = absolute_path(value)
                return str(target / original.relative_to(source))
        return value

    def remap_list(value):
        # Consume a configured root before looking for a delimiter: a Steam library
        # directory itself may contain a colon, which JSON source settings preserve.
        result = []
        offset = 0
        ordered = sorted(source_prefixes, key=lambda root: len(str(root)), reverse=True)
        while offset < len(value):
            end_of_root = offset
            for source in ordered:
                text = str(source)
                end = offset + len(text)
                if (value.startswith(text, offset)
                        and (end == len(value) or value[end] in "/:")):
                    end_of_root = end
                    break
            end = value.find(":", end_of_root)
            if end == -1:
                end = len(value)
            result.append(remap(value[offset:end]))
            if end < len(value):
                result.append(":")
            offset = end + 1
        return "".join(result)

    for key, value in list(env.items()):
        if not key.startswith("VORTEX_") and re.search(r"SHADER|CACHE|FOSSILIZE|FOZ", key):
            env[key] = remap_list(value)

    for key, fallback in (("DXVK_STATE_CACHE_PATH", "DXVK_state_cache"),
                          ("MESA_SHADER_CACHE_DIR", ""),
                          ("__GL_SHADER_DISK_CACHE_PATH", "nvidiav1")):
        mapped = remap(os.environ.get(key, ""))
        if not (mapped == str(target) or mapped.startswith(str(target) + "/")):
            mapped = str(target / fallback)
        relative = absolute_path(mapped).relative_to(target)
        current = os.dup(cache_fd)
        try:
            for part in relative.parts:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
                next_fd = os.open(part, DIR_FLAGS, dir_fd=current)
                os.close(current)
                current = next_fd
        finally:
            os.close(current)
        env[key] = mapped
    env["STEAM_COMPAT_SHADER_PATH"] = str(target)
    # Native steamclient otherwise replaces the prepared cache environment during
    # steam.exe initialization, before it creates the actual Windows game. Steam
    # uses the same marker for its own fully prepared game-launch environment.
    env["SteamEnv"] = "1"
    return env


def child_run(command, env, lock_fd):
    child = None
    pending = []

    def forward(number, _frame):
        if child is None:
            pending.append(number)
        else:
            try:
                os.killpg(child.pid, number)
            except ProcessLookupError:
                pass

    previous = {}
    try:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
            previous[number] = signal.signal(number, forward)
        child = subprocess.Popen(command, env=env, start_new_session=True,
                                 pass_fds=(lock_fd,))
        for number in pending:
            forward(number, None)
        return child.wait()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def main(arguments):
    if sys.version_info < (3, 10):
        raise Refused("Python 3.10 or newer is required")
    operation = arguments[0] if len(arguments) == 2 and arguments[0] in ("--reset", "--check") else None
    reset = operation == "--reset"
    if operation is not None:
        app_id, command = arguments[1], []
    elif len(arguments) >= 2 and arguments[0] not in ("--reset", "--check"):
        app_id, command = arguments[0], arguments[1:]
    else:
        raise Refused("usage: vortex-shader-cache-run <appid> <command> [args...] | --reset <appid> | --check <appid>")
    if re.fullmatch(r"[0-9]+", app_id) is None:
        raise Refused("Invalid Steam AppID (ASCII digits required)")
    private, sources, source_prefixes = configuration(app_id)
    if operation == "--check":
        check_configuration(private, sources, app_id)
        return 0
    # Configuration overlap checks precede creating the private root.
    with directory(private, create=True) as parent:
        lock_fd = os.open("." + app_id + ".lock", os.O_RDWR | os.O_CREAT
                          | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                          0o600, dir_fd=parent)
        try:
            info = os.fstat(lock_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise Refused("Unsafe per-AppID lock file")
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Refused("Private shader cache is in use; close the game and retry") from error
            source, fingerprint = choose_source(sources)
            prepare_cache(parent, app_id, source, fingerprint, reset)
            if reset:
                return 0
            cache_fd = os.open(app_id, DIR_FLAGS, dir_fd=parent)
            try:
                env = child_environment(private, source_prefixes, app_id, cache_fd)
            finally:
                os.close(cache_fd)
            return child_run(command, env, lock_fd)
        finally:
            # The child inherits this descriptor too, retaining the flock if the wrapper dies.
            os.close(lock_fd)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except (Refused, OSError, ValueError, TypeError, RecursionError) as error:
        print("vortex-shader-cache-run: " + str(error), file=sys.stderr)
        result = 1
    if result < 0:
        signal.signal(-result, signal.SIG_DFL)
        os.kill(os.getpid(), -result)
    sys.exit(result)
`;
