import { CipherType } from './types/type_guards';

export const prodAppUrl = 'https://app.ardrive.io';
export const stagingAppUrl = 'https://staging.ardrive.io';
export const gatewayURL = 'https://arweave.net/';

export const appName = 'ArDrive-Sync';
export const webAppName = 'ArDrive-Web';
export const appVersion = '0.1.12';
export const arFSVersion = '0.11';
export const defaultCipher: CipherType = 'AES256-GCM';
export const maxFileSize = 2000000000;

/**
 * Minimum ArDrive community tip from the Community Improvement Proposal Doc:
 * https://arweave.net/Yop13NrLwqlm36P_FDCdMaTBwSlj0sdNGAC4FqfRUgo
 *
 * Voted on by the ArDrive community (vote #82):
 * https://community.xyz/#-8A6RexFkpfWwuyVO98wzSFZh0d6VJuI-buTJvlwOJQ/votes/
 */
export const minArDriveCommunityARTip = 0.000_010_000_000;

// ArDrive Profit Sharing Community Smart Contract
export const communityTxId = '-8A6RexFkpfWwuyVO98wzSFZh0d6VJuI-buTJvlwOJQ';

/** Estimated AR price for most metadata transactions */
export const assumedMetadataTxARPrice = 0.000_002_500_000;

export const defaultMaxConcurrentChunks = 32;

/**
 * Error delay for the first failed request for a transaction header post or chunk upload
 * Subsequent requests will delay longer with an exponential back off strategy
 */
export const INITIAL_ERROR_DELAY = 500; // 500ms

/**
 *  These are errors from the `/chunk` endpoint on an Arweave
 *  node that we should never try to continue on
 */
export const FATAL_CHUNK_UPLOAD_ERRORS = [
	'invalid_json',
	'chunk_too_big',
	'data_path_too_big',
	'offset_too_big',
	'data_size_too_big',
	'chunk_proof_ratio_not_attractive',
	'invalid_proof'
];

export const MAX_CONFIRMATIONS = 10;
