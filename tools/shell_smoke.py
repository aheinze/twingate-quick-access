#!/usr/bin/env python3
"""Run the build in an isolated headless GNOME Shell and operate its real menus.

The nested Shell gets its own D-Bus session, settings, data, cache, and runtime
directories, so the desktop session and its preferences are never touched. It reads
the live client status and resources. --live-actions also clicks Pause and Resume,
which interrupts private resources for a few seconds.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from package import stage

ROOT = Path(__file__).resolve().parent.parent
UUID = json.loads((ROOT / 'metadata.json').read_text())['uuid']
PROBE = 'twingate-panel-probe@test'
KEYFILE = f"""[org/gnome/shell]
enabled-extensions=['{UUID}', '{PROBE}']
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/twingate-panel]
show-panel-icon=true
"""


def run_shell(work, screenshots, live_actions):
    data, config = work / 'data', work / 'config'
    extensions = data / 'gnome-shell/extensions'
    (extensions / UUID).mkdir(parents=True)
    stage(extensions / UUID)
    shutil.copytree(ROOT / 'tests/shell-probe', extensions / PROBE)
    (config / 'glib-2.0/settings').mkdir(parents=True)
    (config / 'glib-2.0/settings/keyfile').write_text(KEYFILE)
    screenshots.mkdir(parents=True, exist_ok=True)
    # Wayland socket paths are limited to 108 bytes, so the runtime directory stays short.
    runtime = Path(tempfile.mkdtemp(prefix='tp-', dir='/tmp'))
    env = {key: value for key, value in os.environ.items()
           if key not in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS')}
    env.update(XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(config), XDG_CACHE_HOME=str(work / 'cache'),
               XDG_STATE_HOME=str(work / 'state'), XDG_RUNTIME_DIR=str(runtime), GSETTINGS_BACKEND='keyfile',
               TP_SHOTS=str(screenshots), TP_LIVE_ACTIONS='1' if live_actions else '0')
    try:
        result = subprocess.run(['dbus-run-session', '--', 'gnome-shell', '--headless', '--wayland', '--no-x11',
                                 '--virtual-monitor', '1280x800', '--wayland-display', 'wl-tp-smoke'],
                                env=env, cwd=work, capture_output=True, text=True, timeout=180)
    finally:
        shutil.rmtree(runtime, ignore_errors=True)
    return result.stdout + result.stderr


def check(log, live_actions):
    results = {}
    for key, value in re.findall(r'TPPROBE (\S+) (.*)$', log, re.MULTILINE):
        results[key] = json.loads(value)
    failures = []

    def expect(condition, message):
        if not condition:
            failures.append(message)

    expect('done' in results, 'probe did not finish')
    expect('fatal' not in results, f"probe failed: {results.get('fatal')}")
    errors = [line for line in log.splitlines() if re.search(r'JS ERROR|JS WARNING|Gjs-CRITICAL', line)]
    expect(not errors, 'Shell logged JavaScript errors:\n  ' + '\n  '.join(errors[:10]))
    expect(results.get('extension', {}).get('state') == 1, f"extension not active: {results.get('extension')}")
    expect(results.get('qs-open', {}).get('details') is False, 'opening Quick Settings loaded details')
    menu = results.get('qs-menu', {})
    if menu.get('status') == 'online':
        expect(menu.get('resourcesLoaded'), 'resources did not load in the expanded tile menu')
        expect(not menu.get('feedback') and not menu.get('resourceError') and not menu.get('exitError'),
               f'menu shows an error: {menu}')
    expect(results.get('accounts-submenu', {}).get('open'), 'Accounts submenu did not stay open')
    expect(results.get('compact-overflow') == {'fits': True, 'scrollable': True, 'lastActionVisible': True},
           f"expanded Quick Settings controls are not reachable: {results.get('compact-overflow')}")
    expect(results.get('compact-keyboard') == {'lastActionVisible': True},
           f"keyboard focus did not reveal the selected action: {results.get('compact-keyboard')}")
    expect(results.get('icon-tooltips') == dict.fromkeys(['delayed', 'hovered', 'left', 'keyboard', 'blurred'], True),
           f"icon tooltips did not follow hover and keyboard focus: {results.get('icon-tooltips')}")
    expect(results.get('tooltip-closed') == {'hidden': True, 'timer': 0},
           f"closing the menu left a tooltip behind: {results.get('tooltip-closed')}")
    expect(results.get('tooltip-disabled') == {'destroyed': True, 'timer': 0},
           f"disabling did not clean up tooltips: {results.get('tooltip-disabled')}")
    expect(results.get('lifecycle-destroyed') == dict.fromkeys(['panel', 'indicator', 'toggle', 'menu', 'scroll'], 1),
           f"disabling did not destroy every owned actor exactly once: {results.get('lifecycle-destroyed')}")
    click = results.get('account-click', {})
    if click.get('accounts') == 1:
        expect(click.get('acts') == [], f'selecting the account in use switched accounts: {click}')
    controls = results.get('controls-submenu', {})
    expect(controls.get('open') and not controls.get('accountsOpen'), f'sibling submenus misbehave: {controls}')
    expect(results.get('re-enabled', {}).get('state') == 1, f"re-enable failed: {results.get('re-enabled')}")
    expect(results.get('notification-muted') == {'inList': True, 'actions': ['Authenticate'], 'bannerRequests': 0, 'queued': False},
           f"muted notification lost its action or requested a banner: {results.get('notification-muted')}")
    expect(results.get('notification-exceptions') == {'signIn': True, 'otherApp': True},
           f"unrelated notifications were muted: {results.get('notification-exceptions')}")
    expect(results.get('notification-unmuted') == {'bannerRequests': 1, 'queued': True},
           f"turning popups back on failed: {results.get('notification-unmuted')}")
    expect(results.get('notification-disabled') == {'queued': True, 'restoredEmit': True},
           f"disabling did not restore notification delivery: {results.get('notification-disabled')}")
    expect(results.get('notification-reenabled') == {'inList': True, 'sameSource': True, 'queued': False},
           f"re-enabling failed to mute an existing source: {results.get('notification-reenabled')}")
    expect(results.get('notification-authenticate') == {'commands': [
        ['/usr/bin/twingate', '-d', 'resources'], ['/usr/bin/twingate', '-d', 'auth', 'Example NAS']],
        'dismissed': True, 'error': ''},
        f"the actual Authenticate button did not invoke resource authentication: {results.get('notification-authenticate')}")
    expect(results.get('notification-recovery') == {'quickSettings': True, 'tile': True, 'panel': False, 'feedback': True},
           f"failed authentication did not open visible recovery controls: {results.get('notification-recovery')}")
    if live_actions and results.get('before-pause', {}).get('status') == 'online':
        expect(results.get('pause-busy', {}).get('busy') == 'pause', 'Pause did not show progress')
        expect(results.get('pause', {}).get('status') == 'paused', f"Pause did not settle: {results.get('pause')}")
        expect(results.get('resume', {}).get('status') == 'online', f"Resume failed: {results.get('resume')}")
    return results, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--live-actions', action='store_true', help='Also click Pause and Resume on the real client.')
    parser.add_argument('--screenshots', type=Path, default=ROOT / 'dist/shell-smoke',
                        help='Directory for PNG screenshots (default: dist/shell-smoke).')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='twingate-shell-smoke-') as temp:
        log = run_shell(Path(temp), args.screenshots.resolve(), args.live_actions)
    # The full Shell log stays next to the screenshots for diagnosing a failure.
    (args.screenshots / 'shell.log').write_text(log)
    results, failures = check(log, args.live_actions)
    for key, value in results.items():
        print(f'{key}: {json.dumps(value)[:300]}')
    if failures:
        print('\nFAIL\n- ' + '\n- '.join(failures))
        sys.exit(1)
    print(f'\nPASS real GNOME Shell smoke test. Screenshots: {args.screenshots}')


if __name__ == '__main__':
    main()
