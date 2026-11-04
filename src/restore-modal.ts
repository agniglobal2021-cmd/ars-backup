import { Modal, type App } from "obsidian";
import { joinParts, openZip, type OpenedArchive, type PickedPart } from "./archive";
import { decrypt, KeyError } from "./crypto";
import { compareWithVault, restoreMissing, restoreToFolder, type Report } from "./restore";
import type { ArsBackupSettings } from "./settings";
import { buttonRow, keyArea, message, para, type ButtonSpec } from "./ui";
import { count, errorText, humanDate, humanSize, sleep } from "./util";

/**
 * «Восстановить из архива»: pick the attachment(s) from Files, enter the
 * secret key, then compare with the vault, bring back missing files, or
 * unpack a full copy into a separate folder. Existing files are never
 * overwritten.
 */
export class RestoreModal extends Modal {
	private picked: PickedPart[] = [];
	private archive: OpenedArchive | null = null;

	constructor(
		app: App,
		private readonly settings: ArsBackupSettings,
		private readonly selfId: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-backup-modal");
		this.showPick();
	}

	onClose(): void {
		this.picked = [];
		this.archive = null;
		this.contentEl.empty();
	}

	private showPick(): void {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText("Восстановить из архива");
		para(el, "Сначала сохрани вложение из письма: в Proton открой письмо, нажми на вложение, затем «Поделиться» → «Сохранить в Файлы». Если частей несколько, сохрани все.");
		para(el, this.picked.length
			? "Выбрано:"
			: "Потом нажми «Выбрать файлы» и выбери архив. Если частей несколько, выбери все: сразу или по одной.");
		if (this.picked.length) {
			const list = el.createEl("ul", { cls: "ars-backup-files" });
			for (const p of this.picked) list.createEl("li", { text: `${p.name} — ${humanSize(p.data.length)}` });
		}
		const say = message(el);
		const input = el.createEl("input", { attr: { type: "file", multiple: "" }, cls: "ars-backup-hidden" });
		input.addEventListener("change", async () => {
			const chosen = Array.from(input.files ?? []);
			if (chosen.length === 0) return;
			say("Читаю файлы…");
			try {
				const added = await Promise.all(chosen.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
				// Each pick adds to the list, so parts can be chosen one at a time; a repeated name replaces the old copy.
				const byName = new Map(this.picked.map((p) => [p.name, p]));
				for (const p of added) byName.set(p.name, p);
				this.picked = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
				this.showPick();
			} catch (e) {
				say(`Не получилось прочитать файлы: ${errorText(e)}`, "error");
			}
		});
		const buttons: ButtonSpec[] = [];
		if (this.picked.length) {
			buttons.push({ text: "Очистить", onClick: () => { this.picked = []; this.showPick(); } });
		}
		buttons.push(
			{ text: this.picked.length ? "Добавить ещё" : "Выбрать файлы", onClick: () => input.click() },
			{
				text: "Дальше",
				cta: true,
				disabled: this.picked.length === 0,
				onClick: () => {
					try {
						joinParts(this.picked);
						this.showKey();
					} catch (e) {
						say(errorText(e), "error");
					}
				},
			},
		);
		buttonRow(el, buttons);
	}

	private showKey(): void {
		const el = this.contentEl;
		el.empty();
		para(el, "Вставь секретный ключ. Он нужен только сейчас и нигде не сохранится.");
		const area = keyArea(el);
		const say = message(el);
		buttonRow(el, [
			{ text: "Назад", onClick: () => this.showPick() },
			{
				text: "Открыть архив",
				cta: true,
				onClick: async () => {
					say("Расшифровываю…");
					await sleep(30);
					try {
						const zip = await decrypt(area.value, joinParts(this.picked));
						area.value = "";
						say("Распаковываю…");
						await sleep(30);
						this.archive = openZip(zip);
						this.picked = [];
						this.showChoice();
					} catch (e) {
						say(e instanceof KeyError ? e.message : `Не получилось открыть архив: ${errorText(e)}`, "error");
					}
				},
			},
		]);
		area.focus();
	}

	private showChoice(): void {
		const archive = this.archive;
		if (!archive) return;
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText("Архив открыт");
		const m = archive.manifest;
		const files = count(archive.files.size, "файл", "файла", "файлов");
		para(el, m ? `Бэкап от ${humanDate(new Date(m.created))}, ${m.device}: ${files}.` : `В архиве ${files}.`, "ars-backup-ok");
		if (archive.rejected.length) {
			para(el, `Пропущено записей с небезопасным путём: ${archive.rejected.length}.`, "ars-backup-warning");
		}
		const say = message(el);
		const choice = (title: string, desc: string, run: () => Promise<Report>) => {
			const box = el.createDiv({ cls: "ars-backup-choice" });
			box.createEl("p", { text: desc });
			buttonRow(box, [{
				text: title,
				onClick: async () => {
					try {
						this.showReport(await run());
					} catch (e) {
						say(`Ошибка: ${errorText(e)}`, "error");
					}
				},
			}]);
		};
		choice(
			"Сверить с хранилищем",
			"Ничего не меняет. Покажет, что совпадает с архивом, что изменилось и что удалено после бэкапа.",
			() => compareWithVault(this.app, archive, this.settings, this.selfId, say),
		);
		choice(
			"Вернуть недостающие",
			"Вернёт файлы, которых сейчас нет в хранилище. Существующие файлы не трогает.",
			() => restoreMissing(this.app, archive, say),
		);
		choice(
			"Копия в отдельную папку",
			"Распакует весь архив в новую папку. Она уйдёт и на другие устройства, после проверки её можно удалить.",
			() => restoreToFolder(this.app, archive, say),
		);
	}

	private showReport(report: Report): void {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText(report.title);
		const box = el.createDiv({ cls: "ars-backup-report" });
		for (const line of report.lines) box.createEl("p", { text: line });
		buttonRow(el, [
			{ text: "Назад к архиву", onClick: () => this.showChoice() },
			{ text: "Готово", cta: true, onClick: () => this.close() },
		]);
	}
}
