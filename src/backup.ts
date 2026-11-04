import type { App } from "obsidian";
import { makeZip, splitParts, type Manifest } from "./archive";
import { Collector } from "./collect";
import { encrypt } from "./crypto";
import { sendLetter } from "./mail";
import { PART_BYTES, type ArsBackupSettings } from "./settings";
import { asciiName, count, deviceName, fileStamp, humanDate, humanSize, mapLimit, sleep } from "./util";

export interface BackupResult {
	time: Date;
	device: string;
	files: number;
	skipped: number;
	size: number;
	parts: number;
}

export interface BackupJob {
	app: App;
	settings: ArsBackupSettings;
	selfId: string;
	recipient: string;
	progress: (message: string) => void;
}

/** Collects, zips, encrypts on the device and mails the archive. Nothing readable leaves the device. */
export async function runBackup(job: BackupJob): Promise<BackupResult> {
	const { app, settings, progress } = job;
	const time = new Date();
	const device = deviceName();
	const vault = app.vault.getName();

	progress("Бэкап: собираю заметки…");
	const collector = new Collector(app, settings, job.selfId);
	const { files, skipped } = await collector.collect();
	if (files.length === 0) throw new Error("в хранилище не нашлось ни одного файла.");

	const contents = await mapLimit(files, 8, (f) => collector.read(f));

	const manifest: Manifest = {
		app: "ars-backup",
		format: 1,
		created: time.getTime(),
		device,
		vault,
		files: files.map((f, i) => ({ p: f.path, s: contents[i].length, m: f.mtime, c: f.ctime })),
		skipped: skipped.map((s) => ({ p: s.path, s: s.size })),
	};

	progress(`Бэкап: сжимаю ${count(files.length, "файл", "файла", "файлов")}…`);
	await sleep(50); // let the notice repaint before the synchronous work
	const zip = makeZip(files.map((f, i) => ({ path: f.path, data: contents[i], mtime: f.mtime })), manifest);
	contents.length = 0;

	progress("Бэкап: шифрую…");
	const sealed = await encrypt(job.recipient, zip);

	const baseName = `${asciiName(vault)}-${fileStamp(time)}.zip.age`;
	const parts = splitParts(sealed, baseName, PART_BYTES);
	for (let i = 0; i < parts.length; i++) {
		progress(parts.length > 1 ? `Бэкап: отправляю письмо ${i + 1} из ${parts.length}…` : "Бэкап: отправляю письмо…");
		await sendLetter(settings.resendKey, {
			from: settings.from,
			to: settings.email,
			subject: `Бэкап ${vault} ${fileStamp(time).slice(0, 10)}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}`,
			text: letterText({ vault, time, device, files: files.length, size: sealed.length, part: i + 1, parts }),
			attachment: parts[i],
			// Unique per run, shared by retries of the same letter.
			idempotencyKey: `ars-backup-${baseName}-${time.getTime()}-${i + 1}`,
		});
		if (i < parts.length - 1) await sleep(1500);
	}

	return { time, device, files: files.length, skipped: skipped.length, size: sealed.length, parts: parts.length };
}

function letterText(o: {
	vault: string;
	time: Date;
	device: string;
	files: number;
	size: number;
	part: number;
	parts: { name: string }[];
}): string {
	const single = o.parts.length === 1;
	const whole = single ? o.parts[0].name : o.parts[0].name.replace(/\.\d{3}$/, "");
	const lines = [
		`Зашифрованный архив хранилища ${o.vault}.`,
		`Создан ${humanDate(o.time)}, ${o.device}. ${count(o.files, "файл", "файла", "файлов")}, ${humanSize(o.size)}.`,
	];
	if (!single) lines.push(`Это письмо ${o.part} из ${o.parts.length}. Для восстановления нужны все части.`);
	lines.push(
		"",
		"Как открыть:",
		"— в Obsidian: команда «Ars Backup: Восстановить из архива» и секретный ключ;",
		"— на компьютере: программа age (age-encryption.org):",
	);
	if (!single) lines.push(`  cat ${whole}.* > ${whole}`);
	lines.push(
		`  age -d -i ключ.txt ${whole} > архив.zip`,
		"",
		"Письмо отправил плагин Ars Backup. Заметки внутри архива зашифрованы, почтовые сервисы их не видят.",
	);
	return lines.join("\n");
}
