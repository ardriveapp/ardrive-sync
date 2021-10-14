/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/no-unused-vars */
// download.js
import * as fs from 'fs';
import { downloadArDriveFileByTx } from './arweave';
import {
	asyncForEach,
	setNewFilePaths,
	updateFilePath,
	setFolderChildrenPaths,
	checkFileExistsSync,
	checkExactFileExistsSync,
	setAllFolderHashes,
	setAllFileHashes,
	setAllParentFolderIds,
	setAllFolderSizes,
	checkForMissingLocalFiles
} from './common';
import { checksumFile } from './crypto';
import {
	getAllDrivesByPrivacyFromDriveTable,
	getDriveLastBlockHeight,
	getFilesToDownload,
	getFoldersToCreate,
	getMyFileDownloadConflicts,
	getLatestFolderVersionFromSyncTable,
	getPreviousFileVersionFromSyncTable,
	getLatestFileVersionFromSyncTable,
	getProfileLastBlockHeight,
	getDriveFromDriveTable
} from './db/db_get';
import {
	setDriveLastBlockHeight,
	updateFileDownloadStatus,
	setPermaWebFileToCloudOnly,
	updateFileHashInSyncTable,
	addDriveToDriveTable,
	setProfileLastBlockHeight
} from './db/db_update';
import { getLatestBlockHeight } from './gateway';
import {
	getAllMyDataFileTxs,
	getFileMetaDataFromTx,
	getAllMySharedDataFileTxs,
	getAllMyPrivateArDriveIds,
	getAllMyPublicArDriveIds
} from './gql';
import { ArDriveUser, ArFSDriveMetaData, ArFSFileMetaData } from './types/base_Types';
import { GQLEdgeInterface } from './types/gql_Types';

// Gets all of the files from your ArDrive (via ARQL) and loads them into the database.
export async function getMyArDriveFilesFromPermaWeb(user: ArDriveUser): Promise<string> {
	// Get your private files
	console.log('---Getting all your Private ArDrive files---');
	let drives: ArFSDriveMetaData[] = await getAllDrivesByPrivacyFromDriveTable(user.login, 'personal', 'private');
	await asyncForEach(drives, async (drive: ArFSDriveMetaData) => {
		// Get the last block height that has been synced
		let lastBlockHeight = await getDriveLastBlockHeight(drive.driveId);
		lastBlockHeight = lastBlockHeight.lastBlockHeight;
		const privateTxIds = await getAllMyDataFileTxs(user.walletPublicKey, drive.driveId, lastBlockHeight);
		if (privateTxIds !== undefined) {
			await asyncForEach(privateTxIds, async (privateTxId: GQLEdgeInterface) => {
				await getFileMetaDataFromTx(privateTxId, user);
			});
		}
		// Get and set the latest block height for each drive synced
		const latestBlockHeight: number = await getLatestBlockHeight();
		await setDriveLastBlockHeight(latestBlockHeight, drive.driveId);
	});

	// Get your public files
	console.log('---Getting all your Public ArDrive files---');
	drives = await getAllDrivesByPrivacyFromDriveTable(user.login, 'personal', 'public');
	await asyncForEach(drives, async (drive: ArFSDriveMetaData) => {
		// Get the last block height that has been synced
		let lastBlockHeight = await getDriveLastBlockHeight(drive.driveId);
		lastBlockHeight = lastBlockHeight.lastBlockHeight;
		const publicTxIds = await getAllMyDataFileTxs(user.walletPublicKey, drive.driveId, lastBlockHeight);
		if (publicTxIds !== undefined) {
			await asyncForEach(publicTxIds, async (publicTxId: GQLEdgeInterface) => {
				await getFileMetaDataFromTx(publicTxId, user);
			});
		}
		// Get and set the latest block height for each drive synced
		const latestBlockHeight: number = await getLatestBlockHeight();
		await setDriveLastBlockHeight(latestBlockHeight, drive.driveId);
	});

	// Get your shared public files
	console.log('---Getting all your Shared Public ArDrive files---');
	drives = await getAllDrivesByPrivacyFromDriveTable(user.login, 'shared', 'public');
	await asyncForEach(drives, async (drive: ArFSDriveMetaData) => {
		// Get the last block height that has been synced
		let lastBlockHeight = await getDriveLastBlockHeight(drive.driveId);
		lastBlockHeight = lastBlockHeight.lastBlockHeight;
		const sharedPublicTxIds = await getAllMySharedDataFileTxs(drive.driveId, lastBlockHeight);
		if (sharedPublicTxIds !== undefined) {
			await asyncForEach(sharedPublicTxIds, async (sharedPublicTxId: GQLEdgeInterface) => {
				await getFileMetaDataFromTx(sharedPublicTxId, user);
			});
		}
		// Get and set the latest block height for each drive synced
		const latestBlockHeight: number = await getLatestBlockHeight();
		await setDriveLastBlockHeight(latestBlockHeight, drive.driveId);
	});

	// File path is not present by default, so we must generate them for each new file, folder or drive found
	await setNewFilePaths();
	return 'Success';
}

// Downloads all ardrive files that are not local
export async function downloadMyArDriveFiles(user: ArDriveUser): Promise<string> {
	console.log('---Downloading any unsynced files---');
	// Get the Files and Folders which have isLocal set to 0 that we are not ignoring
	const filesToDownload: ArFSFileMetaData[] = await getFilesToDownload(user.login);
	const foldersToCreate: ArFSFileMetaData[] = await getFoldersToCreate(user.login);

	// Get the special batch of File Download Conflicts
	const fileConflictsToDownload: ArFSFileMetaData[] = await getMyFileDownloadConflicts(user.login);

	// Process any folders to create
	if (foldersToCreate.length > 0) {
		// there are new folders to create
		await asyncForEach(foldersToCreate, async (folderToCreate: ArFSFileMetaData) => {
			// Establish the folder path first
			if (folderToCreate.filePath === '') {
				folderToCreate.filePath = await updateFilePath(folderToCreate);
			}
			// Get the latest folder version from the DB
			const latestFolderVersion: ArFSFileMetaData = await getLatestFolderVersionFromSyncTable(
				folderToCreate.fileId
			);
			// If this folder is the latest version, then we should create the folder
			try {
				if (latestFolderVersion.filePath === folderToCreate.filePath) {
					// Compare against the previous version for a different file name or parent folder
					// If it does then this means there was a rename or move, and then we do not download a new file, rather rename/move the old
					const previousFolderVersion: ArFSFileMetaData = await getPreviousFileVersionFromSyncTable(
						folderToCreate.fileId
					);
					// If undefined, then there is no previous folder version.
					if (previousFolderVersion === undefined) {
						if (!fs.existsSync(folderToCreate.filePath)) {
							console.log('Creating new folder from permaweb %s', folderToCreate.filePath);
							fs.mkdirSync(folderToCreate.filePath);
						}
					} else if (
						+previousFolderVersion.isLocal === 1 &&
						(folderToCreate.fileName !== previousFolderVersion.fileName ||
							folderToCreate.parentFolderId !== previousFolderVersion.parentFolderId)
					) {
						// There is a previous folder version, so we must rename/move it to the latest file path
						// Need error handling here in case file is in use
						fs.renameSync(previousFolderVersion.filePath, folderToCreate.filePath);

						// All children of the folder need their paths update in the database
						await setFolderChildrenPaths(folderToCreate);

						// Change the older version to not local/ignored since it has been renamed or moved
						await updateFileDownloadStatus('0', previousFolderVersion.id); // Mark older version as not local
						await setPermaWebFileToCloudOnly(previousFolderVersion.id); // Mark older version as ignored
					} else if (!fs.existsSync(folderToCreate.filePath)) {
						console.log('Creating new folder from permaweb %s', folderToCreate.filePath);
						fs.mkdirSync(folderToCreate.filePath);
					}
					await updateFileDownloadStatus('1', folderToCreate.id);
				} else {
					// This is an older version, and we ignore it for now.
					await updateFileDownloadStatus('0', folderToCreate.id); // Mark older fodler version as not local and ignored
					await setPermaWebFileToCloudOnly(folderToCreate.id); // Mark older folder version as ignored
				}
			} catch (err) {
				// console.log (err)
			}
		});
	}
	// Process any files to download
	if (filesToDownload.length > 0) {
		// There are unsynced files to process
		await asyncForEach(filesToDownload, async (fileToDownload: ArFSFileMetaData) => {
			// Establish the file path first
			if (fileToDownload.filePath === '') {
				fileToDownload.filePath = await updateFilePath(fileToDownload);
			}
			// Get the latest file version from the DB so we can download them.  Versions that are not the latest will not be downloaded.
			const latestFileVersion: ArFSFileMetaData = await getLatestFileVersionFromSyncTable(fileToDownload.fileId);
			try {
				// Check if this file is the latest version
				if (fileToDownload.id === latestFileVersion.id) {
					// Compare against the previous version for a different file name or parent folder
					// If it does then this means there was a rename or move, and then we do not download a new file, rather rename/move the old
					const previousFileVersion: ArFSFileMetaData = await getPreviousFileVersionFromSyncTable(
						fileToDownload.fileId
					);

					// If undefined, then there is no previous file version.
					if (previousFileVersion === undefined) {
						// Does this exact file already exist locally?  If not, then we download it
						if (!checkFileExistsSync(fileToDownload.filePath)) {
							// File is not local, so we download and decrypt if necessary
							// UPDATE THIS TO NOT TRY TO SET LOCAL TIME
							await downloadArDriveFileByTx(user, fileToDownload);
							const currentDate = new Date();
							const lastModifiedDate = new Date(Number(fileToDownload.lastModifiedDate));
							fs.utimesSync(fileToDownload.filePath, currentDate, lastModifiedDate);
						} else {
							console.log('%s is already local, skipping download', fileToDownload.filePath);
						}
					}
					// Check if this is an older version i.e. same file name/parent folder.
					else if (
						+previousFileVersion.isLocal === 1 &&
						(fileToDownload.fileName !== previousFileVersion.fileName ||
							fileToDownload.parentFolderId !== previousFileVersion.parentFolderId)
					) {
						// Need error handling here in case file is in use
						fs.renameSync(previousFileVersion.filePath, fileToDownload.filePath);

						// Change the older version to not local/ignored since it has been renamed or moved
						await updateFileDownloadStatus('0', previousFileVersion.id); // Mark older version as not local
						await setPermaWebFileToCloudOnly(previousFileVersion.id); // Mark older version as ignored
						// This is a new file version
					} else {
						// Does this exact file already exist locally?  If not, then we download it
						if (!checkExactFileExistsSync(fileToDownload.filePath, fileToDownload.lastModifiedDate)) {
							// Download and decrypt the file if necessary
							await downloadArDriveFileByTx(user, fileToDownload);
							const currentDate = new Date();
							const lastModifiedDate = new Date(Number(fileToDownload.lastModifiedDate));
							fs.utimesSync(fileToDownload.filePath, currentDate, lastModifiedDate);
						} else {
							console.log('%s is already local, skipping download', fileToDownload.filePath);
						}
					}

					// Hash the file and update it in the database
					const fileHash = await checksumFile(fileToDownload.filePath);
					await updateFileHashInSyncTable(fileHash, fileToDownload.id);

					// Update the file's local status in the database
					await updateFileDownloadStatus('1', fileToDownload.id);

					return 'Downloaded';
				} else {
					// This is an older version, and we ignore it for now.
					await updateFileDownloadStatus('0', fileToDownload.id); // Mark older version as not local
					await setPermaWebFileToCloudOnly(fileToDownload.id); // Mark older version as ignored
				}
				return 'Checked file';
			} catch (err) {
				// console.log (err)
				console.log('Error downloading file %s to %s', fileToDownload.fileName, fileToDownload.filePath);
				return 'Error downloading file';
			}
		});
	}
	// Process any previously conflicting file downloads
	if (fileConflictsToDownload.length > 0) {
		await asyncForEach(fileConflictsToDownload, async (fileConflictToDownload: ArFSFileMetaData) => {
			// This file is on the Permaweb, but it is not local or the user wants to overwrite the local file
			console.log('Overwriting local file %s', fileConflictToDownload.filePath);
			await downloadArDriveFileByTx(user, fileConflictToDownload);
			// Ensure the file downloaded has the same lastModifiedDate as before
			const currentDate = new Date();
			const lastModifiedDate = new Date(Number(fileConflictToDownload.lastModifiedDate));
			fs.utimesSync(fileConflictToDownload.filePath, currentDate, lastModifiedDate);
			await updateFileDownloadStatus('1', fileConflictToDownload.id);
			return 'File Overwritten';
		});
	}

	// Run some other processes to ensure downloaded files are set properly
	await setAllFolderHashes();
	await setAllFileHashes();
	await setAllParentFolderIds();
	await setAllFolderSizes();
	await checkForMissingLocalFiles();

	return 'Downloaded all ArDrive files';
}

// Gets all Private and Public Drives associated with a user profile and adds to the database
export async function getAllMyPersonalDrives(user: ArDriveUser): Promise<ArFSDriveMetaData[]> {
	console.log('---Getting all your Personal Drives---');
	// Get the last block height that has been synced
	let lastBlockHeight = await getProfileLastBlockHeight(user.login);
	let privateDrives: ArFSDriveMetaData[] = [];
	let publicDrives: ArFSDriveMetaData[] = [];

	// If undefined, by default we sync from block 0
	if (lastBlockHeight === undefined) {
		lastBlockHeight = 0;
	} else {
		lastBlockHeight = lastBlockHeight.lastBlockHeight;
	}

	// Get all private and public drives since last block height
	try {
		privateDrives = await getAllMyPrivateArDriveIds(user, lastBlockHeight);
		if (privateDrives.length > 0) {
			await asyncForEach(privateDrives, async (privateDrive: ArFSDriveMetaData) => {
				const isDriveMetaDataSynced = await getDriveFromDriveTable(privateDrive.driveId);
				if (!isDriveMetaDataSynced) {
					await addDriveToDriveTable(privateDrive);
				}
			});
		}
		publicDrives = await getAllMyPublicArDriveIds(user.login, user.walletPublicKey, lastBlockHeight);
		if (publicDrives.length > 0) {
			await asyncForEach(publicDrives, async (publicDrive: ArFSDriveMetaData) => {
				const isDriveMetaDataSynced = await getDriveFromDriveTable(publicDrive.driveId);
				if (!isDriveMetaDataSynced) {
					await addDriveToDriveTable(publicDrive);
				}
			});
		}
		// Get and set the latest block height for the profile that has been synced
		const latestBlockHeight: number = await getLatestBlockHeight();
		await setProfileLastBlockHeight(latestBlockHeight, user.login);

		return publicDrives.concat(privateDrives);
	} catch (err) {
		console.log(err);
		console.log('Error getting all Personal Drives');
		return publicDrives;
	}
}
