"""install.sh in a sandboxed HOME, installing from a local copy of this checkout.

The full install creates a virtual environment and lets pip fetch Pillow and the
build backend, so it needs the package index. Set THREADBACK_TEST_OFFLINE=1 to
skip those tests.
"""

import os
import platform
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import mac_support
from mac_support import REPO_ROOT

INSTALLER = REPO_ROOT / "install.sh"
BASH = shutil.which("bash")
OFFLINE = os.environ.get("THREADBACK_TEST_OFFLINE") == "1"
HAVE_PROJECT = (REPO_ROOT / "pyproject.toml").is_file() and (REPO_ROOT / "wrapped" / "cli.py").is_file()
IS_MAC = platform.system() == "Darwin"


def run_installer(home, *args, env=None, source=None):
    full = {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "THREADBACK_ALLOW_NON_MACOS": "1",
    }
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy",
                "PIP_INDEX_URL", "PIP_CERT", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_EXTRA_INDEX_URL"):
        if key in os.environ:
            full[key] = os.environ[key]
    if source is not None:
        full["THREADBACK_SOURCE"] = str(source)
    full.update(env or {})
    return subprocess.run(
        [BASH, str(INSTALLER), *args], capture_output=True, text=True, env=full, timeout=600, stdin=subprocess.DEVNULL
    )


@unittest.skipUnless(BASH and INSTALLER.is_file(), "bash or install.sh is missing")
class InstallerBasics(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_syntax_and_shellcheck(self):
        self.assertEqual(subprocess.run([BASH, "-n", str(INSTALLER)], capture_output=True).returncode, 0)
        self.assertTrue(os.access(INSTALLER, os.X_OK), "install.sh should be executable")
        shellcheck = shutil.which("shellcheck")
        if shellcheck:
            proc = subprocess.run([shellcheck, str(INSTALLER)], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_no_sudo_and_everything_runs_from_main(self):
        text = INSTALLER.read_text(encoding="utf-8")
        code_lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
        self.assertFalse(any(" sudo " in f" {ln} " and "say" not in ln and "warn" not in ln and "apt" not in ln for ln in code_lines))
        self.assertEqual(text.rstrip().splitlines()[-1], 'main "$@"')  # a truncated download runs nothing
        self.assertIn("set -euo pipefail", text)
        self.assertIn("raw.githubusercontent.com/averyhsu/imessage-wrap/main/install.sh", text)

    def test_help_and_unknown_option(self):
        proc = run_installer(self.home, "--help")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("--uninstall", proc.stdout)
        proc = run_installer(self.home, "--frobnicate")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("Unknown option", proc.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    @unittest.skipIf(IS_MAC, "this checks the refusal on other systems")
    def test_refuses_on_non_macos_without_the_override(self):
        proc = run_installer(self.home, env={"THREADBACK_ALLOW_NON_MACOS": "0"})
        self.assertEqual(proc.returncode, 1)
        self.assertIn("Mac", proc.stderr)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_old_or_missing_python_is_explained(self):
        fake = Path(self.tmp.name) / "python3"
        fake.write_text("#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then case \"$2\" in *print*) echo 3.8;; *) exit 1;; esac; fi\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        proc = run_installer(self.home, env={"THREADBACK_PYTHON": str(fake)})
        self.assertEqual(proc.returncode, 1)
        self.assertIn("needs Python 3.9 or newer", proc.stderr)
        self.assertIn("3.8", proc.stderr)
        self.assertFalse((self.home / ".threadback").exists())
        # no python3 at all (an empty PATH except for the tools the script itself needs)
        tools = Path(self.tmp.name) / "tools"
        tools.mkdir()
        for tool in ("uname", "printf", "mkdir", "grep", "chmod", "mv", "rm", "cat", "env"):
            real = shutil.which(tool)
            if real:
                os.symlink(real, tools / tool)
        proc = run_installer(self.home, env={"PATH": str(tools)})
        self.assertEqual(proc.returncode, 1)
        self.assertIn("no python3", proc.stderr)

    # -- it only ever removes what it wrote (review M3) -------------------------

    MARKER = next(
        line.split('"', 1)[1].rsplit('"', 1)[0]
        for line in INSTALLER.read_text(encoding="utf-8").splitlines()
        if line.startswith("MARKER=")
    ) if INSTALLER.is_file() else ""

    def guarded(self, **extra):
        """An environment in which even a broken installer cannot do damage: ``rm``
        and ``rmdir`` only write down what they were asked to do, and the Python
        is one that fails the version check, so an install stops before it creates
        anything. These tests hand the installer paths like ``/`` and ``$HOME`` on
        purpose; they must never depend on the installer being right to be safe."""
        stubs = Path(self.tmp.name) / "stubs"
        stubs.mkdir(exist_ok=True)
        log = Path(self.tmp.name) / "removals.log"
        for tool in ("rm", "rmdir"):
            stub = stubs / tool
            stub.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\nexit 0\n')
            stub.chmod(0o755)
        too_old = stubs / "python3-too-old"
        too_old.write_text("#!/bin/sh\nexit 1\n")
        too_old.chmod(0o755)
        env = {"PATH": f"{stubs}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}", "THREADBACK_PYTHON": str(too_old)}
        env.update(extra)
        return env, log

    def fake_install(self, tb=None, extra=()):
        """The layout a real install leaves behind, built by hand (no network needed)."""
        tb = tb or self.home / ".threadback"
        (tb / "venv" / "bin").mkdir(parents=True)
        (tb / "venv" / "pyvenv.cfg").write_text("home = /usr/bin\n")
        (tb / "venv" / "bin" / "python").write_text("")
        (tb / ".installed-by-threadback").write_text("")
        (tb / "state.json").write_text('{"cursor": 5, "v": 1}')
        (tb / "state.json.lock").write_text("")
        (tb / "agent.log").write_text("a line\n")
        for name in extra:
            (tb / name).write_text("the owner put this here")
        bin_dir = self.home / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        for name in ("wrapped", "threadback"):
            (bin_dir / name).write_text(f"#!/bin/sh\n{self.MARKER}\nexec true\n")
        (bin_dir / "other-tool").write_text("#!/bin/sh\necho not ours\n")
        return tb, bin_dir

    def test_install_refuses_a_folder_that_already_holds_someone_elses_files(self):
        # the reviewer's repro: THREADBACK_HOME=~/Documents, install, uninstall
        docs = self.home / "Documents"
        (docs / "taxes").mkdir(parents=True)
        (docs / "thesis.txt").write_text("irreplaceable")
        env, removals = self.guarded(THREADBACK_HOME=str(docs))
        proc = run_installer(self.home, env=env)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("not empty", proc.stderr)
        self.assertEqual(sorted(x.name for x in docs.iterdir()), ["taxes", "thesis.txt"])  # nothing added either
        # ... and had an older version installed there (its stamp is in the folder),
        # uninstalling removes the installer's own files, never the folder
        (docs / ".installed-by-threadback").write_text("")
        (docs / "venv").mkdir()
        (docs / "venv" / "pyvenv.cfg").write_text("home = /usr/bin\n")
        gone = run_installer(self.home, "--uninstall", env={"THREADBACK_HOME": str(docs)})
        self.assertEqual(gone.returncode, 0, gone.stderr)
        self.assertEqual(sorted(x.name for x in docs.iterdir()), ["taxes", "thesis.txt"])
        self.assertEqual((docs / "thesis.txt").read_text(), "irreplaceable")

    def test_never_operates_on_home_the_root_or_a_parent_of_home(self):
        (self.home / "keep.txt").write_text("mine")
        (self.home / "sub").mkdir()
        (self.home / ".installed-by-threadback").write_text("")  # even a stamp must not make HOME "ours"
        link = Path(self.tmp.name) / "link-to-home"
        os.symlink(self.home, link)
        spellings = [
            f"{self.home}//", f"{self.home}/", f"{self.home}/.", f"{self.home}/sub/..", f"{self.home}/sub/../.",
            str(link), f"{link}/", str(self.home.parent), f"{self.home}/../{self.home.name}", "/", "//", "/.",
            "///", "//.//", f"/{self.home}", f"//{self.home}/", "/tmp/..", "/tmp/../.",
        ]
        for bad in spellings:
            for args in ((), ("--uninstall",)):
                with self.subTest(home=bad, args=args):
                    env, removals = self.guarded(THREADBACK_HOME=bad)
                    if removals.exists():
                        removals.unlink()
                    proc = run_installer(self.home, *args, env=env)
                    if not args:
                        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
                        self.assertIn("folder of its own", proc.stderr)
                    else:
                        self.assertIn("alone", proc.stderr)
                    # it must not even try: nothing was handed to rm or rmdir
                    self.assertFalse(removals.exists(), removals.read_text() if removals.exists() else "")
                    self.assertEqual((self.home / "keep.txt").read_text(), "mine")
                    self.assertTrue((self.home / "sub").is_dir())
                    self.assertFalse((self.home / "venv").exists())

    def test_uninstall_removes_only_what_the_installer_and_helper_wrote(self):
        tb, bin_dir = self.fake_install(extra=("my-notes.txt",))
        (tb / "exports").mkdir()
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sorted(x.name for x in tb.iterdir()), ["exports", "my-notes.txt"])  # theirs: kept
        self.assertEqual(sorted(x.name for x in bin_dir.iterdir()), ["other-tool"])
        self.assertIn("my-notes.txt", proc.stdout)  # ... and it says why the folder is still there

    def test_uninstall_removes_the_folder_once_it_is_empty(self):
        tb, bin_dir = self.fake_install()
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(tb.exists())
        self.assertEqual(sorted(x.name for x in bin_dir.iterdir()), ["other-tool"])
        self.assertIn(f"Removed {tb.resolve()}", proc.stdout)

    def test_uninstall_never_follows_a_link_out_of_its_folder(self):
        tb, _ = self.fake_install()
        precious = self.home / "Photos"
        precious.mkdir()
        (precious / "pyvenv.cfg").write_text("looks like a venv")
        (precious / "wedding.jpg").write_text("irreplaceable")
        import shutil as _shutil

        _shutil.rmtree(tb / "venv")
        os.symlink(precious, tb / "venv")
        (tb / "agent.log").unlink()
        os.symlink(precious / "wedding.jpg", tb / "agent.log")
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sorted(x.name for x in precious.iterdir()), ["pyvenv.cfg", "wedding.jpg"])
        self.assertEqual((precious / "wedding.jpg").read_text(), "irreplaceable")
        self.assertFalse(tb.exists())

    def test_install_accepts_a_folder_that_only_holds_the_helpers_own_files(self):
        # someone ran the helper from a checkout first: ~/.threadback has state but no stamp
        tb = self.home / ".threadback"
        tb.mkdir()
        (tb / "state.json").write_text('{"cursor": 5, "v": 1}')
        fake = Path(self.tmp.name) / "python3"  # stops right after the folder checks, without the network
        fake.write_text("#!/bin/sh\nexit 1\n")
        fake.chmod(0o755)
        proc = run_installer(self.home, env={"THREADBACK_PYTHON": str(fake)})
        self.assertNotIn("not empty", proc.stderr)
        self.assertIn("needs Python 3.9 or newer", proc.stderr)
        self.assertEqual((tb / "state.json").read_text(), '{"cursor": 5, "v": 1}')

    def test_uninstall_when_nothing_is_installed(self):
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("Nothing to remove", proc.stdout)

    def test_uninstall_never_removes_a_folder_it_did_not_create(self):
        precious = self.home / ".threadback"
        precious.mkdir()
        (precious / "notes.txt").write_text("mine")
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0)
        self.assertTrue((precious / "notes.txt").exists())
        self.assertIn("Left", proc.stderr)
        for bad in ("/", str(self.home)):
            env, removals = self.guarded(THREADBACK_HOME=bad)
            proc = run_installer(self.home, "--uninstall", env=env)
            self.assertEqual(proc.returncode, 0)
            self.assertFalse(removals.exists())
            self.assertTrue((precious / "notes.txt").exists())


@unittest.skipUnless(BASH and INSTALLER.is_file() and HAVE_PROJECT, "needs bash, install.sh and the full project")
@unittest.skipIf(OFFLINE, "THREADBACK_TEST_OFFLINE=1")
class InstallerEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.home = root / "home with space"
        cls.home.mkdir()
        # install from a copy so pip's build folders never land in the checkout
        cls.source = root / "src"
        cls.source.mkdir()
        for name in ("pyproject.toml", "README.md"):
            shutil.copy(REPO_ROOT / name, cls.source / name)
        shutil.copytree(REPO_ROOT / "wrapped", cls.source / "wrapped", ignore=shutil.ignore_patterns("__pycache__"))
        cls.bin = cls.home / ".local" / "bin"
        cls.first = run_installer(cls.home, source=cls.source)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def launcher(self, name, *args):
        return subprocess.run(
            [str(self.bin / name), *args], capture_output=True, text=True, timeout=120,
            env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"}, stdin=subprocess.DEVNULL,
        )

    def test_1_install_succeeds_and_says_what_to_do_next(self):
        self.assertEqual(self.first.returncode, 0, self.first.stdout + self.first.stderr)
        out = self.first.stdout
        self.assertIn("Installed.", out)
        self.assertIn("Full Disk Access", out)
        self.assertIn("threadback doctor", out)
        self.assertIn("threadback agent --chat", out)
        self.assertIn("is not on your PATH yet", out)  # the sandboxed HOME's bin is not on PATH
        self.assertTrue((self.home / ".threadback" / "venv" / "bin" / "python").exists())

    def test_2_both_launchers_work_and_include_the_helper_commands(self):
        for name in ("wrapped", "threadback"):
            path = self.bin / name
            self.assertTrue(os.access(path, os.X_OK), name)
            proc = self.launcher(name, "--help")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            for command in ("agent", "preview", "send-test", "doctor", "chats", "link"):
                self.assertIn(command, proc.stdout)
        proc = self.launcher("threadback", "--version")
        self.assertIn("Threadback", proc.stdout)

    def test_3_installed_package_has_fonts_and_renders_a_card(self):
        py = self.home / ".threadback" / "venv" / "bin" / "python"
        out_png = Path(self.tmp.name) / "installed-card.png"
        code = (
            "import json, sys; from wrapped.mac.card import render_card, FONT_DIR; "
            "import pathlib; assert (FONT_DIR / 'OFL-Archivo.txt').is_file() and (FONT_DIR / 'OFL-Inter.txt').is_file(); "
            "render_card(json.load(open(sys.argv[1])), sys.argv[2], size=(540, 675)); "
            "import wrapped.mac; print(pathlib.Path(wrapped.mac.__file__).parent)"
        )
        stats_file = Path(self.tmp.name) / "stats.json"
        import json

        stats_file.write_text(json.dumps(mac_support.sample_stats()), encoding="utf-8")
        proc = subprocess.run(
            [str(py), "-c", code, str(stats_file), str(out_png)], capture_output=True, text=True, timeout=120,
            cwd=self.tmp.name, env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(out_png.is_file())
        self.assertIn("site-packages", proc.stdout)  # the installed copy, not this checkout

    def test_4_doctor_runs_from_the_launcher_and_explains_a_missing_database(self):
        proc = self.launcher("threadback", "doctor")
        self.assertIn("card renderer ready", proc.stdout)
        if not IS_MAC:
            self.assertEqual(proc.returncode, 1)
            self.assertIn("No Messages database", proc.stdout)

    def test_5_running_it_again_is_fine_and_keeps_foreign_files(self):
        foreign = self.bin / "something-else"
        foreign.write_text("#!/bin/sh\necho mine\n")
        state = self.home / ".threadback" / "state.json"
        state.write_text('{"cursor": 5}')
        again = run_installer(self.home, source=self.source)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("Updating the existing environment", again.stdout)
        self.assertEqual(foreign.read_text(), "#!/bin/sh\necho mine\n")
        self.assertEqual(state.read_text(), '{"cursor": 5}')  # an update keeps the helper's state
        self.assertEqual(self.launcher("wrapped", "--help").returncode, 0)

    def test_6_a_foreign_command_with_the_same_name_is_not_overwritten(self):
        home2 = Path(self.tmp.name) / "home2"
        (home2 / ".local" / "bin").mkdir(parents=True)
        theirs = home2 / ".local" / "bin" / "wrapped"
        theirs.write_text("#!/bin/sh\necho someone elses wrapped\n")
        proc = run_installer(home2, source=self.source)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("someone elses", theirs.read_text())
        self.assertIn("left alone", proc.stderr)
        self.assertTrue((home2 / ".local" / "bin" / "threadback").exists())
        gone = run_installer(home2, "--uninstall")
        self.assertEqual(gone.returncode, 0)
        self.assertTrue(theirs.exists())  # still theirs after uninstall
        self.assertFalse((home2 / ".local" / "bin" / "threadback").exists())
        self.assertFalse((home2 / ".threadback").exists())

    def test_7_uninstall_removes_everything_it_created(self):
        proc = run_installer(self.home, "--uninstall")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse((self.home / ".threadback").exists())
        self.assertFalse((self.bin / "wrapped").exists())
        self.assertFalse((self.bin / "threadback").exists())
        self.assertTrue((self.bin / "something-else").exists())
        self.assertIn("Full Disk Access", proc.stdout)
        again = run_installer(self.home, "--uninstall")
        self.assertIn("Nothing to remove", again.stdout)


if __name__ == "__main__":
    unittest.main()
