import * as fs from 'fs';
import { ArDriveUser } from './types/base_Types';
import { deriveDriveKey, deriveFileKey } from './crypto';
import { stagingAppUrl } from './constants';
import * as types from './types/base_Types';
import path from 'path';
import { addDriveToDriveTable, setDriveToSync, addFileToSyncTable } from './db/db_update';
import { getSharedPublicDrive, getPublicDriveRootFolderTxId } from './gql';

// Derives a file key from the drive key and formats it into a Private file sharing link using the file id
export async function createPrivateFileSharingLink(
	user: ArDriveUser,
	fileToShare: types.ArFSFileMetaData
): Promise<string> {
	let fileSharingUrl = '';
	try {
		const driveKey: Buffer = await deriveDriveKey(
			user.dataProtectionKey,
			fileToShare.driveId,
			user.walletPrivateKey
		);
		const fileKey: Buffer = await deriveFileKey(fileToShare.fileId, driveKey);
		fileSharingUrl = stagingAppUrl.concat(
			'/#/file/',
			fileToShare.fileId,
			'/view?fileKey=',
			fileKey.toString('base64')
		);
	} catch (err) {
		console.log(err);
		console.log('Cannot generate Private File Sharing Link');
		fileSharingUrl = 'Error';
	}
	return fileSharingUrl;
}

// Creates a Public file sharing link using the File Id.
export async function createPublicFileSharingLink(fileToShare: types.ArFSFileMetaData): Promise<string> {
	let fileSharingUrl = '';
	try {
		fileSharingUrl = stagingAppUrl.concat('/#/file/', fileToShare.fileId, '/view');
	} catch (err) {
		console.log(err);
		console.log('Cannot generate Public File Sharing Link');
		fileSharingUrl = 'Error';
	}
	return fileSharingUrl;
}

// Creates a Public drive sharing link using the Drive Id
export async function createPublicDriveSharingLink(driveToShare: types.ArFSDriveMetaData): Promise<string> {
	let driveSharingUrl = '';
	try {
		driveSharingUrl = stagingAppUrl.concat('/#/drives/', driveToShare.driveId);
	} catch (err) {
		console.log(err);
		console.log('Cannot generate Public Drive Sharing Link');
		driveSharingUrl = 'Error';
	}
	return driveSharingUrl;
}

// Add a Shared Public drive, using a DriveId
export async function addSharedPublicDrive(user: ArDriveUser, driveId: string): Promise<string> {
	try {
		// Get the drive information from arweave
		const sharedPublicDrive: types.ArFSDriveMetaData = await getSharedPublicDrive(driveId);

		// If there is no meta data tx id, then the drive id does not exist or has not been mined yet
		if (sharedPublicDrive.metaDataTxId === '0') {
			return 'Invalid';
		}

		// Set the drives login
		sharedPublicDrive.login = user.login;

		// Set the drive to sync locally
		sharedPublicDrive.isLocal = 1;

		// Check if the drive path exists, if not, create it
		const drivePath: string = path.join(user.syncFolderPath, sharedPublicDrive.driveName);
		if (!fs.existsSync(drivePath)) {
			fs.mkdirSync(drivePath);
		}

		// Get the root folder ID for this drive
		const metaDataTxId = await getPublicDriveRootFolderTxId(
			sharedPublicDrive.driveId,
			sharedPublicDrive.rootFolderId
		);

		// Setup Drive Root Folder
		const driveRootFolderToAdd: types.ArFSFileMetaData = {
			id: 0,
			login: user.login,
			appName: sharedPublicDrive.appName,
			appVersion: sharedPublicDrive.appVersion,
			unixTime: sharedPublicDrive.unixTime,
			contentType: 'application/json',
			entityType: 'folder',
			driveId: sharedPublicDrive.driveId,
			parentFolderId: '0', // Root folders have no parent folder ID.
			fileId: sharedPublicDrive.rootFolderId,
			filePath: drivePath,
			fileName: sharedPublicDrive.driveName,
			fileHash: '0',
			fileSize: 0,
			lastModifiedDate: sharedPublicDrive.unixTime,
			fileVersion: 0,
			isPublic: 1,
			isLocal: 1,
			metaDataTxId,
			dataTxId: '0',
			permaWebLink: '',
			fileDataSyncStatus: 0, // Folders do not require a data tx
			fileMetaDataSyncStatus: 3,
			cipher: '',
			dataCipherIV: '',
			metaDataCipherIV: '',
			cloudOnly: 0
		};

		// Add Drive to Drive Table
		await addDriveToDriveTable(sharedPublicDrive);
		await setDriveToSync(sharedPublicDrive.driveId);

		// Add the Root Folder to the Sync Table
		await addFileToSyncTable(driveRootFolderToAdd);
		return sharedPublicDrive.driveName;
	} catch (err) {
		console.log(err);
		return 'Invalid';
	}
}
