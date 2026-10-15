// SPDX-License-Identifier: GPL-3.0-or-later
// Dependency-injected so races, failures, and lifecycle behavior can be tested without a desktop.

// The daemon applies connection changes asynchronously, about a second after the command
// returns. Until it reports one of these, the action stays busy, so a second click cannot
// repeat it (Pause twice instead of Pause, Resume).
const SETTLED = {pause: ['paused', 'offline', 'not-running'], resume: ['online', 'authenticating'],
    start: ['online', 'authenticating'], stop: ['not-running']};
const SETTLE_INTERVAL = 500;
const SETTLE_ATTEMPTS = 20;
// Every reconnect passes through 'authenticating' for about half a second. It means
// sign-in is required only when it persists.
const SIGN_IN_CHECKS = 3;
// A changed status is often a step of a reconnect, so it is confirmed soon.
const CONFIRM_DELAY = 2000;

export class Controller {
    constructor(client, scheduler, onChange) {
        this.client = client;
        this.scheduler = scheduler;
        this.onChange = onChange;
        this.state = {status: 'unknown', resources: [], accounts: [], exitNodes: [],
            capabilities: {}, version: '', busy: '', error: '', actionError: '', resourceError: '', accountError: '',
            exitError: '', resourcesLoaded: false, refreshing: false, updatedAt: 0};
        this._disposed = false;
        this._generation = 0;
        this._refreshPromise = null;
        this._refreshDetails = false;
        this._timer = null;
        this._delays = new Map();
        this._details = false;
        this._interval = 5000;
        this._discovered = false;
    }

    _emit(patch) {
        if (this._disposed) return;
        this.state = {...this.state, ...patch};
        this.onChange(this.state);
    }

    setPolling(interval, details) {
        this._interval = interval * 1000;
        this._details = details;
        this._schedule();
    }

    _schedule(delay = this._interval * (this._details ? 1 : 6)) {
        if (this._timer !== null) this.scheduler.cancel(this._timer);
        this._timer = null;
        if (!this._disposed)
            this._timer = this.scheduler.later(delay, () => {
                this._timer = null;
                void this.refresh();
            });
    }

    refresh() {
        if (this._disposed || this.state.busy) return Promise.resolve();
        if (this._refreshPromise) {
            // A background poll skips details, so an opening menu needs a full read after it.
            if (this._details && !this._refreshDetails)
                return this._refreshPromise.then(() => this.refresh());
            return this._refreshPromise;
        }
        this._refreshDetails = this._details;
        const previous = this.state.status;
        this._refreshPromise = this._read(this._details).finally(() => {
            this._refreshPromise = null;
            this._schedule(this.state.status !== previous ? CONFIRM_DELAY : undefined);
        });
        return this._refreshPromise;
    }

    retry() {
        this._emit({actionError: ''});
        return this.refresh();
    }

    // Background polls read only the status (and accounts once) for the panel indicators.
    // Every resource listing makes the client log its full JSON to the journal.
    async _read(details) {
        const generation = this._generation;
        const current = () => !this._disposed && generation === this._generation;
        this._emit({refreshing: true});
        try {
            if (!this._discovered) {
                const discovery = await this.client.discover();
                if (!current()) return;
                this._discovered = true;
                this._emit(discovery);
            }
            const status = await this.client.status();
            if (!current()) return;
            this._emit({status, error: '', updatedAt: Date.now(),
                ...(status !== 'online' ? {resources: [], resourceError: '', resourcesLoaded: false, exitNodes: [], exitError: ''} : {})});
            const {capabilities} = this.state;
            const loadResources = status === 'online' && details;
            const tasks = [
                ['accounts', 'accountError', capabilities.accounts && (details || !this.state.accounts.length) ? () => this.client.accounts() : null],
                ['resources', 'resourceError', loadResources ? () => this.client.resources() : null],
                ['exitNodes', 'exitError', loadResources && capabilities.exitNodes ? () => this.client.exitNodes() : null],
            ];
            const results = await Promise.all(tasks.map(async ([key, errorKey, load]) => {
                if (!load) return {};
                try {
                    const value = await load();
                    return {[key]: value, [errorKey]: ''};
                } catch (error) {
                    return {[key]: [], [errorKey]: error.message};
                }
            }));
            // Account labels and resources are committed as one snapshot, not piecemeal.
            if (current()) this._emit(Object.assign({}, ...results, loadResources ? {resourcesLoaded: true} : {}));
        } catch (error) {
            if (current()) this._emit({status: error.kind === 'missing' ? 'missing' : 'error',
                error: error.message, resources: [], resourcesLoaded: false, exitNodes: []});
        } finally {
            if (current()) this._emit({refreshing: false});
        }
    }

    async act(name, arg = '') {
        if (this._disposed || this.state.busy) return false;
        ++this._generation; // An older refresh must not overwrite an action or account switch.
        this._emit({busy: name, error: '', actionError: '', refreshing: false,
            ...(name === 'switchAccount' ? {resources: [], resourcesLoaded: false, exitNodes: [], accounts: []} : {})});
        let errorMessage = '';
        try {
            await this.client.action(name, arg);
            if (SETTLED[name]) await this._settle(SETTLED[name]);
        } catch (error) {
            errorMessage = error.message;
        }
        if (this._disposed) return false;
        // Drain the superseded read before starting the authoritative post-action refresh.
        if (this._refreshPromise) await this._refreshPromise;
        if (this._disposed) return false;
        this._emit({busy: ''});
        await this.refresh();
        if (errorMessage) this._emit({actionError: errorMessage});
        this._schedule(2000);
        return !errorMessage;
    }

    async _settle(expected) {
        let signIn = 0;
        for (let attempt = 0; attempt < SETTLE_ATTEMPTS && !this._disposed; attempt++) {
            let status;
            try {
                status = await this.client.status();
            } catch {
                return; // The post-action refresh reports the failure.
            }
            signIn = status === 'authenticating' ? signIn + 1 : 0;
            if (expected.includes(status) && (status !== 'authenticating' || signIn >= SIGN_IN_CHECKS)) return;
            await this._delay(SETTLE_INTERVAL);
        }
    }

    _delay(ms) {
        return new Promise(resolve => {
            const id = this.scheduler.later(ms, () => {
                this._delays.delete(id);
                resolve();
            });
            this._delays.set(id, resolve);
        });
    }

    primaryAction() {
        const {status, capabilities} = this.state;
        if (['unknown', 'connecting'].includes(status)) return Promise.resolve(false);
        if (status === 'online') return this.act(capabilities.pause ? 'pause' : 'stop');
        if (status === 'authenticating' && capabilities.signIn) return this.act('signIn');
        // The daemon is still running when paused or offline, so no administrator prompt is needed.
        if (['paused', 'offline'].includes(status) && capabilities.pause) return this.act('resume');
        return this.act('start');
    }

    dispose() {
        this._disposed = true;
        ++this._generation;
        if (this._timer !== null) this.scheduler.cancel(this._timer);
        this._timer = null;
        for (const [id, resolve] of this._delays) {
            this.scheduler.cancel(id);
            resolve();
        }
        this._delays.clear();
        this.client.dispose();
    }
}
