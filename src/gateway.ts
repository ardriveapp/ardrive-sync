import { arweave } from './arweave';
import axios from 'axios';
import axiosRetry, { exponentialDelay } from 'axios-retry';

// Gets only the data of a given ArDrive Data transaction (U8IntArray)
export async function getTransactionData(txId: string): Promise<string | Uint8Array> {
	const protocol = 'https';
	const host = 'arweave.net';
	const portStr = '';
	const reqURL = `${protocol}://${host}${portStr}/${txId}`;
	const axiosInstance = axios.create();
	const maxRetries = 5;
	axiosRetry(axiosInstance, {
		retries: maxRetries,
		retryDelay: (retryNumber) => {
			console.error(`Retry attempt ${retryNumber}/${maxRetries} of request to ${reqURL}`);
			return exponentialDelay(retryNumber);
		}
	});
	const {
		data: txData
	}: {
		data: Buffer;
	} = await axiosInstance.get(reqURL, {
		responseType: 'arraybuffer'
	});
	return txData;
}

// Get the latest status of a transaction
export async function getTransactionStatus(txid: string): Promise<number> {
	try {
		const response = await arweave.transactions.getStatus(txid);
		return response.status;
	} catch (err) {
		// console.log(err);
		return 0;
	}
}

// Get the latest block height
export async function getLatestBlockHeight(): Promise<number> {
	try {
		const info = await arweave.network.getInfo();
		return info.height;
	} catch (err) {
		console.log('Failed getting latest block height');
		return 0;
	}
}
