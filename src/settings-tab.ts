import { PluginSettingTab, Setting, type App } from "obsidian";
import { CheckKeyModal, KeysModal } from "./keys-modal";
import { BackupLog } from "./log";
import type ArsBackupPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";
import { DAY_MS, humanDate } from "./util";

export class ArsBackupSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ArsBackupPlugin) {
		super(app, plugin);
	}

	display(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const el = this.containerEl;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const log = this.plugin.log();
		const text = await log.text();
		const recipient = BackupLog.recipientIn(text);
		const last = BackupLog.lastIn(text);
		el.empty();
		el.addClass("ars-backup-settings");

		new Setting(el).setName("Ключ").setHeading();
		const key = new Setting(el)
			.setName(recipient ? "Ключи созданы" : "Ключей ещё нет")
			.setDesc(recipient
				? `Открытый ключ ${recipient.slice(0, 10)}…${recipient.slice(-6)} лежит в заметке «${log.path}». Секретный — только у тебя.`
				: "Открытый ключ запирает архивы, секретный открывает. Секретный плагин покажет один раз и не сохранит.");
		key.addButton((b) => {
			b.setButtonText(recipient ? "Заменить ключи" : "Создать ключи")
				.onClick(() => new KeysModal(this.app, log, Boolean(recipient), () => this.display()).open());
			if (!recipient) b.setCta();
		});
		if (recipient) {
			new Setting(el)
				.setName("Проверить секретный ключ")
				.setDesc("Сверить ключ из менеджера паролей или с бумаги с открытым ключом в заметке.")
				.addButton((b) => b.setButtonText("Проверить").onClick(() => new CheckKeyModal(this.app, log).open()));
		}

		new Setting(el).setName("Почта").setHeading();
		new Setting(el)
			.setName("Адрес")
			.setDesc("Твой адрес в Proton. Тот же, с которым ты зарегистрирован в Resend: без своего домена Resend пишет только на него.")
			.addText((t) => {
				t.inputEl.type = "email";
				t.inputEl.setAttr("autocapitalize", "off");
				t.setPlaceholder("name@proton.me").setValue(s.email).onChange(async (v) => {
					s.email = v.trim();
					await save();
				});
			});
		new Setting(el)
			.setName("Ключ Resend")
			.setDesc("API-ключ из Resend, раздел API Keys. Хранится только на этом устройстве и в заметки не попадает.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.setAttr("autocomplete", "off");
				t.setPlaceholder("re_…").setValue(s.resendKey).onChange(async (v) => {
					s.resendKey = v.trim();
					await save();
				});
			});
		new Setting(el)
			.setName("Отправитель")
			.setDesc("Менять, только если подключишь в Resend свой домен.")
			.addText((t) => t.setValue(s.from).onChange(async (v) => {
				s.from = v.trim() || DEFAULT_SETTINGS.from;
				await save();
			}));

		const lastText = last
			? `Последний: ${humanDate(new Date(last.time))}, ${last.device}.${s.auto ? ` Следующий — ${nextText(last.time, s.intervalDays)}.` : ""}`
			: "Бэкапов ещё не было.";
		new Setting(el)
			.setName("Отправить бэкап сейчас")
			.setDesc(lastText)
			.addButton((b) => b.setButtonText("Отправить").setCta().onClick(async () => {
				b.setDisabled(true);
				await this.plugin.backup("manual");
				this.display();
			}));
		if (s.lastError) {
			new Setting(el)
				.setName("Последняя ошибка")
				.setDesc(s.lastError)
				.addButton((b) => b.setButtonText("Скрыть").onClick(async () => {
					s.lastError = "";
					await save();
					this.display();
				}));
		}

		new Setting(el).setName("Расписание").setHeading();
		new Setting(el)
			.setName("Делать бэкап сам")
			.setDesc("На этом устройстве, когда Obsidian открыт и срок подошёл. Если бэкап уже сделало другое устройство, это не повторит.")
			.addToggle((t) => t.setValue(s.auto).onChange(async (v) => {
				s.auto = v;
				await save();
			}));
		new Setting(el)
			.setName("Раз в сколько дней")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.inputEl.max = "90";
				t.setValue(String(s.intervalDays)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n >= 1 && n <= 90) {
						s.intervalDays = n;
						await save();
					}
				});
			});

		new Setting(el).setName("Архив").setHeading();
		new Setting(el)
			.setName("Настройки Obsidian")
			.setDesc("Темы, горячие клавиши и настройки плагинов. Без кода плагинов и без настроек LiveSync и BRAT, где лежат пароли.")
			.addToggle((t) => t.setValue(s.includeConfig).onChange(async (v) => {
				s.includeConfig = v;
				await save();
			}));
		new Setting(el)
			.setName("Скрытые папки")
			.setDesc("Папки с точкой в начале, которые тоже нужно сохранять. По одной на строку.")
			.addTextArea((t) => t.setValue(s.hiddenFolders).onChange(async (v) => {
				s.hiddenFolders = v;
				await save();
			}));
		new Setting(el)
			.setName("Не включать расширения")
			.setDesc("Файлы книг. Через запятую.")
			.addTextArea((t) => t.setValue(s.excludeExtensions).onChange(async (v) => {
				s.excludeExtensions = v;
				await save();
			}));
		new Setting(el)
			.setName("Не включать папки")
			.setDesc("По одной на строку, путь от корня хранилища.")
			.addTextArea((t) => t.setPlaceholder("Библиотека").setValue(s.excludeFolders).onChange(async (v) => {
				s.excludeFolders = v;
				await save();
			}));
		new Setting(el)
			.setName("Пропускать файлы больше, МБ")
			.setDesc("Пропущенные файлы считаются в журнале.")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(String(s.maxFileMB)).onChange(async (v) => {
					const n = Number.parseFloat(v.replace(",", "."));
					if (Number.isFinite(n) && n > 0) {
						s.maxFileMB = n;
						await save();
					}
				});
			});
		new Setting(el)
			.setName("Заметка с ключом и журналом")
			.setDesc("Путь от корня хранилища.")
			.addText((t) => t.setValue(s.logPath).onChange(async (v) => {
				s.logPath = v.trim() || DEFAULT_SETTINGS.logPath;
				await save();
			}));
	}
}

function nextText(lastTime: number, days: number): string {
	const next = lastTime + days * DAY_MS;
	if (next <= Date.now()) return "при следующем открытии Obsidian";
	return humanDate(new Date(next)).replace(/, \d{2}:\d{2}$/, "");
}
