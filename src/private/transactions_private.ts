import { JWKInterface } from 'arweave/node/lib/wallet';
import { ArFSPrivateDriveEntity, ArFSPrivateFileData, ArFSPrivateFileFolderEntity } from '../types/arfs_Types';
import Arweave from 'arweave';
import Transaction from 'arweave/node/lib/transaction';

// ArDrive Profit Sharing Community Smart Contract

// Initialize Arweave
const arweave = Arweave.init({
	host: 'arweave.net', // Arweave Gateway
	//host: 'arweave.dev', // Arweave Dev Gateway
	port: 443,
	protocol: 'https',
	timeout: 600000
});

// Creates an arweave transaction to upload a drive entity
export async function createPrivateDriveTransaction(
	driveJSON: Buffer, // must be an encrypted buffer
	driveMetaData: ArFSPrivateDriveEntity,
	walletPrivateKey?: JWKInterface
): Promise<Transaction> {
	// Create transaction
	let transaction: Transaction;
	if (walletPrivateKey) {
		transaction = await arweave.createTransaction({ data: driveJSON }, walletPrivateKey);
	} else {
		transaction = await arweave.createTransaction({ data: driveJSON }); // Will use ArConnect if no wallet present
	}
	// Tag file with ArFS Tags
	transaction.addTag('App-Name', driveMetaData.appName);
	transaction.addTag('App-Version', driveMetaData.appVersion);
	transaction.addTag('Unix-Time', driveMetaData.unixTime.toString());
	transaction.addTag('Drive-Id', driveMetaData.driveId);
	transaction.addTag('Drive-Privacy', driveMetaData.drivePrivacy);
	transaction.addTag('Content-Type', driveMetaData.contentType);
	// Tag file with Content-Type, Cipher and Cipher-IV and Drive-Auth-Mode
	transaction.addTag('Cipher', driveMetaData.cipher);
	transaction.addTag('Cipher-IV', driveMetaData.cipherIV);
	transaction.addTag('Drive-Auth-Mode', driveMetaData.driveAuthMode);
	transaction.addTag('ArFS', driveMetaData.arFS);
	transaction.addTag('Entity-Type', 'drive');

	// Sign file
	if (walletPrivateKey) {
		await arweave.transactions.sign(transaction, walletPrivateKey);
	} else {
		await arweave.transactions.sign(transaction); // Will use ArConnect if no wallet present
	}
	return transaction;
}

// This will prepare and sign a private v2 data transaction using ArFS File Data Tags including privacy tags
export async function createPrivateFileDataTransaction(
	fileData: Buffer, // the buffer must already be encrypted
	fileMetaData: ArFSPrivateFileData,
	walletPrivateKey?: JWKInterface
): Promise<Transaction> {
	let transaction: Transaction;
	// Create the arweave transaction using the file data and private key
	if (walletPrivateKey) {
		transaction = await arweave.createTransaction({ data: fileData }, walletPrivateKey);
	} else {
		transaction = await arweave.createTransaction({ data: fileData }); // Will use ArConnect if no wallet present
	}

	// Tag file with Content-Type, Cipher and Cipher-IV
	transaction.addTag('App-Name', fileMetaData.appName);
	transaction.addTag('App-Version', fileMetaData.appVersion);
	transaction.addTag('Content-Type', 'application/octet-stream');
	transaction.addTag('Cipher', fileMetaData.cipher);
	transaction.addTag('Cipher-IV', fileMetaData.cipherIV);

	// Sign the transaction
	if (walletPrivateKey) {
		await arweave.transactions.sign(transaction, walletPrivateKey);
	} else {
		await arweave.transactions.sign(transaction); // Will use ArConnect if no wallet present
	}

	return transaction;
}

// This will prepare and sign a private v2 data transaction using ArFS File Metadata Tags including privacy tags
export async function createPrivateFileFolderMetaDataTransaction(
	metaData: ArFSPrivateFileFolderEntity,
	secondaryFileMetaData: Buffer, // the buffer must already be encrypted
	walletPrivateKey?: JWKInterface
): Promise<Transaction> {
	let transaction: Transaction;
	if (walletPrivateKey) {
		// Create the arweave transaction using the file data and private key
		transaction = await arweave.createTransaction({ data: secondaryFileMetaData }, walletPrivateKey);
	} else {
		transaction = await arweave.createTransaction({ data: secondaryFileMetaData }); // Will use ArConnect if no wallet present
	}

	// Tag file with ArFS Tags including tags needed for privacy
	transaction.addTag('App-Name', metaData.appName);
	transaction.addTag('App-Version', metaData.appVersion);
	transaction.addTag('Unix-Time', metaData.unixTime.toString());
	transaction.addTag('Content-Type', 'application/octet-stream');
	transaction.addTag('Cipher', metaData.cipher);
	transaction.addTag('Cipher-IV', metaData.cipherIV);
	transaction.addTag('ArFS', metaData.arFS);
	transaction.addTag('Entity-Type', metaData.entityType);
	transaction.addTag('Drive-Id', metaData.driveId);

	// Add file or folder specific tags
	if (metaData.entityType === 'file') {
		transaction.addTag('File-Id', metaData.entityId);
		transaction.addTag('Parent-Folder-Id', metaData.parentFolderId);
	} else {
		transaction.addTag('Folder-Id', metaData.entityId);
		if (metaData.parentFolderId !== '0') {
			transaction.addTag('Parent-Folder-Id', metaData.parentFolderId);
		}
	}

	// Sign the transaction
	if (walletPrivateKey) {
		await arweave.transactions.sign(transaction, walletPrivateKey);
	} else {
		await arweave.transactions.sign(transaction); // Will use ArConnect if no wallet present
	}

	return transaction;
}
