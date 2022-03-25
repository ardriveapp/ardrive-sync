// arfs.js
import * as fs from 'fs';
import * as constants from './constants';
import { arweave, getTransactionStatus } from './arweave';
import { TransactionUploader } from 'arweave/node/lib/transaction-uploader';
import Transaction from 'arweave/node/lib/transaction';
import { ArFSFileFolderEntity, JWKInterface } from './types/arfs_Types';
import { ArDriveUser, ArFSDriveMetaData, ArFSEncryptedData, ArFSFileMetaData } from './types/base_Types';
import * as updateDb from './db/db_update';
import { deriveDriveKey, deriveFileKey, driveEncrypt, getFileAndEncrypt } from './crypto';
import { encryptFileOrFolderData } from './common';
import { arDriveCommunityOracle } from './ardrive_community_oracle';
import { selectTokenHolderFromVerto } from './smartweave';
import { GatewayOracle } from './gateway_oracle';
import { MultiChunkTxUploader } from './multi_chunk_tx_uploader';
import { defaultMaxConcurrentChunks } from './constants';
import { GatewayAPI } from './gateway_api';
import * as types from './types/base_Types';
import * as getDb from './db/db_get';
import * as common from './common';
import { assumedMetadataTxARPrice, MAX_CONFIRMATIONS } from './constants';
import { ArweaveOracle } from './arweave_oracle';
import { CommunityOracle } from './community_oracle';
import { deleteFromSyncTable } from './db/db_delete';

// Tags and Uploads a single file from the local disk to your ArDrive using Arweave V2 Transactions
export async function uploadArFSFileData(user: ArDriveUser, fileToUpload: ArFSFileMetaData): Promise<string> {
	let transaction;
	try {
		// Get the random token holder and determine how much they will earn from this bundled upload
		const winstonPrice = await new GatewayOracle().getWinstonPriceForByteCount(fileToUpload.fileSize);
		let tip = Math.round(await arDriveCommunityOracle.getCommunityARTip(winstonPrice));
		let holder = await selectTokenHolderFromVerto();
		if (holder === undefined) {
			holder = '';
			tip = 0;
		}

		if (fileToUpload.isPublic === 0) {
			// The file is private and we must encrypt
			// Derive the drive and file keys in order to encrypt it with ArFS encryption
			const driveKey: Buffer = await deriveDriveKey(
				user.dataProtectionKey,
				fileToUpload.driveId,
				user.walletPrivateKey
			);
			const fileKey: Buffer = await deriveFileKey(fileToUpload.fileId, driveKey);

			// Encrypt the data with the file key
			const encryptedData: ArFSEncryptedData = await getFileAndEncrypt(fileKey, fileToUpload.filePath);

			// Update the file metadata
			fileToUpload.dataCipherIV = encryptedData.cipherIV;
			fileToUpload.cipher = encryptedData.cipher;

			// Create the Arweave transaction.  It will add the correct ArFS tags depending if it is public or private
			transaction = await prepareArFSDataTransaction(
				user,
				encryptedData.data,
				fileToUpload,
				holder,
				tip.toString()
			);
			console.log(
				'Encrypting and uploading the PRIVATE file %s (%d bytes) to the Permaweb with txid %s',
				fileToUpload.filePath,
				fileToUpload.fileSize,
				transaction.id
			);
		} else {
			// The file is public
			// Get the file data to upload
			const fileData = fs.readFileSync(fileToUpload.filePath);

			// Create the Arweave transaction.  It will add the correct ArFS tags depending if it is public or private
			transaction = await prepareArFSDataTransaction(user, fileData, fileToUpload, holder, tip.toString());
			console.log(
				'Uploading the PUBLIC file %s (%d bytes) to the Permaweb with txid %s',
				fileToUpload.filePath,
				fileToUpload.fileSize,
				transaction.id
			);
		}

		// Update the file's data transaction ID
		fileToUpload.dataTxId = transaction.id;
		// Set the file metadata to indicate it s being synchronized and update its record in the database
		fileToUpload.fileDataSyncStatus = 2;
		await updateDb.updateFileDataSyncStatus(
			fileToUpload.fileDataSyncStatus,
			fileToUpload.dataTxId,
			fileToUpload.dataCipherIV,
			fileToUpload.cipher,
			fileToUpload.id
		);

		// Create the File Uploader object
		await transaction.prepareChunks(transaction.data);
		let debounce = false;
		const shouldProgressLog =
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			transaction.chunks!.chunks.length > defaultMaxConcurrentChunks;

		const transactionUploader = new MultiChunkTxUploader({
			transaction,
			gatewayApi: new GatewayAPI({ gatewayUrl: new URL(constants.gatewayURL) }),
			progressCallback: shouldProgressLog
				? (pct: number) => {
						if (!debounce || pct === 100) {
							console.info(`Transaction Upload Progress: ${pct}%`);
							debounce = true;

							setTimeout(() => {
								debounce = false;
							}, 250); // .25 sec debounce
						}
				  }
				: undefined
		});
		await transactionUploader.batchUploadChunks();
		console.log('SUCCESS %s file data was submitted with TX %s', fileToUpload.filePath, fileToUpload.dataTxId);
		const currentTime = Math.round(Date.now() / 1000);
		await updateDb.updateFileUploadTimeInSyncTable(fileToUpload.id, currentTime);
		return fileToUpload.dataTxId;
	} catch (err) {
		console.log(err);
		return 'Error';
	}
}

// Tags and Uploads a single file/folder metadata to your ArDrive using Arweave V2 Transactions
export async function uploadArFSFileMetaData(user: ArDriveUser, fileToUpload: ArFSFileMetaData): Promise<string> {
	let transaction;
	let secondaryFileMetaDataTags = {};
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
			transaction = await prepareArFSMetaDataTransaction(user, fileToUpload, secondaryFileMetaDataJSON);
		} else {
			// Private file, so the metadata must be encrypted
			// Get the drive and file key needed for encryption
			const driveKey: Buffer = await deriveDriveKey(
				user.dataProtectionKey,
				fileToUpload.driveId,
				user.walletPrivateKey
			);

			// Private folders encrypt with driveKey, private files encrypt with fileKey
			const encryptedData = await encryptFileOrFolderData(fileToUpload, driveKey, secondaryFileMetaDataJSON);

			// Update the file privacy metadata
			fileToUpload.metaDataCipherIV = encryptedData.cipherIV;
			fileToUpload.cipher = encryptedData.cipher;
			transaction = await prepareArFSMetaDataTransaction(user, fileToUpload, encryptedData.data);
		}

		// Update the file's data transaction ID
		fileToUpload.metaDataTxId = transaction.id;

		// Set the file metadata to indicate it s being synchronized and update its record in the database
		fileToUpload.fileMetaDataSyncStatus = 2;
		await updateDb.updateFileMetaDataSyncStatus(
			fileToUpload.fileMetaDataSyncStatus,
			fileToUpload.metaDataTxId,
			fileToUpload.metaDataCipherIV,
			fileToUpload.cipher,
			fileToUpload.id
		);

		// Create the File Uploader object
		await transaction.prepareChunks(transaction.data);
		let debounce = false;
		const shouldProgressLog =
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			transaction.chunks!.chunks.length > defaultMaxConcurrentChunks;

		const transactionUploader = new MultiChunkTxUploader({
			transaction,
			gatewayApi: new GatewayAPI({ gatewayUrl: new URL(constants.gatewayURL) }),
			progressCallback: shouldProgressLog
				? (pct: number) => {
						if (!debounce || pct === 100) {
							console.info(`Transaction Upload Progress: ${pct}%`);
							debounce = true;

							setTimeout(() => {
								debounce = false;
							}, 250); // .25 sec debounce
						}
				  }
				: undefined
		});
		await transactionUploader.batchUploadChunks();
		console.log(
			'SUCCESS %s file metadata was submitted with TX %s',
			fileToUpload.filePath,
			fileToUpload.metaDataTxId
		);
		const currentTime = Math.round(Date.now() / 1000);
		await updateDb.updateFileUploadTimeInSyncTable(fileToUpload.id, currentTime);

		return 'Success';
	} catch (err) {
		console.log(err);
		return 'Error uploading file metadata';
	}
}

// Tags and uploads a drive entity using Arweave V2 Transaction
export async function uploadArFSDriveMetaData(user: ArDriveUser, drive: ArFSDriveMetaData): Promise<boolean> {
	try {
		let transaction;
		// Create a JSON file, containing necessary drive metadata
		const driveMetaDataTags = {
			name: drive.driveName,
			rootFolderId: drive.rootFolderId
		};

		// Convert to JSON string
		const driveMetaDataJSON = JSON.stringify(driveMetaDataTags);

		// Check if the drive is public or private
		if (drive.drivePrivacy === 'private') {
			console.log('Creating a new Private Drive (name: %s) on the Permaweb', drive.driveName);
			const driveKey: Buffer = await deriveDriveKey(user.dataProtectionKey, drive.driveId, user.walletPrivateKey);
			const encryptedDriveMetaData: ArFSEncryptedData = await driveEncrypt(
				driveKey,
				Buffer.from(driveMetaDataJSON)
			);
			drive.cipher = encryptedDriveMetaData.cipher;
			drive.cipherIV = encryptedDriveMetaData.cipherIV;
			transaction = await prepareArFSDriveTransaction(user, encryptedDriveMetaData.data, drive);
		} else {
			// The drive is public
			console.log('Creating a new Public Drive (name: %s) on the Permaweb', drive.driveName);
			transaction = await prepareArFSDriveTransaction(user, driveMetaDataJSON, drive);
		}
		// Update the file's data transaction ID
		drive.metaDataTxId = transaction.id;

		// Create the File Uploader object
		const uploader = await createDataUploader(transaction);

		// Update the Drive table to include this transaction information
		drive.metaDataSyncStatus = 2;

		await updateDb.updateDriveInDriveTable(
			drive.metaDataSyncStatus,
			drive.metaDataTxId,
			drive.cipher,
			drive.cipherIV,
			drive.driveId
		);

		// Begin to upload chunks
		while (!uploader.isComplete) {
			await uploader.uploadChunk();
		}

		if (uploader.isComplete) {
			console.log('SUCCESS Drive Name %s was submitted with TX %s', drive.driveName, drive.metaDataTxId);
		}
		return true;
	} catch (err) {
		console.log(err);
		console.log('Error uploading new Drive metadata %s', drive.driveName);
		return false;
	}
}

// This will prepare and sign a v2 data transaction using ArFS File Metadata Tags
export async function createFileFolderMetaDataTransaction(
	metaData: ArFSFileFolderEntity,
	secondaryFileMetaData: string,
	walletPrivateKey?: JWKInterface
): Promise<Transaction> {
	let transaction: Transaction;
	if (walletPrivateKey) {
		// Create the arweave transaction using the file data and private key
		transaction = await arweave.createTransaction({ data: secondaryFileMetaData }, walletPrivateKey);
	} else {
		transaction = await arweave.createTransaction({ data: secondaryFileMetaData }); // Will use ArConnect if no wallet present
	}

	// Tag file with ArFS Tags
	transaction.addTag('App-Name', metaData.appName);
	transaction.addTag('App-Version', metaData.appVersion);
	transaction.addTag('Unix-Time', metaData.unixTime.toString());
	transaction.addTag('Content-Type', metaData.contentType);
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
			// If the parentFolderId is 0, then this is a root folder
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

// Creates a Transaction uploader object for a given arweave transaction
export async function createDataUploader(transaction: Transaction): Promise<TransactionUploader> {
	// Create an uploader object
	const uploader = await arweave.transactions.getUploader(transaction);
	return uploader;
}

// Scans through the queue & checks if a file has been mined, and if it has moves to Completed Table. If a file is not on the permaweb it will be uploaded
export async function checkUploadStatus(login: string): Promise<string> {
	try {
		console.log('---Checking Upload Status---');
		const today = Math.round(Date.now() / 1000);
		let permaWebLink: string;
		let confirmations: number;

		// Get all data bundles that need to have their V2 transactions checked (bundleSyncStatus of 2)
		const unsyncedBundles: types.ArDriveBundle[] = getDb.getAllUploadedBundlesFromBundleTable(login);
		await common.asyncForEach(unsyncedBundles, async (unsyncedBundle: types.ArDriveBundle) => {
			confirmations = await getTransactionStatus(unsyncedBundle.bundleTxId);
			if (confirmations >= MAX_CONFIRMATIONS) {
				console.log('SUCCESS! Data bundle was uploaded with TX of %s', unsyncedBundle.bundleTxId);
				console.log('...your most recent files can now be accessed on the PermaWeb!');
				await updateDb.completeBundleFromBundleTable(unsyncedBundle.id);
				const dataItemsToComplete: types.ArFSFileMetaData[] = getDb.getAllUploadedDataItemsFromSyncTable(
					login,
					unsyncedBundle.bundleTxId
				);
				await common.asyncForEach(dataItemsToComplete, async (dataItemToComplete: types.ArFSFileMetaData) => {
					permaWebLink = constants.gatewayURL.concat(dataItemToComplete.dataTxId);
					// Complete the files by setting permaWebLink, fileMetaDataSyncStatus and fileDataSyncStatus to 3
					await updateDb.completeFileDataItemFromSyncTable(permaWebLink, dataItemToComplete.id);
				});
			} else {
				const uploadTime = await getDb.getBundleUploadTimeFromBundleTable(unsyncedBundle.id);
				const cutoffTime = uploadTime.uploadTime + 60 * 60 * 1000; // Cancel if the tx is older than 60 minutes
				if (today < cutoffTime) {
					console.log(
						'%s data bundle is still being uploaded to the PermaWeb (TX_PENDING) with %s confirmations',
						unsyncedBundle.bundleTxId,
						confirmations
					);
				} else {
					console.log('%s data bundle failed to be uploaded (TX_FAILED)', unsyncedBundle.bundleTxId);

					// Since it failed, lets retry data transaction by flipping the sync status to 1
					const dataItemsToRetry: types.ArFSFileMetaData[] = getDb.getAllUploadedDataItemsFromSyncTable(
						login,
						unsyncedBundle.bundleTxId
					);
					await common.asyncForEach(dataItemsToRetry, async (dataItemToRetry: types.ArFSFileMetaData) => {
						// Retry the files by setting fileMetaDataSyncStatus and fileDataSyncStatus to 1
						await updateDb.setFileDataItemSyncStatus(dataItemToRetry.id);
					});
				}
			}
		});

		// Gets all V2 transactions that need to have their transactions checked (fileDataSyncStatus or metaDataSyncStatus of 2)
		const unsyncedFiles: types.ArFSFileMetaData[] = getDb.getAllUploadedFilesFromSyncTable(login);
		await common.asyncForEach(unsyncedFiles, async (unsyncedFile: types.ArFSFileMetaData) => {
			// Is the file data uploaded on the web?
			if (+unsyncedFile.fileDataSyncStatus === 2) {
				confirmations = await getTransactionStatus(unsyncedFile.dataTxId);
				if (confirmations >= MAX_CONFIRMATIONS) {
					permaWebLink = constants.gatewayURL.concat(unsyncedFile.dataTxId);
					console.log(
						'SUCCESS! %s (%s) data was mined with %s confirmations',
						unsyncedFile.filePath,
						unsyncedFile.dataTxId,
						confirmations
					);
					console.log(
						'...you can access the file here %s',
						constants.gatewayURL.concat(unsyncedFile.dataTxId)
					);
					const fileToComplete = {
						fileDataSyncStatus: 3,
						permaWebLink,
						id: unsyncedFile.id
					};
					await updateDb.completeFileDataFromSyncTable(fileToComplete);
				} else {
					const uploadTime = await getDb.getFileUploadTimeFromSyncTable(unsyncedFile.id);
					const cutoffTime = uploadTime.uploadTime + 60 * 60 * 1000; // Cancel if the tx is older than 60 minutes
					if (today < cutoffTime) {
						console.log(
							'%s (%s) data is still being uploaded to the PermaWeb (TX_PENDING) with %s confirmations',
							unsyncedFile.filePath,
							unsyncedFile.dataTxId,
							confirmations
						);
					} else {
						console.log('%s (%s) data failed to be mined', unsyncedFile.filePath, unsyncedFile.dataTxId);
						// Retry data transaction
						await updateDb.setFileDataSyncStatus(1, unsyncedFile.id);
					}
				}
			}

			// Is the file metadata uploaded on the web?
			if (+unsyncedFile.fileMetaDataSyncStatus === 2) {
				confirmations = await getTransactionStatus(unsyncedFile.metaDataTxId);
				if (confirmations >= MAX_CONFIRMATIONS) {
					console.log(
						'SUCCESS! %s (%s) metadata was mined with %s confirmations',
						unsyncedFile.metaDataTxId,
						unsyncedFile.filePath,
						confirmations
					);
					const fileMetaDataToComplete = {
						fileMetaDataSyncStatus: 3,
						permaWebLink,
						id: unsyncedFile.id
					};
					await updateDb.completeFileMetaDataFromSyncTable(fileMetaDataToComplete);
				} else {
					const uploadTime = await getDb.getFileUploadTimeFromSyncTable(unsyncedFile.id);
					const cutoffTime = uploadTime.uploadTime + 60 * 60 * 1000; // Cancel if the tx is older than 60 minutes
					if (today < cutoffTime) {
						console.log(
							'%s (%s) metadata is still being uploaded to the PermaWeb (TX_PENDING) with %s confirmations',
							unsyncedFile.filePath,
							unsyncedFile.metaDataTxId,
							confirmations
						);
					} else {
						console.log(
							'%s (%s) metadata failed to be mined',
							unsyncedFile.filePath,
							unsyncedFile.metaDataTxId
						);
						// Retry data transaction
						await updateDb.setFileDataSyncStatus(1, unsyncedFile.id);
					}
				}
			}
		});

		// Get all drives that need to have their transactions checked (metaDataSyncStatus of 2)
		const unsyncedDrives: types.ArFSDriveMetaData[] = getDb.getAllUploadedDrivesFromDriveTable();
		await common.asyncForEach(unsyncedDrives, async (unsyncedDrive: types.ArFSDriveMetaData) => {
			confirmations = await getTransactionStatus(unsyncedDrive.metaDataTxId);
			if (confirmations >= MAX_CONFIRMATIONS) {
				console.log(
					'SUCCESS! %s Drive metadata was uploaded with TX of %s',
					unsyncedDrive.driveName,
					unsyncedDrive.metaDataTxId
				);
				// Update the drive sync status to 3 so it is not checked any more
				const metaDataSyncStatus = 3;
				await updateDb.completeDriveMetaDataFromDriveTable(metaDataSyncStatus, unsyncedDrive.driveId);
			} else {
				const uploadTime = unsyncedDrive.unixTime;
				const cutoffTime = uploadTime + 60 * 60 * 1000; // Cancel if the tx is older than 60 minutes
				if (today < cutoffTime) {
					console.log(
						'%s (%s) Drive metadata is still being uploaded to the PermaWeb (TX_PENDING)',
						unsyncedDrive.driveName
					);
				} else {
					console.log(
						'%s (%s) Drive metadata failed to be uploaded (TX_FAILED)',
						unsyncedDrive.driveName,
						unsyncedDrive.metaDataTxId
					);
					// Retry metadata transaction
					await updateDb.setFileMetaDataSyncStatus(1, unsyncedDrive.id);
				}
			}
		});

		return 'Success checking upload file, folder and drive sync status';
	} catch (err) {
		console.log(err);
		return 'Error checking upload file status';
	}
}

// Grabs all files in the database for a user and determines the cost of all files/folders ready to be uploaded
export async function getPriceOfNextUploadBatch(login: string): Promise<types.UploadBatch> {
	let totalArweaveMetadataPrice = 0;
	let totalSize = 0;

	const uploadBatch: types.UploadBatch = {
		totalArDrivePrice: 0,
		totalUSDPrice: 0,
		totalSize: '0',
		totalNumberOfFileUploads: 0,
		totalNumberOfMetaDataUploads: 0,
		totalNumberOfFolderUploads: 0
	};

	// Get all files that are ready to be uploaded
	const filesToUpload: types.ArFSFileMetaData[] = getDb.getFilesToUploadFromSyncTable(login);
	if (Object.keys(filesToUpload).length > 0) {
		// Calculate the size/price for each file/folder
		await common.asyncForEach(filesToUpload, async (fileToUpload: types.ArFSFileMetaData) => {
			// If the file doesn't exist, we must remove it from the Sync table and not include it in our upload price
			if (!common.checkFileExistsSync(fileToUpload.filePath)) {
				console.log('%s is not local anymore.  Removing from the queue.', fileToUpload.filePath);
				await deleteFromSyncTable(fileToUpload.id);
				return 'File not local anymore';
			}

			// Calculate folders that are ready to be uploaded, but have no TX already
			if (+fileToUpload.fileMetaDataSyncStatus === 1 && fileToUpload.entityType === 'folder') {
				totalArweaveMetadataPrice += assumedMetadataTxARPrice;
				uploadBatch.totalNumberOfFolderUploads += 1;
			}

			// Entity is file, add up the sizes -- we do not bundle/approve more than 2GB of data at a time
			if (
				+fileToUpload.fileDataSyncStatus === 1 &&
				fileToUpload.entityType === 'file' &&
				totalSize <= 2000000000
			) {
				totalSize += +fileToUpload.fileSize;
				uploadBatch.totalNumberOfFileUploads += 1;
			}

			// Add in MetaData TX for a file
			if (
				+fileToUpload.fileMetaDataSyncStatus === 1 &&
				fileToUpload.entityType === 'file' &&
				+fileToUpload.fileDataSyncStatus !== 1
			) {
				totalArweaveMetadataPrice += assumedMetadataTxARPrice;
				uploadBatch.totalNumberOfMetaDataUploads += 1;
			}
			return 'Calculated price';
		});

		// Get estimated AR cost from gateway, and convert to AR for all files/folders to be uploaded
		let totalArweaveDataPrice = await estimateArCost(totalSize, uploadBatch.totalNumberOfFileUploads);

		// Finalize total price with assumed metadata price
		totalArweaveDataPrice += totalArweaveMetadataPrice;

		// Prepare the upload batch
		uploadBatch.totalArDrivePrice = +totalArweaveDataPrice.toFixed(12);
		uploadBatch.totalUSDPrice = uploadBatch.totalArDrivePrice * (await common.getArUSDPrice());
		uploadBatch.totalSize = common.formatBytes(totalSize);

		return uploadBatch;
	}
	return uploadBatch;
}

// Creates an arweave transaction to upload encrypted private ardrive metadata
export async function prepareArFSDriveTransaction(
	user: ArDriveUser,
	driveJSON: string | Buffer,
	driveMetaData: ArFSDriveMetaData
): Promise<Transaction> {
	// Create transaction
	const transaction = await arweave.createTransaction({ data: driveJSON }, JSON.parse(user.walletPrivateKey));

	// Tag file with ArFS Tags
	transaction.addTag('App-Name', constants.appName);
	transaction.addTag('App-Version', constants.appVersion);
	transaction.addTag('Unix-Time', driveMetaData.unixTime.toString());
	transaction.addTag('Drive-Id', driveMetaData.driveId);
	transaction.addTag('Drive-Privacy', driveMetaData.drivePrivacy);
	if (driveMetaData.drivePrivacy === 'private') {
		// If the file is private, we use extra tags
		// Tag file with Content-Type, Cipher and Cipher-IV and Drive-Auth-Mode
		transaction.addTag('Content-Type', 'application/octet-stream');
		transaction.addTag('Cipher', driveMetaData.cipher);
		transaction.addTag('Cipher-IV', driveMetaData.cipherIV);
		transaction.addTag('Drive-Auth-Mode', driveMetaData.driveAuthMode);
	} else {
		// Tag file with public tags only
		transaction.addTag('Content-Type', 'application/json');
	}
	transaction.addTag('ArFS', constants.arFSVersion);
	transaction.addTag('Entity-Type', 'drive');

	// Sign file
	await arweave.transactions.sign(transaction, JSON.parse(user.walletPrivateKey));
	return transaction;
}

// This will prepare and sign v2 data transaction using ArFS File Data Tags
export async function prepareArFSDataTransaction(
	user: ArDriveUser,
	fileData: Buffer,
	fileMetaData: ArFSFileMetaData,
	holder: string,
	tip: string
): Promise<Transaction> {
	// Create the arweave transaction using the file data and private key
	const transaction = await arweave.createTransaction(
		{ data: fileData, target: holder, quantity: tip },
		JSON.parse(user.walletPrivateKey)
	);

	transaction.addTag('App-Name', constants.appName);
	transaction.addTag('App-Version', constants.appVersion);
	if (tip !== '0') {
		transaction.addTag('Tip-Type', 'data upload');
	}

	// If the file is not public, we must encrypt it
	if (fileMetaData.isPublic === 0) {
		// Tag file with Content-Type, Cipher and Cipher-IV
		transaction.addTag('Content-Type', 'application/octet-stream');
		transaction.addTag('Cipher', fileMetaData.cipher);
		transaction.addTag('Cipher-IV', fileMetaData.dataCipherIV);
	} else {
		// Tag file with public tags only
		transaction.addTag('Content-Type', fileMetaData.contentType);
	}

	// Sign file
	await arweave.transactions.sign(transaction, JSON.parse(user.walletPrivateKey));
	return transaction;
}

// This will prepare and sign v2 data transaction using ArFS File Metadata Tags
export async function prepareArFSMetaDataTransaction(
	user: ArDriveUser,
	fileMetaData: ArFSFileMetaData,
	secondaryFileMetaData: string | Buffer
): Promise<Transaction> {
	// Create the arweave transaction using the file data and private key
	const transaction = await arweave.createTransaction(
		{ data: secondaryFileMetaData },
		JSON.parse(user.walletPrivateKey)
	);

	// Tag file with ArFS Tags
	transaction.addTag('App-Name', constants.appName);
	transaction.addTag('App-Version', constants.appVersion);
	transaction.addTag('Unix-Time', fileMetaData.unixTime.toString());
	if (fileMetaData.isPublic === 0) {
		// If the file is private, we use extra tags
		// Tag file with Content-Type, Cipher and Cipher-IV
		transaction.addTag('Content-Type', 'application/octet-stream');
		transaction.addTag('Cipher', fileMetaData.cipher);
		transaction.addTag('Cipher-IV', fileMetaData.metaDataCipherIV);
	} else {
		// Tag file with public tags only
		transaction.addTag('Content-Type', 'application/json');
	}
	transaction.addTag('ArFS', constants.arFSVersion);
	transaction.addTag('Entity-Type', fileMetaData.entityType);
	transaction.addTag('Drive-Id', fileMetaData.driveId);

	// Add file or folder specific tags
	if (fileMetaData.entityType === 'file') {
		transaction.addTag('File-Id', fileMetaData.fileId);
		transaction.addTag('Parent-Folder-Id', fileMetaData.parentFolderId);
	} else {
		transaction.addTag('Folder-Id', fileMetaData.fileId);
		if (fileMetaData.parentFolderId !== '0') {
			// Root folder transactions do not have Parent-Folder-Id
			transaction.addTag('Parent-Folder-Id', fileMetaData.parentFolderId);
		}
	}

	// Sign transaction
	await arweave.transactions.sign(transaction, JSON.parse(user.walletPrivateKey));
	return transaction;
}

// Estimates the amount of AR for a set of bytes
export async function estimateArCost(
	totalFileDataByteCount: number,
	numberOfFiles = 1,
	arweaveOracle: ArweaveOracle = new GatewayOracle(),
	communityOracle: CommunityOracle = arDriveCommunityOracle
): Promise<number> {
	// Extra bytes added to the header of data uploads
	const headerByteSize = 3210;
	const totalUploadByteCount = totalFileDataByteCount + numberOfFiles * headerByteSize;

	// Get Winston value from gateway, and convert to AR for all files/folders to be uploaded
	const winstonCost = await arweaveOracle.getWinstonPriceForByteCount(totalUploadByteCount);
	const arCost = common.winstonToAr(winstonCost);

	// Return cost, with added community tip
	return arCost + (await communityOracle.getCommunityARTip(arCost));
}
