import { Modal, Notice, type App } from "obsidian";
import { createKeys, groupIdentity, normalizeIdentity, recipientOf, KeyError } from "./crypto";
import type { BackupLog } from "./log";
import { buttonRow, keyArea, message, para } from "./ui";
import { errorText } from "./util";

/**
 * Creates a key pair on the device. The secret key is shown once, checked by
 * pasting it back from the password manager, and then forgotten. Only after
 * that check does the public key go into the note, so no archive is ever
 * locked with a key nobody kept.
 */
export class KeysModal extends Modal {
	private identity = "";
	private recipient = "";

	constructor(
		app: App,
		private readonly log: BackupLog,
		private readonly replacing: boolean,
		private readonly onDone: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-backup-modal");
		this.titleEl.setText(this.replacing ? "Новые ключи" : "Ключи для бэкапа");
		this.showIntro();
	}

	onClose(): void {
		this.identity = "";
		this.recipient = "";
		this.contentEl.empty();
	}

	private showIntro(): void {
		const el = this.contentEl;
		el.empty();
		para(el, "Открытый ключ запирает архивы. Он ляжет в заметку «Бэкапы» и сам доедет до других устройств.");
		para(el, "Секретный ключ открывает архивы. Плагин покажет его один раз и нигде не сохранит. Потеряешь его — архивы не откроет никто, включая тебя.");
		if (this.replacing) {
			para(el, "Архивы, которые уже лежат в почте, по-прежнему открываются только старым ключом. Не выбрасывай его, пока хранишь эти письма.", "ars-backup-warning");
		}
		const say = message(el);
		buttonRow(el, [
			{ text: "Отмена", onClick: () => this.close() },
			{
				text: "Создать ключи",
				cta: true,
				onClick: async () => {
					try {
						const keys = await createKeys();
						this.identity = keys.identity;
						this.recipient = keys.recipient;
						this.showSecret();
					} catch (e) {
						say(`Не получилось создать ключи: ${errorText(e)}`, "error");
					}
				},
			},
		]);
	}

	private showSecret(): void {
		const el = this.contentEl;
		el.empty();
		para(el, "Это секретный ключ. Сохрани его в менеджер паролей и перепиши на бумагу. Пробелы и переносы здесь только для удобства, при вводе они не нужны.");
		el.createEl("pre", { cls: "ars-backup-key", text: groupIdentity(this.identity) });
		buttonRow(el, [
			{
				text: "Скопировать",
				onClick: async () => {
					try {
						await navigator.clipboard.writeText(this.identity);
						new Notice("Ключ скопирован");
					} catch {
						new Notice("Не получилось скопировать. Выдели ключ и скопируй вручную.");
					}
				},
			},
			{ text: "Я сохранил ключ", cta: true, onClick: () => this.showVerify() },
		]);
	}

	private showVerify(): void {
		const el = this.contentEl;
		el.empty();
		para(el, "Теперь вставь ключ из менеджера паролей. Так проверим, что он сохранился целиком.");
		const area = keyArea(el);
		const say = message(el);
		buttonRow(el, [
			{ text: "Назад", onClick: () => this.showSecret() },
			{
				text: "Проверить",
				cta: true,
				onClick: async () => {
					const typed = normalizeIdentity(area.value);
					if (typed !== this.identity) {
						try {
							await recipientOf(area.value);
							say("Это другой ключ. Вернись назад и скопируй его ещё раз.", "error");
						} catch (e) {
							say(e instanceof KeyError ? e.message : "Ключ не совпадает. Вернись назад и скопируй его ещё раз.", "error");
						}
						return;
					}
					try {
						await this.log.setRecipient(this.recipient);
					} catch (e) {
						say(`Не получилось записать открытый ключ в заметку: ${errorText(e)}`, "error");
						return;
					}
					try {
						await navigator.clipboard.writeText("");
					} catch {
						// Clearing the clipboard is a courtesy; some systems do not allow it here.
					}
					this.identity = "";
					this.showDone();
				},
			},
		]);
		area.focus();
	}

	private showDone(): void {
		const el = this.contentEl;
		el.empty();
		para(el, `Готово. Открытый ключ записан в заметку «${this.log.path}».`);
		para(el, "Секретный ключ плагин забыл. Он есть только у тебя — в менеджере паролей и на бумаге.");
		buttonRow(el, [{
			text: "Закрыть",
			cta: true,
			onClick: () => {
				this.close();
				this.onDone();
			},
		}]);
	}
}

/** Checks a secret key from the password manager or from paper against the public key in the note. */
export class CheckKeyModal extends Modal {
	constructor(app: App, private readonly log: BackupLog) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ars-backup-modal");
		this.titleEl.setText("Проверить секретный ключ");
		const el = this.contentEl;
		para(el, "Вставь или введи секретный ключ. Плагин сверит его с открытым ключом из заметки и нигде не сохранит.");
		const area = keyArea(el);
		const say = message(el);
		buttonRow(el, [
			{ text: "Закрыть", onClick: () => this.close() },
			{
				text: "Проверить",
				cta: true,
				onClick: async () => {
					const expected = await this.log.recipient();
					if (!expected) {
						say("В заметке нет открытого ключа. Сначала создай ключи в настройках плагина.", "error");
						return;
					}
					try {
						const got = await recipientOf(area.value);
						if (got === expected) say("Ключ подходит: он открывает архивы, которые плагин шифрует сейчас.", "ok");
						else say("Это другой ключ. Он не откроет архивы, запертые нынешним открытым ключом.", "error");
					} catch (e) {
						say(e instanceof KeyError ? e.message : errorText(e), "error");
					}
				},
			},
		]);
		area.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
