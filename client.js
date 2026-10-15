// SPDX-License-Identifier: GPL-3.0-or-later
import {cleanText, parseStatus, parseResources, parseAccounts, parseExitNodes,
    capabilitiesFromHelp, isEmptyListMessage, isProbeable} from './model.js';

const CLI = '/usr/bin/twingate';
const NOTIFIER = '/usr/bin/twingate-notifier';
const SYSTEMCTL = '/usr/bin/systemctl';
const SERVICE = 'twingate.service';

function failure(result) {
    const detail = cleanText(result.stderr || result.stdout).replace(/\n/g, ' ').slice(0, 240);
    return new Error(detail || 'The client could not complete this request. Check that it is configured and try again.');
}

export class TwingateClient {
    constructor(runner) {
        this.runner = runner;
        this.capabilities = {};
    }

    async command(args, timeout = 10000) {
        const result = await this.runner.run([CLI, '-d', ...args], timeout);
        if (!result.ok) throw failure(result);
        return result.stdout;
    }

    async list(args, parse) {
        const result = await this.runner.run([CLI, '-d', ...args]);
        if (!result.ok && isEmptyListMessage(result.stdout || result.stderr)) return [];
        if (!result.ok) throw failure(result);
        return parse(result.stdout);
    }

    async discover() {
        const help = await this.command(['--help']);
        let notifierHelp = '';
        try {
            const result = await this.runner.run([NOTIFIER, '--help']);
            if (result.ok) notifierHelp = result.stdout;
        } catch (error) {
            // Without the notifier, resume falls back to `twingate connect`.
            if (error.kind === 'cancelled') throw error;
        }
        this.capabilities = capabilitiesFromHelp(help, notifierHelp);
        return {capabilities: this.capabilities, version: cleanText(help).split('\n')[0]};
    }

    async status() {
        const result = await this.runner.run([CLI, '-d', 'status']);
        const state = parseStatus(result.stdout);
        if (state === 'error')
            throw new Error('Could not read the client status. Check the Twingate service and refresh.');
        // Twingate versions can return a nonzero exit code for an offline status.
        return state;
    }
    async resources() { return this.list(['resources'], parseResources); }
    async accounts() { return this.list(['account', 'list'], parseAccounts); }
    async exitNodes() { return this.list(['exit-node', 'list'], parseExitNodes); }

    async serviceActive() {
        const result = await this.runner.run([SYSTEMCTL, 'is-active', '--quiet', SERVICE]);
        return result.ok;
    }

    async service(operation) {
        // systemd uses the desktop's polkit agent. The CLI's service-start/stop
        // wrappers invoke sudo, which cannot prompt from a Shell subprocess.
        if (!['start', 'stop'].includes(operation)) throw new Error('Unknown service operation');
        const result = await this.runner.run([SYSTEMCTL, operation, SERVICE], 120000);
        if (!result.ok)
            throw new Error(`Could not ${operation} Twingate. Approve the system authentication prompt and try again. If it keeps failing, check the twingate.service logs.`);
    }

    async action(name, arg = '') {
        if (name === 'authenticateNotification') {
            // Resolve the notifier's display text against a fresh resource list. Names
            // can contain " - " and parentheses, so splitting the body would be unsafe.
            const resources = await this.resources();
            const body = cleanText(arg);
            const matches = resources.filter(resource => {
                const {name: resourceName, address, alias} = resource;
                return [`${resourceName} - ${address}`,
                    ...(alias ? [`${resourceName} - ${alias}(${address})`, `${resourceName} - ${alias} (${address})`] : [])]
                    .includes(body);
            });
            if (matches.length !== 1 || resources.filter(resource => resource.name === matches[0].name).length !== 1)
                throw new Error('This notification no longer identifies a unique available resource. Open Twingate and use the resource’s key button.');
            return this.action('authenticate', matches[0].name);
        }
        if (name === 'start') {
            // systemd asks for authorization even when the unit is already active.
            if (!await this.serviceActive()) await this.service('start');
            // Restarts the desktop notifier after Stop client, then waits for the daemon.
            const output = await this.command(['start'], 90000);
            // With the daemon running, `twingate start` only waits: it exits successfully
            // without reconnecting a stopped connection, so send the request Resume uses.
            if (this.capabilities.resume === 'notifier' && ['paused', 'offline'].includes(await this.status().catch(() => '')))
                await this._sdwanStart();
            return output;
        }
        if (name === 'stop') {
            await this.service('stop');
            return this.command(['desktop-stop']);
        }
        if (name === 'resume' && this.capabilities.resume === 'notifier') {
            // In background daemon mode, `twingate connect` writes a root-owned intention
            // file through sudo, which cannot prompt here. This sends the same request.
            return this._sdwanStart();
        }
        // Restarting the notifier re-registers the desktop session, so the daemon can
        // deliver its sign-in prompt. `twingate auth` only handles individual resources.
        const commands = {
            resume: ['connect'], pause: ['disconnect'], signIn: ['desktop-restart'],
            authenticate: ['auth', arg], switchAccount: ['account', 'switch', arg],
            exitStart: ['exit-node', 'start', arg], exitSwitch: ['exit-node', 'switch', arg], exitStop: ['exit-node', 'stop'],
        };
        if (!Object.hasOwn(commands, name)) throw new Error('Unknown client action');
        if (['authenticate', 'switchAccount', 'exitStart', 'exitSwitch'].includes(name) && (!arg || arg.startsWith('-')))
            throw new Error('This item cannot be passed safely to the client. Use the Twingate CLI to manage it.');
        return this.command(commands[name], name === 'authenticate' ? 180000 : 90000);
    }

    async _sdwanStart() {
        const result = await this.runner.run([NOTIFIER, 'sdwan-start'], 30000);
        if (!result.ok) throw failure(result);
        return result.stdout;
    }

    async probe(address) {
        if (!isProbeable(address)) return 'unsupported';
        const result = await this.runner.run(['ping', '-n', '-c', '1', '-W', '2', '--', address], 4000);
        return result.ok ? 'reply' : 'no-reply';
    }
    dispose() { this.runner.dispose(); }
}
