import { normalizePath, type App, type TFile } from "obsidian";
import { RECIPIENT_RE } from "./crypto";
import { humanDate, humanSize, parentOf, parseStamp, stamp } from "./util";

const KEY_HEADING = "## Открытый ключ";
const LOG_HEADING = "## Журнал";
const TABLE_HEAD = "| Дата | Устройство | Файлов | Размер | Писем |\n| --- | --- | --- | --- | --- |";
const ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\|\s*([^|]*?)\s*\|/gm;

const INTRO = [
	"Плагин Ars Backup регулярно собирает заметки в архив, шифрует его открытым ключом ниже и отправляет на почту. Открыть архив можно только секретным ключом: он хранится в менеджере паролей и на бумаге.",
	"",
	"Без плагина архив открывает программа age на любом компьютере: `age -d -i ключ.txt архив.zip.age > архив.zip`, где в файле ключ.txt одна строка — секретный ключ.",
].join("\n");

export interface LogRow {
	time: Date;
	device: string;
	files: number;
	skipped: number;
	size: number;
	parts: number;
}

export interface LastBackup {
	time: number;
	device: string;
}

const keyBlock = (recipient: string) => `${KEY_HEADING}\n\n\`\`\`\n${recipient}\n\`\`\`\n`;

/**
 * The note «Бэкапы»: the public key and a table of sent archives, newest first.
 * It is an ordinary note, so it syncs to every device and reads without the plugin.
 */
export class BackupLog {
	readonly path: string;

	constructor(private readonly app: App, path: string) {
		this.path = normalizePath(path || "Бэкапы.md");
	}

	private file(): TFile | null {
		return this.app.vault.getFileByPath(this.path);
	}

	async text(): Promise<string | null> {
		const f = this.file();
		return f ? this.app.vault.read(f) : null;
	}

	static recipientIn(text: string | null): string | null {
		return text ? (RECIPIENT_RE.exec(text)?.[0] ?? null) : null;
	}

	static lastIn(text: string | null): LastBackup | null {
		if (!text) return null;
		let best: LastBackup | null = null;
		for (const m of text.matchAll(ROW_RE)) {
			const time = parseStamp(m[1]);
			if (time !== null && (!best || time > best.time)) best = { time, device: m[2] };
		}
		return best;
	}

	async recipient(): Promise<string | null> {
		return BackupLog.recipientIn(await this.text());
	}

	async last(): Promise<LastBackup | null> {
		return BackupLog.lastIn(await this.text());
	}

	async setRecipient(recipient: string): Promise<void> {
		const f = this.file();
		if (!f) {
			await this.ensureFolder(parentOf(this.path));
			await this.app.vault.create(this.path, `${INTRO}\n\n${keyBlock(recipient)}\n${LOG_HEADING}\n\n${TABLE_HEAD}\n`);
			return;
		}
		await this.app.vault.process(f, (t) => {
			const old = RECIPIENT_RE.exec(t);
			if (old) {
				if (old[0] === recipient) return t;
				const replaced = t.slice(0, old.index) + recipient + t.slice(old.index + old[0].length);
				const note = `Ключ заменён ${humanDate(new Date())}. Архивы до этой даты открываются прежним ключом.`;
				const fence = replaced.indexOf("```", old.index + recipient.length);
				if (fence < 0) return `${replaced.trimEnd()}\n\n${note}\n`;
				const at = fence + 3;
				return `${replaced.slice(0, at)}\n\n${note}${replaced.slice(at)}`;
			}
			const i = t.indexOf(LOG_HEADING);
			return i >= 0 ? `${t.slice(0, i)}${keyBlock(recipient)}\n${t.slice(i)}` : `${t.trimEnd()}\n\n${keyBlock(recipient)}`;
		});
	}

	async addRow(row: LogRow): Promise<void> {
		const files = row.skipped ? `${row.files} (пропущено ${row.skipped})` : String(row.files);
		const line = `| ${stamp(row.time)} | ${row.device} | ${files} | ${humanSize(row.size)} | ${row.parts} |`;
		const f = this.file();
		if (!f) {
			await this.ensureFolder(parentOf(this.path));
			await this.app.vault.create(this.path, `${INTRO}\n\n${LOG_HEADING}\n\n${TABLE_HEAD}\n${line}\n`);
			return;
		}
		await this.app.vault.process(f, (t) => {
			const head = t.indexOf(TABLE_HEAD);
			if (head >= 0) {
				const at = head + TABLE_HEAD.length;
				return `${t.slice(0, at)}\n${line}${t.slice(at)}`;
			}
			return `${t.trimEnd()}\n\n${LOG_HEADING}\n\n${TABLE_HEAD}\n${line}\n`;
		});
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!path || this.app.vault.getFolderByPath(path)) return;
		await this.ensureFolder(parentOf(path));
		if (!this.app.vault.getFolderByPath(path)) await this.app.vault.createFolder(path);
	}
}
