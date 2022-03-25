#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
// index.ts
import { arDriveCommunityOracle } from './ardrive_community_oracle';
import { checkUploadStatus, getPriceOfNextUploadBatch } from './arfs';
import { uploadArDriveFiles } from './arweave';
import { uploadArDriveFilesAndBundles } from './bundles';
import { sleep } from './common';
import { setupDatabase } from './db/db_common';
import { getUserFromProfile, getMyFileDownloadConflicts } from './db/db_get';
import { setProfileAutoSyncApproval, setProfileWalletBalance } from './db/db_update';
import { getMyArDriveFilesFromPermaWeb, downloadMyArDriveFiles, getAllMyPersonalDrives } from './download';
import { startWatchingFolders, resolveFileDownloadConflict } from './files';
import { updateUserSyncFolderPath, setupDrives } from './profile';
import * as cli from './prompts';
import { ArDriveUser, ArFSFileMetaData, UploadBatch } from './types/base_Types';
import { addNewUser, getUser, passwordCheck, getWalletBalance } from './wallet';

async function main() {
	// Setup database if it doesnt exist
	try {
		await setupDatabase('./.ardrive-sync.db');
	} catch (err) {
		console.error(err);
		return;
	}
	let user: ArDriveUser = {
		login: '',
		dataProtectionKey: '',
		walletPrivateKey: '',
		walletPublicKey: '',
		syncFolderPath: '',
		autoSyncApproval: 0
	};
	let fileDownloadConflicts: ArFSFileMetaData[] = [];
	let useBundles = false; // Will use regular v2 transactions or ANS104 bundles
	let downloadFiles = true;
	let syncFiles = true;

	// Start background task to fetch ArDrive community tip setting
	arDriveCommunityOracle.setExactTipSettingInBackground();

	// Ask the user for their login name
	const login = await cli.promptForLogin();

	// Check to see if it exists
	user = await getUserFromProfile(login);

	// If no user is found, prompt the user to create a new one
	if (user === undefined) {
		// Welcome message and info
		console.log("We have not detected a profile for your login!  Let's get one set up.");
		user = await cli.promptForNewUserInfo(login);
		// Allow the user to toggle bundles
		useBundles = await cli.promptForBundles();
		syncFiles = await cli.promptForSync();
		if (syncFiles) {
			downloadFiles = await cli.promptForDownload();
		}
		const loginPassword = user.dataProtectionKey;
		await addNewUser(user.dataProtectionKey, user);
		user = await getUser(loginPassword, login);
	} else {
		// Allow the user to login
		console.log('You already have an existing ArDrive', login);
		const loginPassword = await cli.promptForLoginPassword();
		const passwordResult: boolean = await passwordCheck(loginPassword, login);
		if (passwordResult) {
			user = await getUser(loginPassword, login);
			console.log('Before we get syncing...');

			// Allow the user to toggle bundles
			useBundles = await cli.promptForBundles();
			syncFiles = await cli.promptForSync();
			if (syncFiles) {
				downloadFiles = await cli.promptForDownload();
			}

			// Allow the user to add other drives
			await cli.promptToAddOrCreatePersonalPrivateDrive(user);
			await cli.promptToAddOrCreatePersonalPublicDrive(user);
			await cli.promptToAddSharedPublicDrive(user);

			// Allow the user to change sync location
			const newSyncFolderPath: string = await cli.promptToChangeSyncFolderPath(user.syncFolderPath);
			if (newSyncFolderPath != 'Skipped') {
				console.log('Updating to new sync folder path ', newSyncFolderPath);
				const result = await updateUserSyncFolderPath(user.login, newSyncFolderPath);
				if (result === 'Success') {
					console.log('Successfully moved Sync folder path to %s', newSyncFolderPath);

					// Update current user object
					user.syncFolderPath = newSyncFolderPath;
				} else {
					console.log('Error moving Sync folder path.  Continuing to use %s', user.syncFolderPath);
				}
			}

			// Allow the user to remove a shared, public or private drive
			await cli.promptToRemoveDrive(user.login);

			// Allow the user to change the auto approve setting
			user.autoSyncApproval = await cli.promptForAutoSyncApproval();
			await setProfileAutoSyncApproval(user.autoSyncApproval, user.login);
		} else {
			console.log('You have entered a bad password for this .. Goodbye');
			return 0;
		}
	}

	// Initialize Drives
	await setupDrives(user.login, user.syncFolderPath);

	// Get all of the public and private files for the user and store in the local database before starting folder watcher
	if (syncFiles) {
		await getMyArDriveFilesFromPermaWeb(user);
	}

	// Download any files from Arweave that need to be synchronized locally
	if (downloadFiles && syncFiles) {
		await downloadMyArDriveFiles(user);
	}

	// Get latest wallet balance
	const balance = await getWalletBalance(user.walletPublicKey);
	await setProfileWalletBalance(+balance, login);

	// Get all of the latest personal public and private drives for the user, and store in the local database
	await getAllMyPersonalDrives(user);

	// Initialize Chokidar Folder Watcher by providing the Sync Folder Path, Private and Public ArDrive IDs
	await startWatchingFolders(user);

	// Continually check for things to process and actions to notify the user
	let loop = true;
	while (loop === true) {
		try {
			if (syncFiles) {
				// Get all of the public and private files for the user and store in the local database
				await getMyArDriveFilesFromPermaWeb(user);
			}

			// Download any files from Arweave that need to be synchronized locally
			if (downloadFiles && syncFiles) {
				await downloadMyArDriveFiles(user);
			}

			// Check the status of any files that may have been already been uploaded
			await checkUploadStatus(user.login);

			// Figure out the cost of the next batch of uploads, and ask the user if they want to approve
			// If the size is -1, then the user does not have enough funds and the upload is skipped
			const uploadBatch: UploadBatch = await getPriceOfNextUploadBatch(user.login);
			if (uploadBatch.totalArDrivePrice > 0) {
				if (await cli.promptForArDriveUpload(login, uploadBatch, user.autoSyncApproval)) {
					if (useBundles) {
						await uploadArDriveFilesAndBundles(user);
					} else {
						await uploadArDriveFiles(user);
					}
				}
			}

			// Resolve and download conflicts, and process on the next batch
			fileDownloadConflicts = await getMyFileDownloadConflicts(user.login);
			if (fileDownloadConflicts) {
				fileDownloadConflicts.forEach(async (fileDownloadConflict: ArFSFileMetaData) => {
					const response = await cli.promptForFileOverwrite(fileDownloadConflict.filePath);
					await resolveFileDownloadConflict(
						response,
						fileDownloadConflict.fileName,
						fileDownloadConflict.filePath,
						fileDownloadConflict.id.toString()
					);
				});
			}

			// Update date
			const today = new Date();
			const date = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
			const time = `${today.getHours()}:${today.getMinutes()}:${today.getSeconds()}`;
			const dateTime = `${date} ${time}`;

			// Get the latest balance of the loaded wallet.
			const balance = await getWalletBalance(user.walletPublicKey);
			await setProfileWalletBalance(+balance, login);
			console.log('%s Syncronization completed.  Current AR Balance: %s', dateTime, balance);
			await sleep(60000);
		} catch (err) {
			console.log(err);
			loop = false;
		}
	}
	return 0;
}

function displayBanner() {
	console.log('	Welcome to ArDrive-Sync!');
	console.log('---------------------------------------');
}

displayBanner();
main();
