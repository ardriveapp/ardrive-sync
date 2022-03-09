import { ArweaveOracle } from './arweave_oracle';
import { retryFetch } from './common';

export class GatewayOracle implements ArweaveOracle {
	async getWinstonPriceForByteCount(byteCount: number): Promise<number> {
		const response = await retryFetch(`https://arweave.net/price/${byteCount}`);
		const winstonAmount = await response.data;
		return +winstonAmount;
	}
}
