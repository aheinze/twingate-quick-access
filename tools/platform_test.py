#!/usr/bin/env python3
"""Run platform checks with the installed Fedora GNOME/Mutter library paths."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
paths = [Path('/usr/lib64/gnome-shell'), *sorted(Path('/usr/lib64').glob('mutter-*'))]
env = os.environ.copy()
for key in ('GI_TYPELIB_PATH', 'LD_LIBRARY_PATH'):
    env[key] = ':'.join([*(str(path) for path in paths if path.is_dir()), env.get(key, '')])
subprocess.run(['glib-compile-schemas', '--strict', str(ROOT / 'schemas')], check=True)
subprocess.run(['gjs', '-m', 'tests/platform.gjs.js'], cwd=ROOT, env=env, check=True)
