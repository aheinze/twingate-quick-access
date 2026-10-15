#!/usr/bin/env python3
"""Build a deterministic extension ZIP with no downloaded dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ['extension.js', 'menu.js', 'tooltips.js', 'model.js', 'client.js', 'controller.js',
           'runner.js', 'prefs.js', 'metadata.json', 'stylesheet.css', 'LICENSE',
           'icons/twingate-panel-symbolic.svg',
           'schemas/org.gnome.shell.extensions.twingate-panel.gschema.xml']


def stage(target, gnome51=False):
    for name in PAYLOAD:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, destination)
    if gnome51:
        path = target / 'metadata.json'
        metadata = json.loads(path.read_text())
        metadata['shell-version'] = ['50', '51']
        metadata['version-name'] += '-gnome51-unverified'
        path.write_text(json.dumps(metadata, indent=2) + '\n')
    subprocess.run(['glib-compile-schemas', '--strict', str(target / 'schemas')], check=True)


def build(gnome51=False):
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    version = json.loads((ROOT / 'metadata.json').read_text())['version-name']
    suffix = '-gnome51-unverified' if gnome51 else ''
    archive = output / f'twingate-panel-{version}{suffix}.shell-extension.zip'
    with tempfile.TemporaryDirectory(prefix='twingate-package-') as temp:
        source = Path(temp)
        stage(source, gnome51)
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            for path in sorted(p for p in source.rglob('*') if p.is_file()):
                info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                bundle.writestr(info, path.read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + '.sha256').write_text(f'{digest}  {archive.name}\n')
    print(archive)
    print(f'SHA256 {digest}')
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gnome51-preview', action='store_true',
                        help='Opt-in test package only; GNOME 51 runtime validation is still required.')
    build(parser.parse_args().gnome51_preview)
