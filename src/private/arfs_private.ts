// arfs.js
import * as arweavePrivate from './transactions_private';
import * as types from './../types/base_Types';
import * as clientTypes from './../types/client_Types';
import { fileEncrypt, deriveDriveKey, deriveFileKey, getFileAndEncrypt } from './../crypto';
import { TransactionUploader } from 'arweave/node/lib/transaction-uploader';
import { JWKInterface } from './../types/arfs_Types';
import { createDataUploader } from '../transactions';

// Takes a buffer and ArFS File Metadata and creates an ArFS Data Transaction using V2 Transaction with proper GQL tags
export async function newArFSPrivateFileData(
	user: types.ArDriveUser,
	walletPrivateKey: JWKInterface,
	file: clientTypes.ArFSLocalPrivateFile
): Promise<{ file: clientTypes.ArFSLocalPrivateFile; uploader: TransactionUploader } | null> {
	try {
		// The file is private and we must encrypt
		console.log(
			'Encrypting and uploading the PRIVATE file %s (%d bytes) at %s to the Permaweb',
			file.path,
			file.size
		);
		// Derive the drive and file keys in order to encrypt it with ArFS encryption
		const driveKey: Buffer = await deriveDriveKey(
			user.dataProtectionKey,
			file.entity.driveId,
			user.walletPrivateKey
		);
		const fileKey: Buffer = await deriveFileKey(file.entity.entityId, driveKey);

		// Encrypt the data with the file key
		const encryptedData: types.ArFSEncryptedData = await getFileAndEncrypt(fileKey, file.path);

		// Update the cipher iv and cipher for the File Data and not its entity
		file.data.cipherIV = encryptedData.cipherIV;
		file.data.cipher = encryptedData.cipher;

		// Create the Arweave transaction.  It will add the correct ArFS tags depending if it is public or private
		const transaction = await arweavePrivate.createPrivateFileDataTransaction(
			encryptedData.data,
			file.data,
			walletPrivateKey
		);

		// Update the file's data transaction ID
		file.data.txId = transaction.id;

		// Create the File Uploader object
		const uploader = await createDataUploader(transaction);

		return { file, uploader };
	} catch (err) {
		console.log(err);
		return null;
	}
}
// Takes ArFS Private File Metadata and creates an ArFS MetaData Transaction using V2 Transaction with proper GQL tags
export async function newArFSPrivateFileMetaData(
	user: types.ArDriveUser,
	walletPrivateKey: JWKInterface,
	file: clientTypes.ArFSLocalPrivateFile
): Promise<{ file: clientTypes.ArFSLocalPrivateFile; uploader: TransactionUploader } | null> {
	let transaction;
	let secondaryFileMetaDataTags = {};
	try {
		// create secondary metadata, used to further ID the file with encryption
		secondaryFileMetaDataTags = {
			name: file.entity.name,
			size: file.size,
			lastModifiedDate: file.entity.lastModifiedDate,
			dataTxId: file.data.txId,
			dataContentType: file.data.contentType
		};

		// Convert to JSON string
		const secondaryFileMetaDataJSON = JSON.stringify(secondaryFileMetaDataTags);

		// Private file, so the metadata must be encrypted
		// Get the drive and file key needed for encryption
		const driveKey: Buffer = await deriveDriveKey(
			user.dataProtectionKey,
			file.entity.driveId,
			user.walletPrivateKey
		);
		const fileKey: Buffer = await deriveFileKey(file.entity.entityId, driveKey);
		const encryptedData: types.ArFSEncryptedData = await fileEncrypt(
			fileKey,
			Buffer.from(secondaryFileMetaDataJSON)
		);

		// Update the file privacy metadata
		file.entity.cipherIV = encryptedData.cipherIV;
		file.entity.cipher = encryptedData.cipher;
		transaction = await arweavePrivate.createPrivateFileFolderMetaDataTransaction(
			file.entity,
			encryptedData.data,
			walletPrivateKey
		);

		// Update the file's data transaction ID
		file.entity.txId = transaction.id;

		// Create the File Uploader object
		const uploader = await createDataUploader(transaction);

		return { file, uploader };
	} catch (err) {
		console.log(err);
		return null;
	}
}
// Takes ArFS Private Folder Metadata and creates an ArFS MetaData Transaction using V2 Transaction with proper GQL tags
export async function newArFSPrivateFolderMetaData(
	user: types.ArDriveUser,
	walletPrivateKey: JWKInterface,
	folder: clientTypes.ArFSLocalPrivateFolder
): Promise<{ folder: clientTypes.ArFSLocalPrivateFolder; uploader: TransactionUploader } | null> {
	let transaction;
	let secondaryFileMetaDataTags = {};
	try {
		// create secondary metadata specifically for a folder
		secondaryFileMetaDataTags = {
			name: folder.entity.name
		};

		// Convert to JSON string
		const secondaryFileMetaDataJSON = JSON.stringify(secondaryFileMetaDataTags);

		// Private file, so the metadata must be encrypted
		// Get the drive and file key needed for encryption
		const driveKey: Buffer = await deriveDriveKey(
			user.dataProtectionKey,
			folder.entity.driveId,
			user.walletPrivateKey
		);
		const fileKey: Buffer = await deriveFileKey(folder.entity.entityId, driveKey);
		const encryptedData: types.ArFSEncryptedData = await fileEncrypt(
			fileKey,
			Buffer.from(secondaryFileMetaDataJSON)
		);

		// Update the file privacy metadata
		folder.entity.cipherIV = encryptedData.cipherIV;
		folder.entity.cipher = encryptedData.cipher;
		transaction = await arweavePrivate.createPrivateFileFolderMetaDataTransaction(
			folder.entity,
			encryptedData.data,
			walletPrivateKey
		);

		// Update the file's data transaction ID
		folder.entity.txId = transaction.id;

		// Create the File Uploader object
		const uploader = await createDataUploader(transaction);

		return { folder, uploader };
	} catch (err) {
		console.log(err);
		return null;
	}
}
