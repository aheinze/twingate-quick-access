#!/usr/bin/env python3
"""Install locally with a complete rollback backup. Does not restart GNOME or Twingate."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import tempfile
from package import ROOT, stage

METADATA = json.loads((ROOT / 'metadata.json').read_text())
UUID = METADATA['uuid']


def install(restore=None):
    home = Path.home()
    destination = home / '.local/share/gnome-shell/extensions' / UUID
    if destination.is_symlink():
        raise SystemExit('The installed extension is a symlink. Update its source checkout instead.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    state = home / '.local/share/twingate-quick-access'
    backup = state / 'backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    staged = Path(tempfile.mkdtemp(prefix='.twingate-stage-', dir=destination.parent))
    try:
        if restore:
            source = Path(restore).resolve()
            if json.loads((source / 'metadata.json').read_text()).get('uuid') != UUID:
                raise SystemExit(f"Backup UUID does not match {METADATA['name']}.")
            shutil.copytree(source, staged, dirs_exist_ok=True)
        else:
            stage(staged)
        if destination.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(destination, backup)
            # Keep the old directory until the replacement is fully staged.
            old = staged.with_name(staged.name + '-previous')
            os.rename(destination, old)
            try:
                os.rename(staged, destination)
            except BaseException:
                os.rename(old, destination)
                raise
            shutil.rmtree(old)
        else:
            os.rename(staged, destination)
        state.mkdir(parents=True, exist_ok=True)
        (state / 'last-install.json').write_text(json.dumps({
            'installed': str(destination), 'backup': str(backup) if backup.exists() else None,
            'version': json.loads((destination / 'metadata.json').read_text())['version-name'],
        }, indent=2) + '\n')
        print(f'Installed: {destination}')
        if backup.exists(): print(f'Rollback backup: {backup}')
        print('Log out and back in to load the new JavaScript modules. No session or network service was restarted.')
    finally:
        if staged.exists(): shutil.rmtree(staged)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', type=Path, help='Restore a backup created by this installer.')
    install(parser.parse_args().restore)
