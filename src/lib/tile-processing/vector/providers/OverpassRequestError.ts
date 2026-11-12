export interface OverpassRequestErrorDetails {
	status?: number;
	retryAfterSeconds?: number;
}

export default class OverpassRequestError extends Error {
	public readonly status?: number;
	public readonly retryAfterSeconds?: number;

	public constructor(message: string, details: OverpassRequestErrorDetails = {}) {
		super(message);

		this.name = 'OverpassRequestError';
		this.status = details.status;
		this.retryAfterSeconds = details.retryAfterSeconds;
	}
}
