import type { App, DataWriteOptions } from "obsidian";
import type { ManifestEntry, OpenedArchive } from "./archive";
import { Collector } from "./collect";
import type { ArsBackupSettings } from "./settings";
import { bytesEqual, count, fileStamp, isHiddenPath, parentOf } from "./util";

export interface Report {
	title: string;
	lines: string[];
}

type Progress = (text: string) => void;

/** Reads only. Same rules as the backup, so «new since the backup» is meaningful. */
export async function compareWithVault(
	app: App,
	archive: OpenedArchive,
	settings: ArsBackupSettings,
	selfId: string,
	progress: Progress,
): Promise<Report> {
	const adapter = app.vault.adapter;
	let same = 0;
	const changed: string[] = [];
	const missing: string[] = [];
	let done = 0;
	for (const [path, data] of archive.files) {
		if (++done % 50 === 0) progress(`Сверяю: ${done} из ${archive.files.size}…`);
		if (!(await adapter.exists(path))) {
			missing.push(path);
			continue;
		}
		const current = new Uint8Array(await adapter.readBinary(path));
		if (bytesEqual(current, data)) same++;
		else changed.push(path);
	}
	const now = await new Collector(app, settings, selfId).collect();
	const added = now.files.filter((f) => !archive.files.has(f.path)).map((f) => f.path);
	return {
		title: "Сверка",
		lines: [
			"Архив открылся, все файлы читаются.",
			`Совпадают с хранилищем: ${same}.`,
			...section("Изменены после бэкапа", changed),
			...section("Удалены из хранилища после бэкапа", missing),
			...section("Появились после бэкапа", added),
		],
	};
}

/** Brings back files that are gone. Anything that exists stays exactly as it is. */
export async function restoreMissing(app: App, archive: OpenedArchive, progress: Progress): Promise<Report> {
	const adapter = app.vault.adapter;
	const todo: [string, Uint8Array][] = [];
	for (const [path, data] of archive.files) if (!(await adapter.exists(path))) todo.push([path, data]);
	const { written, failed } = await writeAll(app, archive, todo, (p) => p, progress);
	return {
		title: "Возврат файлов",
		lines: [
			`Вернул: ${written.length}.`,
			`Уже были в хранилище и остались как есть: ${archive.files.size - todo.length}.`,
			...section("Не получилось записать", failed),
		],
	};
}

/** Unpacks the whole archive into a new folder next to everything else. */
export async function restoreToFolder(app: App, archive: OpenedArchive, progress: Progress): Promise<Report> {
	const created = archive.manifest ? new Date(archive.manifest.created) : new Date();
	const base = `Восстановлено ${fileStamp(created)}`;
	let folder = base;
	for (let i = 2; await app.vault.adapter.exists(folder); i++) folder = `${base} (${i})`;
	const { written, failed } = await writeAll(app, archive, [...archive.files], (p) => `${folder}/${p}`, progress);
	return {
		title: "Копия в папке",
		lines: [
			`Распаковал ${count(written.length, "файл", "файла", "файлов")} в папку «${folder}».`,
			"Настройки Obsidian лежат там в скрытой папке, Obsidian её не показывает.",
			...section("Не получилось записать", failed),
		],
	};
}

async function writeAll(
	app: App,
	archive: OpenedArchive,
	items: [string, Uint8Array][],
	target: (path: string) => string,
	progress: Progress,
): Promise<{ written: string[]; failed: string[] }> {
	const times = new Map<string, ManifestEntry>((archive.manifest?.files ?? []).map((f) => [f.p, f]));
	const written: string[] = [];
	const failed: string[] = [];
	for (const [path, data] of items) {
		const done = written.length + failed.length;
		if (done % 25 === 0) progress(`Записываю: ${done} из ${items.length}…`);
		const to = target(path);
		const t = times.get(path);
		const options: DataWriteOptions = t ? { mtime: t.m, ctime: t.c } : {};
		try {
			await writeOne(app, to, data, options);
			written.push(to);
		} catch {
			failed.push(to);
		}
	}
	return { written, failed };
}

async function writeOne(app: App, path: string, data: Uint8Array, options: DataWriteOptions): Promise<void> {
	const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	if (isHiddenPath(path)) {
		await ensureAdapterFolder(app, parentOf(path));
		await app.vault.adapter.writeBinary(path, buffer, options);
	} else {
		await ensureVaultFolder(app, parentOf(path));
		await app.vault.createBinary(path, buffer, options);
	}
}

async function ensureVaultFolder(app: App, path: string): Promise<void> {
	if (!path || app.vault.getFolderByPath(path)) return;
	await ensureVaultFolder(app, parentOf(path));
	if (!app.vault.getFolderByPath(path)) await app.vault.createFolder(path);
}

async function ensureAdapterFolder(app: App, path: string): Promise<void> {
	if (!path || (await app.vault.adapter.exists(path))) return;
	await ensureAdapterFolder(app, parentOf(path));
	await app.vault.adapter.mkdir(path);
}

/** "Title: N." plus up to five example paths. */
function section(title: string, paths: string[]): string[] {
	if (paths.length === 0) return [`${title}: 0.`];
	const shown = paths.slice(0, 5).map((p) => `  ${p}`);
	const more = paths.length > 5 ? [`  …и ещё ${paths.length - 5}`] : [];
	return [`${title}: ${paths.length}.`, ...shown, ...more];
}
