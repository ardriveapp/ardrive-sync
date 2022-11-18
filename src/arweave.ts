import { asyncForEach } from './common';
import { ArDriveUser, ArFSDriveMetaData, ArFSFileMetaData } from './types/base_Types';
import {
	getDriveRootFolderFromSyncTable,
	getFilesToUploadFromSyncTable,
	getNewDrivesFromDriveTable
} from './db/db_get';
import Arweave from 'arweave';
import { uploadArFSDriveMetaData, uploadArFSFileData, uploadArFSFileMetaData } from './arfs';
import * as common from './common';
import axios from 'axios';
import axiosRetry, { exponentialDelay } from 'axios-retry';

// Initialize Arweave
export const arweave = Arweave.init({
	host: 'arweave.net', // Arweave Gateway
	port: 443,
	protocol: 'https',
	timeout: 600000
});

// Gets only the data of a given ArDrive Data transaction (U8IntArray)
export async function getTransactionData(txId: string): Promise<string | Uint8Array> {
	const protocol = 'https';
	const host = 'arweave.net';
	const portStr = '';
	const reqURL = `${protocol}://${host}${portStr}/${txId}`;
	const axiosInstance = axios.create();
	const retries = 2;
	axiosRetry(axiosInstance, { retries });

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
export async function getTransactionStatus(txId: string): Promise<number> {
	try {
		const protocol = 'https';
		const host = 'arweave.net';
		const portStr = '';
		const reqURL = `${protocol}://${host}${portStr}/tx/${txId}/status`;
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
		const dataString = await common.Utf8ArrayToStr(txData);
		if (dataString === 'Pending') {
			return 0;
		}
		const dataJSON = await JSON.parse(dataString);
		return +dataJSON.number_of_confirmations;
	} catch (err) {
		console.log('Error getting transaction status');
		console.log(err);
		return -1;
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

// Uploads all files in the queue as V2 transactions
export async function uploadArDriveFiles(user: ArDriveUser): Promise<string> {
	try {
		let filesUploaded = 0;
		console.log('---Uploading All Queued Files and Folders---');
		const filesToUpload = getFilesToUploadFromSyncTable(user.login);
		if (Object.keys(filesToUpload).length > 0) {
			// Ready to upload
			await asyncForEach(filesToUpload, async (fileToUpload: ArFSFileMetaData) => {
				if (fileToUpload.entityType === 'file') {
					// Check to see if we have to upload the File Data and Metadata
					// If not, we just check to see if we have to update metadata.
					if (+fileToUpload.fileDataSyncStatus === 1) {
						console.log('Uploading file data and metadata - %s', fileToUpload.fileName);
						fileToUpload.dataTxId = await uploadArFSFileData(user, fileToUpload);
						if (fileToUpload.dataTxId !== 'Error') {
							await uploadArFSFileMetaData(user, fileToUpload);
						} else {
							console.log("This file's data was not uploaded properly, please retry");
						}
					} else if (+fileToUpload.fileMetaDataSyncStatus === 1) {
						console.log('Uploading file metadata only - %s', fileToUpload.fileName);
						await uploadArFSFileMetaData(user, fileToUpload);
					}
				} else if (fileToUpload.entityType === 'folder') {
					console.log('Uploading folder - %s', fileToUpload.fileName);
					await uploadArFSFileMetaData(user, fileToUpload);
				}
				filesUploaded += 1;
			});
		}
		if (filesUploaded > 0) {
			console.log('Uploaded %s files to your ArDrive!', filesUploaded);

			// Check if this was the first upload of the user's drive, if it was then upload a Drive transaction as well
			// Check for unsynced drive entities and create if necessary
			const newDrives: ArFSFileMetaData[] = getNewDrivesFromDriveTable(user.login);
			if (newDrives.length > 0) {
				console.log('   Wow that was your first ARDRIVE Transaction!  Congrats!');
				console.log(
					'   Lets finish setting up your profile by submitting a few more small transactions to the network.'
				);
				await asyncForEach(newDrives, async (newDrive: ArFSDriveMetaData) => {
					// Create the Drive metadata transaction as submit as V2
					const success = await uploadArFSDriveMetaData(user, newDrive);
					console.log(success);
					if (success) {
						// Create the Drive Root folder and submit as V2 transaction
						const driveRootFolder: ArFSFileMetaData = await getDriveRootFolderFromSyncTable(
							newDrive.rootFolderId
						);
						await uploadArFSFileMetaData(user, driveRootFolder);
					}
				});
			}
		}
		return 'SUCCESS';
	} catch (err) {
		console.log(err);
		return 'ERROR processing files';
	}
}
