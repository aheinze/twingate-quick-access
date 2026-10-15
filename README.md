# Twingate Panel 2.0

Private access, at home in GNOME. A community interface for the official Twingate Linux client.

This fork is maintained by [aheinze](https://github.com/aheinze) at [aheinze/twingate-panel](https://github.com/aheinze/twingate-panel). Based on [Twingate Panel 1.0.6 by urhend](https://github.com/urhend/twingate-panel), the original author.

Not affiliated with or endorsed by Twingate Inc. The Twingate name and logo are trademarks of Twingate Inc. and identify the client this extension controls. The original GPL-3.0-or-later license applies.

## Features

- A native Quick Settings tile, plus an optional dedicated panel shortcut. Both share one connection controller.
- The Quick Settings dropdown keeps small resource lists easy to scan, shows search for more than five resources, and keeps active filters visible. Account switching appears when there is more than one account; diagnostics, account setup, and client controls are under Options.
- The Twingate mark is the icon. It is a symbolic SVG, so GNOME recolors it to match the panel and theme. The panel icon is dimmed while you are not connected. Sign-in required, errors, and a missing client show a distinct icon so they stand out.
- Pause and resume keep your session and tokens. Neither requires an administrator password.
- Connect starts a stopped client through systemd's normal GNOME authentication prompt. If the service is already running, there is no prompt.
- A resource list with search (by name, address, or alias), persistent favorites, and the client's authentication status. Select a resource to copy its address. The key button requests resource authentication.
- Save explicit website destinations in Preferences → Resource links. An Open button then appears beside the matching resource address or alias. URLs are never guessed, and no shell commands are run.
- Account switching, and exit-node routing when your network has exit nodes.
- Optional, on-demand ICMP checks. A missing reply is not treated as proof that an application is down.
- Preferences → Notifications → Resource authentication popups controls the official notifier's “Additional authentication required” banners. Turn it off to keep requests and their Authenticate buttons in the notification list without popups. Account sign-in prompts still appear. The setting takes effect for new and repeated requests while the extension is enabled; an already visible banner can be dismissed normally.
- Diagnostics copied from the footer exclude account identities, resource addresses, raw command output, and tokens.

## How it drives the client

All commands run as the desktop user with an argument vector, never a shell string, and with timeouts. The Twingate CLI's own `service-start`, `service-stop`, and (in background daemon mode) `connect` use `sudo`, which cannot ask for a password from inside GNOME Shell. The extension therefore avoids them:

| Action | Command | Notes |
|---|---|---|
| Status | `twingate status` | `online`, `offline`, `disconnected` (paused), `authenticating`, `not-running` |
| Pause | `twingate disconnect` | No privileges needed |
| Resume, or Connect while offline | `twingate-notifier sdwan-start` | The request `twingate connect` sends after writing a root-owned intention file with `sudo`. Falls back to `twingate connect` if the notifier lacks the command. |
| Connect while stopped | `systemctl start twingate.service`, then `twingate start` | systemd uses the GNOME polkit prompt; skipped when the service is already active. `twingate start` restarts the desktop notifier and waits for the daemon. If the daemon is running but not connected, it exits successfully without reconnecting, so the extension then sends `twingate-notifier sdwan-start`. |
| Stop client | `systemctl stop twingate.service`, then `twingate desktop-stop` | |
| Sign in | `twingate desktop-restart` | Re-registers the desktop session so the official notifier shows "Sign in to Connect" |
| Resource authentication | `twingate auth <resource name>` | The official notifier opens the browser |
| Authenticate in a resource notification | `twingate resources`, then `twingate auth <resource name>` | Resolves the notification against the current resource list and uses the same serialized controller as the menu. This avoids the official notifier's unresponsive button callback. |
| Switch account | `twingate account switch <email:network>` | The account in use is not switched to again |
| Traffic routing | `twingate exit-node start <node>`, `exit-node switch <node>` when another node is active, `exit-node stop` | |
| Lists | `twingate resources`, `account list`, `exit-node list` | An empty list exits nonzero with a sentence such as "No exit nodes are available". This is shown as empty, not as an error. |

Pause, resume, and connect take effect asynchronously in the daemon. Each action stays busy ("Pausing…") until the daemon reports the new state, for at most 10 seconds, so a repeated click cannot reverse it. Every reconnect passes through `authenticating` for about half a second, so that state counts as "Sign-in required" only when it persists for three checks.

The connection status is polled in the background, six times less often than the configured interval. When the status changes, it is read again after 2 seconds, so a passing step of a reconnect is not shown for the full interval. Resources, accounts, and exit nodes are read only while a Twingate menu is open; clicking Authenticate in a notification also reads resources once to identify the requested resource. Each resource listing makes the official client log the full resource list to the journal, so it is not done continuously.

## Installation

The official client must already be installed and configured. This extension does not install, reconfigure, or replace the network daemon.

```sh
python3 tools/install.py
```

The installer backs up the existing extension under `~/.local/share/twingate-panel/backups/`, stages the new files, and records the backup path in `~/.local/share/twingate-panel/last-install.json`. Preferences are preserved. Log out and back in to load the new code. The installer does not restart your desktop or network connection.

To restore a previous version:

```sh
python3 tools/install.py --restore /absolute/path/to/the/backup
```

## Compatibility

| Component | Status |
|---|---|
| GNOME 50 | Verified on 50.5 in a real headless GNOME Shell: menus, submenus, Quick Settings, enable/disable cycles, and Pause → Resume through the actual buttons. |
| GNOME 51 | Verified on 51.1 in an isolated headless GNOME Shell: menus, Quick Settings, notification filtering, and enable/disable cycles. |
| Twingate client | Verified against 2026.239.6882 (libsdwan 0.196.0). Status, pause, resume, `twingate start` from a paused daemon, sign-in, and every list were exercised live. The parser fixtures are its real output with personal data replaced. |

Resource authentication was exercised against the real client: the browser opened, authentication succeeded, and the resource reported a future authentication expiry. The notification button is also activated in the isolated Shell test with only the CLI transport stubbed.

Not yet exercised live: starting the service after Stop client (needs the administrator password at the system prompt), switching between multiple accounts and exit-node routing (the test network has one account and no exit nodes), and the browser sign-in after an expired session.

## Tests

```sh
npm test               # parsers, client commands, controller races, menus, lifecycle
npm run test:gjs       # real Gio.Subprocess runner: argv, timeouts, cancellation, reaping
npm run test:platform  # real St/Clutter/libadwaita contracts, stylesheet, schema (Fedora library paths)
npm run test:package   # reproducible ZIP and install/rollback in a temporary home
python3 tools/shell_smoke.py                  # real headless GNOME Shell, read-only
python3 tools/shell_smoke.py --live-actions   # also clicks Pause and Resume (interrupts access for a few seconds)
```

`tests/fixtures/` holds real client output. When a new client version changes its output, capture it there first. The shell smoke test runs with its own D-Bus session, settings, and runtime directory. It saves screenshots and the full Shell log to `dist/shell-smoke/` and fails on any JavaScript error.

## Release packages

```sh
npm run build
```

ZIP files and SHA-256 checksums are written to `dist/`. Builds use sorted files and fixed timestamps, and download nothing.

## Changelog

### 2.0.5

- Added: Delayed tooltips for icon buttons in Quick Settings and the panel menu, including resource actions, favorites, refresh, preferences, help, and diagnostics. Labels also appear on keyboard focus and follow the current action.
- Tooltips use the Shell theme, stay within the monitor, and dismiss on click, scrolling, menu close, or disable.

### 2.0.4

- Fixed: Failed notification authentication opens Quick Settings when the separate panel shortcut is hidden, keeping the error and retry controls accessible.
- Fixed: The Quick Settings dropdown scrolls within the available screen height so expanded submenus stay reachable. Keyboard focus reveals off-screen controls, and resource rows retain a usable minimum height.
- Tests: Verify recovery through the real GNOME notification action, scrolling and keyboard visibility on short screens, and filters staying clearable after a list refresh.

### 2.0.3

- Refined the Quick Settings dropdown with native typography, tighter spacing, a quiet connection row, and concise resource addresses and session expiry.
- Search appears for larger lists and stays available while a filter is active. A single account is shown in the connection subtitle; account switching remains available for multiple accounts.
- Reduced the footer to refresh and preferences, with diagnostics and setup under Options.

### 2.0.2

- Fixed: Authenticate in resource notifications now initiates authentication through the working CLI command, including notifications already in the list and those with popups muted. Busy requests remain retryable, and failures show a message and open the Twingate menu.
- Tests: Click the real notification action in the isolated GNOME Shell; verify current-resource matching, stale/ambiguous requests, unrelated actions, and cleanup on disable.

### 2.0.1

- Added: A separate switch for resource authentication popups from `twingate-notifier`. Muted requests retain their Authenticate action in GNOME's notification list; sign-in and other applications' notifications are unaffected.
- Added: GNOME 51 support and real-Shell checks for critical authentication requests, replacements, toggling the setting, and restoring normal delivery when disabled.

### 2.0.0

- Fixed: Resume failed with a `sudo` error. It now uses the notifier's `sdwan-start` request, which needs no privileges.
- Fixed: Sign in always failed ("Resource name must be specified"). It now restarts the official notifier so its sign-in prompt appears.
- Fixed: Accounts and Traffic routing could not be opened, because GNOME closes a submenu's parent when a nested submenu opens. They are now top-level submenus.
- Fixed: Traffic routing reported "Routing details unavailable" when there were no exit nodes, and an empty resource list was reported as an error.
- Fixed: Clicking Pause or Resume showed the old state for about a second, so a second click repeated the action.
- Fixed: Connect did nothing when the daemon was running but not connected: `twingate start` only waits in that case. The extension now sends the resume request itself.
- Fixed: A reconnect could show "Sign-in required" for up to 30 seconds, and announce "Connected" again after each network change.
- Fixed: Selecting the account in use switched to it again, and selecting another exit node while one was active used `start` instead of `switch`.
- Fixed: Connect asked for an administrator password even when the service was already running.
- Fixed: The "Connected" notification appeared at every login and screen unlock.
- Fixed: The Quick Settings subtitle could be 30 seconds stale when Quick Settings opened.
- Added: Resource aliases (shown, searchable, and usable for saved links) and the client's authentication status.
- Changed: The panel, Quick Settings, menu, and preferences use the Twingate mark instead of a generic VPN icon. `icons/twingate-panel-symbolic.svg` is traced from the official wordmark in `icons/`.
- Changed: Background polling reads only the connection status, which reduces process spawns and journal noise.
- Tests: Real client output fixtures; the platform test can no longer write to the user's settings; new real-Shell smoke test.

## Code map

- `model.js`: pure parsing, search, identity, and destination validation.
- `runner.js`: bounded asynchronous Gio processes with explicit cleanup.
- `client.js`: the client adapter, with the command choices above.
- `controller.js`: one polling loop, serialized actions with state settling, and stale-result suppression.
- `menu.js`: stable resource rows and native GNOME menu components.
- `extension.js`: panel and Quick Settings integration, notifications, and lifecycle.
- `prefs.js`: native libadwaita preferences and user-defined website links.

`ping-interval-seconds` is retained only for rollback compatibility. When the account list does not identify the active account and there are several accounts, the UI shows the account count rather than guessing.
