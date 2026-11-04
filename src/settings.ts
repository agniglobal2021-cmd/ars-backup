export interface ArsBackupSettings {
	/** Address the archive goes to. Without a verified domain Resend only delivers to the account's own address. */
	email: string;
	/** Resend API key. Stays in this device's plugin data, never in notes. */
	resendKey: string;
	/** Sender shown in the mailbox. Change only after verifying an own domain in Resend. */
	from: string;
	/** Make backups automatically on this device. */
	auto: boolean;
	intervalDays: number;
	/** Note with the public key and the backup log. Synced like any other note. */
	logPath: string;
	/** Extensions that never go into the archive (books live elsewhere). */
	excludeExtensions: string;
	/** Folders that never go into the archive, one per line. */
	excludeFolders: string;
	/** Dot-folders that should be archived too (Obsidian itself hides them). */
	hiddenFolders: string;
	/** Archive Obsidian settings, without plugin code and without plugin secrets. */
	includeConfig: boolean;
	/** Files bigger than this are skipped and counted in the log. */
	maxFileMB: number;
	/** Last automatic or manual failure, shown in the settings. */
	lastError: string;
}

export const DEFAULT_SETTINGS: ArsBackupSettings = {
	email: "",
	resendKey: "",
	from: "ArsMemoria <onboarding@resend.dev>",
	auto: true,
	intervalDays: 14,
	logPath: "06 Other/Бэкапы.md",
	excludeExtensions: "epub, fb2, fbz, fb2.zip, mobi, azw, azw3, kfx, djvu, djv, cbz, cbr",
	excludeFolders: "",
	hiddenFolders: ".diary",
	includeConfig: true,
	maxFileMB: 25,
	lastError: "",
};

/**
 * Size of one attachment. Base64 with line breaks turns 15 MiB into about 21.5 MB on the wire,
 * well under Proton's 25 MB per message.
 */
export const PART_BYTES = 15 * 1024 * 1024;
