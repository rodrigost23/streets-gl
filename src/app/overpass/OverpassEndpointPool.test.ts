import OverpassEndpointPool from "~/app/overpass/OverpassEndpointPool";

describe('OverpassEndpointPool', () => {
	const urls = ['a', 'b', 'c'];
	let time: number;
	let pool: OverpassEndpointPool;

	beforeEach(() => {
		time = 1000;
		pool = new OverpassEndpointPool(() => time);
	});

	it('should spread requests over endpoints', () => {
		const picked = [pool.acquire(urls), (time++, pool.acquire(urls)), (time++, pool.acquire(urls))];

		expect(new Set(picked).size).toBe(3);
	});

	it('should skip endpoints in cooldown', () => {
		pool.reportFailure('a', {status: 429});
		pool.reportFailure('b', {status: 502});

		for (let i = 0; i < 4; i++) {
			time++;
			expect(pool.acquire(urls)).toBe('c');
		}
	});

	it('should return null and report wait time if every endpoint is cooling down', () => {
		for (const url of urls) {
			pool.reportFailure(url, {status: 504});
		}

		expect(pool.acquire(urls)).toBeNull();
		expect(pool.getWaitTime(urls)).toBe(30_000);

		time += 30_000;

		expect(pool.getWaitTime(urls)).toBe(0);
		expect(pool.acquire(urls)).not.toBeNull();
	});

	it('should back off exponentially, capped, and reset on success', () => {
		expect(pool.reportFailure('a', {status: 429})).toBe(30_000);
		expect(pool.reportFailure('a', {status: 429})).toBe(60_000);
		expect(pool.reportFailure('a', {status: 429})).toBe(120_000);

		for (let i = 0; i < 10; i++) {
			pool.reportFailure('a', {status: 429});
		}

		expect(pool.reportFailure('a', {status: 429})).toBe(300_000);

		pool.reportSuccess('a');

		expect(pool.getWaitTime(['a'])).toBe(0);
		expect(pool.reportFailure('a', {status: 429})).toBe(30_000);
	});

	it('should use a shorter cooldown for network errors and honour Retry-After', () => {
		expect(pool.reportFailure('a')).toBe(10_000);
		expect(pool.reportFailure('b', {status: 429, retryAfterSeconds: 90})).toBe(90_000);
	});

	it('should tell retryable failures from permanent ones', () => {
		expect(OverpassEndpointPool.isRetryable({})).toBe(true);
		expect(OverpassEndpointPool.isRetryable({status: 429})).toBe(true);
		expect(OverpassEndpointPool.isRetryable({status: 502})).toBe(true);
		expect(OverpassEndpointPool.isRetryable({status: 400})).toBe(false);
		expect(OverpassEndpointPool.isRetryable({status: 404})).toBe(false);
	});
});
