# Packaging and rollback integration test in an isolated temporary home.

import importlib.util, pathlib, tempfile, json, hashlib, sys
root = pathlib.Path.cwd()
sys.path.insert(0, str(root / 'tools'))
import package, install
first = package.build()
digest = hashlib.sha256(first.read_bytes()).hexdigest()
second = package.build()
assert hashlib.sha256(second.read_bytes()).hexdigest() == digest
with tempfile.TemporaryDirectory(prefix='twingate-install-test-') as temp:
    fake_home = pathlib.Path(temp)
    destination = fake_home / '.local/share/gnome-shell/extensions/twingate-panel@urhend'
    destination.mkdir(parents=True)
    (destination / 'metadata.json').write_text(json.dumps({'uuid':'twingate-panel@urhend','version-name':'original'}))
    (destination / 'extension.js').write_text('original extension')
    install.Path.home = classmethod(lambda cls: fake_home)
    install.install()
    assert 'QuickSettings' in (destination / 'extension.js').read_text()
    assert (destination / 'schemas/gschemas.compiled').is_file()
    assert (destination / 'icons/twingate-panel-symbolic.svg').read_text().startswith('<svg')
    record = json.loads((fake_home / '.local/share/twingate-panel/last-install.json').read_text())
    backup = pathlib.Path(record['backup'])
    assert (backup / 'extension.js').read_text() == 'original extension'
    install.install(backup)
    assert (destination / 'extension.js').read_text() == 'original extension'
    assert json.loads((destination / 'metadata.json').read_text())['version-name'] == 'original'
print('PASS reproducible ZIP and installation rollback')
