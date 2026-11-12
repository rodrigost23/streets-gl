export interface OverpassFailure {
	status?: number;
	retryAfterSeconds?: number;
}

interface EndpointState {
	failures: number;
	cooldownUntil: number;
	lastUsed: number;
}

// Statuses that mean "this server is busy or limiting us", per the Overpass usage policy: wait before retrying.
const RateLimitStatuses = new Set([406, 429, 502, 503, 504]);
const RateLimitBaseCooldown = 30_000;
const GenericBaseCooldown = 10_000;
const MaxCooldown = 300_000;

/**
 * Tracks the health of Overpass endpoints. A failing endpoint is put on an exponentially growing cooldown,
 * and requests are spread over the endpoints that are not cooling down.
 */
export default class OverpassEndpointPool {
	private readonly states: Map<string, EndpointState> = new Map();

	public constructor(private readonly now: () => number = Date.now) {
	}

	/**
	 * Returns the least recently used endpoint that is not in cooldown, or null if there is none.
	 */
	public acquire(urls: string[]): string | null {
		const now = this.now();
		let best: string = null;
		let bestLastUsed = Infinity;

		for (const url of urls) {
			const state = this.getState(url);

			if (state.cooldownUntil <= now && state.lastUsed < bestLastUsed) {
				best = url;
				bestLastUsed = state.lastUsed;
			}
		}

		if (best !== null) {
			this.getState(best).lastUsed = now;
		}

		return best;
	}

	/**
	 * Milliseconds until at least one of the endpoints can be used. 0 if one is available now.
	 */
	public getWaitTime(urls: string[]): number {
		const now = this.now();
		let wait = Infinity;

		for (const url of urls) {
			wait = Math.min(wait, Math.max(0, this.getState(url).cooldownUntil - now));
		}

		return wait;
	}

	public reportSuccess(url: string): void {
		const state = this.getState(url);

		state.failures = 0;
		state.cooldownUntil = 0;
	}

	/**
	 * Puts the endpoint on cooldown and returns the cooldown duration in ms.
	 */
	public reportFailure(url: string, failure: OverpassFailure = {}): number {
		const state = this.getState(url);
		const base = RateLimitStatuses.has(failure.status) ? RateLimitBaseCooldown : GenericBaseCooldown;

		state.failures++;

		let cooldown = Math.min(base * 2 ** (state.failures - 1), MaxCooldown);

		if (failure.retryAfterSeconds !== undefined && Number.isFinite(failure.retryAfterSeconds)) {
			cooldown = Math.max(cooldown, Math.min(failure.retryAfterSeconds * 1000, MaxCooldown));
		}

		state.cooldownUntil = this.now() + cooldown;

		return cooldown;
	}

	/**
	 * Errors caused by the query or the client (not by server load) are not worth retrying.
	 */
	public static isRetryable(failure: OverpassFailure): boolean {
		const status = failure.status;

		if (status === undefined) {
			return true; // network error, timeout or malformed response
		}

		return status >= 500 || status === 406 || status === 408 || status === 429;
	}

	private getState(url: string): EndpointState {
		let state = this.states.get(url);

		if (!state) {
			state = {failures: 0, cooldownUntil: 0, lastUsed: 0};
			this.states.set(url, state);
		}

		return state;
	}
}
