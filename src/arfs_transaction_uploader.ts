import Transaction from 'arweave/node/lib/transaction';
// import { getError } from 'arweave/node/lib/error';
import Arweave from 'arweave';
import { AxiosResponse } from 'axios';
import { writeFileSync } from 'fs';

interface Chunk {
	data_root: string;
	data_size: string;
	data_path: string;
	offset: string;
	chunk: string;
}

// Maximum amount of chunks we will upload in the body.
const MAX_CHUNKS_IN_BODY = 1;

const MAX_ERRORS = 100;

// We assume these errors are intermittent and we can try again after a delay:
// - not_joined
// - timeout
// - data_root_not_found (we may have hit a node that just hasn't seen it yet)
// - exceeds_disk_pool_size_limit
// We also try again after any kind of unexpected network errors

// Errors from /chunk we should never try and continue on.
const FATAL_CHUNK_UPLOAD_ERRORS = [
	'invalid_json',
	'chunk_too_big',
	'data_path_too_big',
	'offset_too_big',
	'data_size_too_big',
	'chunk_proof_ratio_not_attractive',
	'invalid_proof'
];

// Amount we will delay on receiving an error response but do want to continue.
const ERROR_DELAY = 1000 * 20;

export class ArFSTransactionUploader {
	private chunkOffset = 0;
	private txPosted = false;
	private totalErrors = 0;
	public uploadedChunks = 0;

	public get isComplete(): boolean {
		return this.txPosted && this.uploadedChunks === this.totalChunks;
	}

	public get totalChunks(): number {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return this.transaction.chunks!.chunks.length;
	}

	public get pctComplete(): number {
		return Math.trunc((this.uploadedChunks / this.totalChunks) * 100);
	}

	private arweave: Arweave;
	private transaction: Transaction;
	private maxConcurrentChunks: number;

	constructor({
		transaction,
		arweave,
		maxConcurrentChunks = 32
	}: {
		transaction: Transaction;
		arweave: Arweave;
		maxConcurrentChunks?: number;
	}) {
		if (!transaction.id) {
			throw new Error(`Transaction is not signed`);
		}
		if (!transaction.chunks) {
			throw new Error(`Transaction chunks not prepared`);
		}

		this.arweave = arweave;
		this.transaction = transaction;
		this.maxConcurrentChunks = maxConcurrentChunks;
	}

	/**
	 * TODO: Update this docblock, and add docs to other methods
	 *
	 * Uploads the next part of the transaction.
	 * On the first call this posts the transaction
	 * itself and on unknown subsequent calls uploads the
	 * next chunk until it completes.
	 */
	public async batchUploadChunks(): Promise<void> {
		if (this.isComplete) {
			throw new Error(`Upload is already complete`);
		}

		if (!this.txPosted) {
			await this.postTransactionHeaders();
			return;
		}

		const initialChunksToGet = Math.min(this.totalChunks - this.chunkOffset, this.maxConcurrentChunks);

		const initialChunks = (() => {
			const chunksToSend: Chunk[] = [];
			for (let index = this.chunkOffset; index < this.chunkOffset + initialChunksToGet; index++) {
				chunksToSend.push(this.transaction.getChunk(index, this.transaction.data));
			}
			return chunksToSend;
		})();

		this.chunkOffset += initialChunks.length;
		await Promise.all(initialChunks.map((chunk) => this.uploadChunk(chunk)));
	}

	private async uploadChunk(chunk: Chunk) {
		try {
			await this.retryRequestUntilMaxErrors(this.arweave.api.post(`chunk`, chunk));
		} catch (err) {
			throw new Error(`Too many errors encountered while posting chunks: ${err}`);
		}

		this.uploadedChunks++;

		if (this.chunkOffset < this.totalChunks) {
			// Start next chunk when this one finishes
			await this.uploadChunk(this.transaction.getChunk(this.chunkOffset++, this.transaction.data));
		}
		return;
	}

	// POST to /tx
	private async postTransactionHeaders(): Promise<void> {
		const uploadInBody = this.totalChunks <= MAX_CHUNKS_IN_BODY;

		// We will send the data with the headers if chunks will fit into transaction header body
		// Otherwise we send the headers with no data
		const transactionToUpload = uploadInBody
			? this.transaction
			: new Transaction(Object.assign({}, this.transaction, { data: new Uint8Array(0) }));

		try {
			await this.retryRequestUntilMaxErrors(this.arweave.api.post(`tx`, transactionToUpload));
		} catch (err) {
			throw new Error(`Too many errors encountered while posting transaction headers:  ${err}`);
		}

		this.txPosted = true;

		if (uploadInBody) {
			this.chunkOffset += MAX_CHUNKS_IN_BODY;
			this.uploadedChunks += MAX_CHUNKS_IN_BODY;
		}
		return;
	}

	private async retryRequestUntilMaxErrors(request: Promise<AxiosResponse<unknown>>) {
		let resp: AxiosResponse<unknown> | string;

		try {
			resp = await request;
		} catch (err) {
			resp = `${err}`;
		}

		if (respIsError(resp) || resp.status !== 200) {
			const error = respIsError(resp) ? resp : getError(resp);

			if (FATAL_CHUNK_UPLOAD_ERRORS.includes(error)) {
				throw new Error(`Fatal error uploading chunk ${this.chunkOffset}: ${error}`);
			} else {
				this.totalErrors++;
				if (this.totalErrors >= MAX_ERRORS) {
					throw new Error(`Unable to complete request: ${error}`);
				} else {
					// Jitter delay after failed requests -- subtract up to 30% from ERROR_DELAY
					await new Promise((res) => setTimeout(res, ERROR_DELAY - ERROR_DELAY * Math.random() * 0.3));

					// Retry the request
					await request;
				}
			}
		}
	}
}

function respIsError(resp: AxiosResponse<unknown> | string): resp is string {
	return resp === typeof 'string';
}

// Temp copy pasted from arweave-js for debugging
export function getError(resp: AxiosResponse<unknown>) {
	let data = resp.data;

	if (typeof resp.data === 'string') {
		console.log('is string');
		try {
			data = JSON.parse(resp.data);
			// eslint-disable-next-line no-empty
		} catch (e) {}
	}

	if (resp.data instanceof ArrayBuffer || resp.data instanceof Uint8Array) {
		console.log('is buffer or such');
		try {
			data = JSON.parse((data as ArrayBuffer).toString());
			// eslint-disable-next-line no-empty
		} catch (e) {}
	}

	console.log(resp.status);
	console.log(resp.statusText);

	if (resp.status === undefined) {
		// Write this obscure failure to file to analyze further
		writeFileSync(`${Math.random()}.txt`, JSON.stringify(resp, null, 4));
	}

	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	return data ? data.error || data : resp.statusText || 'unknown';
}
