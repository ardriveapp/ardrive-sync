import { arweave } from './arweave';
import * as types from './types/base_Types';
import * as updateDb from './db/db_update';
import * as getDb from './db/db_get';
import * as common from './common';
import * as fs from 'fs';
import { bundleAndSignData, createData, DataItem } from 'arbundles';
import { uploadArFSDriveMetaData, uploadArFSFileMetaData } from './public/arfs';
import { appName, appVersion, arFSVersion } from './constants';
import { GatewayOracle } from './gateway_oracle';
// import { createDataUploader } from './transactions';
import { ArFSFileMetaData } from './types/base_Types';
import { deriveDriveKey, deriveFileKey, driveEncrypt, getFileAndEncrypt } from './crypto';
import { GQLTagInterface } from './types/gql_Types';
import { arDriveCommunityOracle } from './ardrive_community_oracle';
import { selectTokenHolder } from './smartweave';
import { ArweaveSigner } from 'arbundles/src/signing';
import { ArFSTransactionUploader } from './arfs_transaction_uploader';

const maxBundleSize = 503316480;
const maxDataItemSize = 500;

// Uploads all queued files as v2 transactions (files bigger than 50mb) and ANS104 data bundles (capped at 256mb)
export async function uploadArDriveFilesAndBundles(user: types.ArDriveUser): Promise<string> {
	try {
		const items: DataItem[] = [];
		let bundledFilesUploaded = 0;
		let totalSize = 0;
		let moreItems = 0;
		console.log('---Uploading All Queued Files and Folders---');
		const filesToUpload: types.ArFSFileMetaData[] = getDb.getFilesToUploadFromSyncTable(user.login);

		// Only process files if there are files queued
		for (let n = 0; n < Object.keys(filesToUpload).length; ++n) {
			// Process all file entitites
			if (filesToUpload[n].entityType === 'file') {
				// If the total size of the item is greater than max bundle size, then we send a bundle of 1 data tx + metadata tx
				if (+filesToUpload[n].fileDataSyncStatus === 1 && filesToUpload[n].fileSize >= maxBundleSize) {
					console.log('Preparing large file bundle - %s', filesToUpload[n].fileName);
					const singleFileBundle: DataItem[] = [];
					const fileDataItem: DataItem | null = await createArFSFileDataItem(user, filesToUpload[n]);
					if (fileDataItem !== null) {
						totalSize += filesToUpload[n].fileSize;
						filesToUpload[n].dataTxId = fileDataItem.id;
						singleFileBundle.push(fileDataItem);
						bundledFilesUploaded += 1;
					}
					const fileMetaDataItem = await createArFSFileMetaDataItem(user, filesToUpload[n]);
					if (fileMetaDataItem !== null) {
						singleFileBundle.push(fileMetaDataItem);
					}

					console.log('Submitting large file bundled TX');
					const bundledDataTxId = await uploadArFSDataBundle(user, singleFileBundle);
					filesToUpload[n].dataTxId = bundledDataTxId;
					await updateDb.updateFileBundleTxId(bundledDataTxId, filesToUpload[n].id);
				}
				// If fileDataSync is 1 and we have not exceeded our max bundle size, then we submit file data and metadata as a bundle
				else if (+filesToUpload[n].fileDataSyncStatus === 1 && totalSize < maxBundleSize) {
					console.log('Preparing data item - %s', filesToUpload[n].fileName);
					const fileDataItem: DataItem | null = await createArFSFileDataItem(user, filesToUpload[n]);
					if (fileDataItem !== null) {
						// Get the price of this upload
						totalSize += filesToUpload[n].fileSize;
						filesToUpload[n].dataTxId = fileDataItem.id;
						items.push(fileDataItem);
						bundledFilesUploaded += 1;
					}
					const fileMetaDataItem = await createArFSFileMetaDataItem(user, filesToUpload[n]);
					if (fileMetaDataItem !== null) {
						items.push(fileMetaDataItem);
					}
					// If only metaDataSync is 1, then we only submit file metadata
				} else if (+filesToUpload[n].fileMetaDataSyncStatus === 1) {
					console.log('Preparing file metadata only - %s', filesToUpload[n].fileName);
					const fileMetaDataItem = await createArFSFileMetaDataItem(user, filesToUpload[n]);
					if (fileMetaDataItem !== null) {
						items.push(fileMetaDataItem);
						bundledFilesUploaded += 1;
					}
				}
			}
			// If this is a folder, we create folder metadata as a bundle
			else if (filesToUpload[n].entityType === 'folder') {
				const folderMetaDataItem = await createArFSFileMetaDataItem(user, filesToUpload[n]);
				if (folderMetaDataItem !== null) {
					items.push(folderMetaDataItem);
					bundledFilesUploaded += 1;
				}
			}

			// If we have exceeded the total size of the bundle, we stop processing items and submit the bundle
			if (totalSize > maxBundleSize) {
				console.log('Max data bundle size reached %s', totalSize);
				n = Object.keys(filesToUpload).length;
				moreItems = 1;
			} else if (items.length >= maxDataItemSize) {
				console.log('Max data item bundle size reached %s', items.length);
				n = Object.keys(filesToUpload).length;
				moreItems = 1;
			}
		}

		// Submit the master bundled transaction
		if (bundledFilesUploaded > 0) {
			console.log('Submitting a bundled TX for %s items(s)', items.length);
			const bundledDataTxId = await uploadArFSDataBundle(user, items);

			// Update all files/folders with the bundled TX ID that were submitted as part of this bundle
			for (let n = 0; n < bundledFilesUploaded; ++n) {
				await updateDb.updateFileBundleTxId(bundledDataTxId, filesToUpload[n].id);
			}
		}

		// If not all files have been uploaded in this batch due to hitting max bundle size, we start a new batch of data items
		if (moreItems === 1) {
			await uploadArDriveFilesAndBundles(user);
		}

		// Check if this was the first upload of the user's drive, if it was then upload a Drive transaction as well
		// Check for unsynced drive entities and create if necessary
		const newDrives: types.ArFSFileMetaData[] = getDb.getNewDrivesFromDriveTable(user.login);
		if (newDrives.length > 0) {
			console.log('   Wow that was your first ARDRIVE Transaction!  Congrats!');
			console.log(
				'   Lets finish setting up your profile by submitting a few more small transactions to the network.'
			);
			await common.asyncForEach(newDrives, async (newDrive: types.ArFSDriveMetaData) => {
				// Create the Drive metadata transaction as submit as V2
				const success = await uploadArFSDriveMetaData(user, newDrive);
				if (success) {
					// Create the Drive Root folder and submit as V2 transaction
					const driveRootFolder: types.ArFSFileMetaData = await getDb.getDriveRootFolderFromSyncTable(
						newDrive.rootFolderId
					);
					await uploadArFSFileMetaData(user, driveRootFolder);
				}
			});
		}

		return 'SUCCESS';
	} catch (err) {
		console.log(err);
		return 'ERROR processing files';
	}
}

// Tags and uploads an ANS 104 Data Bundle
export async function uploadArFSDataBundle(user: types.ArDriveUser, dataItems: DataItem[]): Promise<string> {
	try {
		const bundle = await bundleAndSignData(dataItems, JSON.parse(user.walletPrivateKey));
		const size = bundle.getRaw().length;

		// Get the random token holder and determine how much they will earn from this bundled upload
		const holder = await selectTokenHolder();
		const winstonPrice = await new GatewayOracle().getWinstonPriceForByteCount(size);
		const tip = Math.round(await arDriveCommunityOracle.getCommunityARTip(winstonPrice));

		const bundledDataTx = await bundle.toTransaction(
			{ target: holder, quantity: tip.toString() },
			arweave,
			JSON.parse(user.walletPrivateKey)
		);
		bundledDataTx.addTag('App-Name', appName);
		bundledDataTx.addTag('App-Version', appVersion);
		bundledDataTx.addTag('Tip-Type', 'data upload');

		// Sign the bundle
		await arweave.transactions.sign(bundledDataTx, JSON.parse(user.walletPrivateKey));
		if (bundledDataTx !== null) {
			//const uploader = await createDataUploader(bundledDataTx);
			bundledDataTx.prepareChunks(bundledDataTx.data);
			const uploader = new ArFSTransactionUploader({ transaction: bundledDataTx, arweave });
			// Get current time and update the database
			const currentTime = Math.round(Date.now() / 1000);
			await updateDb.addToBundleTable(user.login, bundledDataTx.id, 2, currentTime);

			// Begin to upload chunks and upload the database as needed
			while (!uploader.isComplete) {
				//await uploader.uploadChunk();
				await uploader.batchUploadChunks();
				await updateDb.setBundleUploaderObject(JSON.stringify(uploader), bundledDataTx.id);
				console.log(`${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`);
			}
			if (uploader.isComplete) {
				console.log('SUCCESS data bundle was submitted with TX %s', bundledDataTx.id);
				return bundledDataTx.id;
			}
		}
		return 'Error';
	} catch (err) {
		console.log(err);
		console.log('Error uploading data bundle');
		return 'Error';
	}
}

// Tags and creates a single file ARFS Data Item using AR Bundles standard.
export async function createArFSFileDataItem(
	user: types.ArDriveUser,
	fileToUpload: ArFSFileMetaData
): Promise<DataItem | null> {
	let dataItem: DataItem | null;
	try {
		const signer = new ArweaveSigner(JSON.parse(user.walletPrivateKey));
		const tags = prepareArFSDataItemTags(fileToUpload);

		if (fileToUpload.isPublic === 0) {
			// Private file, so it must be encrypted
			console.log(
				'Encrypting and bundling %s (%d bytes) to the Permaweb',
				fileToUpload.filePath,
				fileToUpload.fileSize
			);

			// Derive the keys needed for encryption
			const driveKey: Buffer = await deriveDriveKey(
				user.dataProtectionKey,
				fileToUpload.driveId,
				user.walletPrivateKey
			);
			const fileKey: Buffer = await deriveFileKey(fileToUpload.fileId, driveKey);

			// Get the encrypted version of the file
			const encryptedData: types.ArFSEncryptedData = await getFileAndEncrypt(fileKey, fileToUpload.filePath);

			// Set the private file metadata
			fileToUpload.dataCipherIV;
			fileToUpload.cipher;

			dataItem = createData(encryptedData.data, signer, { tags });
			await dataItem.sign(signer);
		} else {
			console.log(
				'Creating Data Item %s (%d bytes) to the Permaweb',
				fileToUpload.filePath,
				fileToUpload.fileSize
			);
			const fileData = fs.readFileSync(fileToUpload.filePath);
			dataItem = createData(fileData, signer, { tags });
			await dataItem.sign(signer);
		}
		if (dataItem != null) {
			console.log('SUCCESS %s data item was created with TX %s', fileToUpload.filePath, dataItem.id);

			// Set the file metadata to syncing
			fileToUpload.fileDataSyncStatus = 2;
			fileToUpload.dataTxId = dataItem.id;

			// Update the queue since the file is now being uploaded
			await updateDb.updateFileDataSyncStatus(
				fileToUpload.fileDataSyncStatus,
				fileToUpload.dataTxId,
				fileToUpload.dataCipherIV,
				fileToUpload.cipher,
				fileToUpload.id
			);

			// Update the uploadTime of the file so we can track the status
			const currentTime = Math.round(Date.now() / 1000);
			await updateDb.updateFileUploadTimeInSyncTable(fileToUpload.id, currentTime);
		}
		return dataItem;
	} catch (err) {
		console.log(err);
		console.log('Error creating file data item');
		return null;
	}
}

// Tags and creates a single file ARFS Metadata item using AR Bundles standard.
export async function createArFSFileMetaDataItem(
	user: types.ArDriveUser,
	fileToUpload: ArFSFileMetaData
): Promise<DataItem | null> {
	let dataItem: DataItem | null;
	let secondaryFileMetaDataTags = {};
	const signer = new ArweaveSigner(JSON.parse(user.walletPrivateKey));
	try {
		// create secondary metadata, used to further ID the file (with encryption if necessary)
		if (fileToUpload.entityType === 'folder') {
			// create secondary metadata specifically for a folder
			secondaryFileMetaDataTags = {
				name: fileToUpload.fileName
			};
		} else if (fileToUpload.entityType === 'file') {
			secondaryFileMetaDataTags = {
				name: fileToUpload.fileName,
				size: fileToUpload.fileSize,
				lastModifiedDate: fileToUpload.lastModifiedDate,
				dataTxId: fileToUpload.dataTxId,
				dataContentType: fileToUpload.contentType
			};
		}

		// Convert to JSON string
		const secondaryFileMetaDataJSON = JSON.stringify(secondaryFileMetaDataTags);
		if (fileToUpload.isPublic === 1) {
			// Public file, do not encrypt
			const tags = prepareArFSMetaDataItemTags(fileToUpload);
			// Get a signed data item for the encrypted data

			dataItem = createData(secondaryFileMetaDataJSON, signer, { tags });
			await dataItem.sign(signer);
		} else {
			// Private file, so it must be encrypted
			const driveKey: Buffer = await deriveDriveKey(
				user.dataProtectionKey,
				fileToUpload.driveId,
				user.walletPrivateKey
			);

			// Private folders encrypt with driveKey, private files encrypt with fileKey
			const encryptedData = await common.encryptFileOrFolderData(
				fileToUpload,
				driveKey,
				secondaryFileMetaDataJSON
			);

			// Update the file privacy metadata
			fileToUpload.metaDataCipherIV = encryptedData.cipherIV;
			fileToUpload.cipher = encryptedData.cipher;

			const tags = prepareArFSMetaDataItemTags(fileToUpload);

			dataItem = createData(encryptedData.data, signer, { tags });
			await dataItem.sign(signer);
		}
		if (dataItem != null) {
			console.log('SUCCESS %s metadata data item was created with TX %s', fileToUpload.filePath, dataItem.id);
			// Set the file metadata to syncing
			fileToUpload.fileMetaDataSyncStatus = 2;
			fileToUpload.metaDataTxId = dataItem.id;
			await updateDb.updateFileMetaDataSyncStatus(
				fileToUpload.fileMetaDataSyncStatus,
				fileToUpload.metaDataTxId,
				fileToUpload.metaDataCipherIV,
				fileToUpload.cipher,
				fileToUpload.id
			);
			// Update the uploadTime of the file so we can track the status
			const currentTime = Math.round(Date.now() / 1000);
			await updateDb.updateFileUploadTimeInSyncTable(fileToUpload.id, currentTime);
		}
		return dataItem;
	} catch (err) {
		console.log(err);
		console.log('Error uploading file metadata item');
		return null;
	}
}

// Tags and creates a single drive metadata item (with AR Bundles)
export async function createArFSDriveMetaDataItem(
	user: types.ArDriveUser,
	drive: types.ArFSDriveMetaData
): Promise<DataItem | null> {
	let dataItem: DataItem | null;
	const driveMetaDataTags = {
		name: drive.driveName,
		rootFolderId: drive.rootFolderId
	};
	// Convert to JSON string
	const driveMetaDataJSON = JSON.stringify(driveMetaDataTags);
	const signer = new ArweaveSigner(JSON.parse(user.walletPrivateKey));
	// Check if the drive is public or private
	if (drive.drivePrivacy === 'private') {
		console.log('Creating a new Private Drive (name: %s) on the Permaweb', drive.driveName);
		const driveKey: Buffer = await deriveDriveKey(user.dataProtectionKey, drive.driveId, user.walletPrivateKey);
		const encryptedDriveMetaData: types.ArFSEncryptedData = await driveEncrypt(
			driveKey,
			Buffer.from(driveMetaDataJSON)
		);

		drive.cipher = encryptedDriveMetaData.cipher;
		drive.cipherIV = encryptedDriveMetaData.cipherIV;
		const tags = prepareArFSDriveMetaDataItemTags(drive);
		dataItem = createData(encryptedDriveMetaData.data, signer, { tags });
		await dataItem.sign(signer);
	} else {
		// The drive is public
		console.log('Creating a new Public Drive (name: %s) on the Permaweb', drive.driveName);
		const tags = prepareArFSDriveMetaDataItemTags(drive);
		dataItem = createData(driveMetaDataJSON, signer, { tags });
		await dataItem.sign(signer);
	}
	if (dataItem !== null) {
		// Update the file's data transaction ID
		drive.metaDataTxId = dataItem.id;

		// Update the Drive table to include this transaction information
		drive.metaDataSyncStatus = 2;

		await updateDb.updateDriveInDriveTable(
			drive.metaDataSyncStatus,
			drive.metaDataTxId,
			drive.cipher,
			drive.cipherIV,
			drive.driveId
		);
	}
	return dataItem;
}

// Creates the tag options for ANS-104 Data Item Creation for ArFS File Data
export function prepareArFSDataItemTags(fileMetaData: ArFSFileMetaData): { name: string; value: string }[] {
	// Tag file with common tags
	const tags: GQLTagInterface[] = [
		{ name: 'App-Name', value: appName },
		{ name: 'App-Version', value: appVersion }
	];

	if (fileMetaData.isPublic === 0) {
		// If the file is private, we use extra tags
		// Tag file with Privacy tags, Content-Type, Cipher and Cipher-IV
		tags.push({ name: 'Content-Type', value: 'application/octet-stream' });
		tags.push({ name: 'Cipher', value: fileMetaData.cipher });
		tags.push({ name: 'Cipher-IV', value: fileMetaData.dataCipherIV });
	} else {
		// Only tag the file with public tags
		tags.push({ name: 'Content-Type', value: fileMetaData.contentType });
	}
	return tags;
}

// Creates the tag options for ANS-104 Data Item Creation for ArFS File Metadata
export function prepareArFSMetaDataItemTags(fileMetaData: ArFSFileMetaData): { name: string; value: string }[] {
	// Tag file with common tags
	const tags: GQLTagInterface[] = [
		{ name: 'App-Name', value: appName },
		{ name: 'App-Version', value: appVersion },
		{ name: 'Unix-Time', value: fileMetaData.unixTime.toString() }
	];

	if (fileMetaData.isPublic === 0) {
		// If the file is private, we use extra tags
		// Tag file with Content-Type, Cipher and Cipher-IV
		tags.push({ name: 'Content-Type', value: 'application/octet-stream' });
		tags.push({ name: 'Cipher', value: fileMetaData.cipher });
		tags.push({ name: 'Cipher-IV', value: fileMetaData.metaDataCipherIV });
	} else {
		tags.push({ name: 'Content-Type', value: 'application/json' });
	}
	tags.push({ name: 'ArFS', value: common.arFSVersion });
	tags.push({ name: 'Entity-Type', value: fileMetaData.entityType });
	tags.push({ name: 'Drive-Id', value: fileMetaData.driveId });

	// Add file or folder specific tags
	if (fileMetaData.entityType === 'file') {
		tags.push({ name: 'File-Id', value: fileMetaData.fileId });
		tags.push({ name: 'Parent-Folder-Id', value: fileMetaData.parentFolderId });
	} else {
		tags.push({ name: 'Folder-Id', value: fileMetaData.fileId });
		if (fileMetaData.parentFolderId !== '0') {
			tags.push({ name: 'Parent-Folder-Id', value: fileMetaData.parentFolderId });
		}
	}
	return tags;
}

// Creates the tag options for AR Bundles Data Item Creation for ArFS Drive Metadata
export function prepareArFSDriveMetaDataItemTags(
	driveMetaData: types.ArFSDriveMetaData
): { name: string; value: string }[] {
	// Tag file with common tags
	const tags: GQLTagInterface[] = [
		{ name: 'App-Name', value: appName },
		{ name: 'App-Version', value: appVersion },
		{ name: 'Unix-Time', value: driveMetaData.unixTime.toString() },
		{ name: 'ArFS', value: arFSVersion },
		{ name: 'Entity-Type', value: 'drive' },
		{ name: 'Drive-Id', value: driveMetaData.driveId },
		{ name: 'Drive-Privacy', value: driveMetaData.drivePrivacy }
	];

	// If the drive is private, we use extra tags
	if (driveMetaData.drivePrivacy === 'private') {
		// Tag drive with Content-Type, Cipher and Cipher-IV and Drive-Auth-Mode
		tags.push({ name: 'Content-Type', value: 'application/octet-stream' });
		tags.push({ name: 'Cipher', value: driveMetaData.cipher });
		tags.push({ name: 'Cipher-IV', value: driveMetaData.cipherIV });
		tags.push({ name: 'Drive-Auth-Mode', value: driveMetaData.driveAuthMode });
	} else {
		// Tag drive with public tags only
		tags.push({ name: 'Content-Type', value: 'application/json' });
	}
	return tags;
}

export async function createArFSDriveDataItems(
	user: types.ArDriveUser,
	driveMetadata: types.ArFSDriveMetaData
): Promise<DataItem[]> {
	const items: DataItem[] = [];
	const driveRootFolder: types.ArFSFileMetaData = await getDb.getDriveRootFolderFromSyncTable(
		driveMetadata.rootFolderId
	);
	const driveDataItem = await createArFSDriveMetaDataItem(user, driveMetadata);
	if (driveDataItem !== null) {
		items.push(driveDataItem);
		const rootFolderMetaDataItem = await createArFSFileMetaDataItem(user, driveRootFolder);
		if (rootFolderMetaDataItem !== null) {
			items.push(rootFolderMetaDataItem);
		}
	}
	return items;
}
