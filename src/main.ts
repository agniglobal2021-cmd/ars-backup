import { Notice, Plugin } from "obsidian";
import { runBackup } from "./backup";
import { CheckKeyModal } from "./keys-modal";
import { BackupLog } from "./log";
import { RestoreModal } from "./restore-modal";
import { DEFAULT_SETTINGS, type ArsBackupSettings } from "./settings";
import { ArsBackupSettingTab } from "./settings-tab";
import { count, DAY_MS, errorText, humanSize } from "./util";

/** First automatic check: after LiveSync has had time to bring in the log from other devices. */
const FIRST_CHECK_MS = 90 * 1000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** After a failed automatic attempt, wait before trying again. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

export default class ArsBackupPlugin extends Plugin {
	settings: ArsBackupSettings = { ...DEFAULT_SETTINGS };
	private running = false;
	private lastAutoAttempt = 0;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ArsBackupSettingTab(this.app, this));

		this.addCommand({ id: "backup-now", name: "Отправить бэкап сейчас", callback: () => void this.backup("manual") });
		this.addCommand({
			id: "restore",
			name: "Восстановить из архива",
			callback: () => new RestoreModal(this.app, this.settings, this.manifest.id).open(),
		});
		this.addCommand({
			id: "check-key",
			name: "Проверить секретный ключ",
			callback: () => new CheckKeyModal(this.app, this.log()).open(),
		});

		this.app.workspace.onLayoutReady(() => {
			const first = window.setTimeout(() => void this.autoCheck(), FIRST_CHECK_MS);
			this.register(() => window.clearTimeout(first));
			this.registerInterval(window.setInterval(() => void this.autoCheck(), CHECK_EVERY_MS));
		});
	}

	log(): BackupLog {
		return new BackupLog(this.app, this.settings.logPath);
	}

	/** What still has to be filled in before a backup can go out, or null. */
	async missingSetup(): Promise<string | null> {
		if (!(await this.log().recipient())) return "сначала создай ключи в настройках плагина.";
		if (!this.settings.email.includes("@")) return "укажи в настройках адрес почты.";
		if (!this.settings.resendKey) return "вставь в настройках ключ Resend.";
		return null;
	}

	private async autoCheck(): Promise<void> {
		if (!this.settings.auto || this.running || !navigator.onLine) return;
		if (Date.now() - this.lastAutoAttempt < RETRY_AFTER_MS) return;
		if (await this.missingSetup()) return;
		const last = await this.log().last();
		if (last && Date.now() - last.time < this.settings.intervalDays * DAY_MS) return;
		this.lastAutoAttempt = Date.now();
		await this.backup("auto");
	}

	async backup(trigger: "manual" | "auto"): Promise<boolean> {
		if (this.running) {
			new Notice("Бэкап уже идёт.");
			return false;
		}
		const missing = await this.missingSetup();
		if (missing) {
			new Notice(`Бэкап не отправлен: ${missing}`);
			return false;
		}
		const recipient = await this.log().recipient();
		if (!recipient) return false;

		this.running = true;
		const notice = new Notice(trigger === "auto" ? "Бэкап по расписанию…" : "Бэкап…", 0);
		try {
			const result = await runBackup({
				app: this.app,
				settings: this.settings,
				selfId: this.manifest.id,
				recipient,
				progress: (m) => notice.setMessage(m),
			});
			await this.log().addRow(result);
			this.settings.lastError = "";
			await this.saveSettings();
			const letters = result.parts > 1 ? `, ${count(result.parts, "письмо", "письма", "писем")}` : "";
			const skipped = result.skipped ? ` Пропущено больших файлов: ${result.skipped}.` : "";
			notice.setMessage(`Бэкап отправлен: ${count(result.files, "файл", "файла", "файлов")}, ${humanSize(result.size)}${letters}.${skipped}`);
			window.setTimeout(() => notice.hide(), 8000);
			return true;
		} catch (e) {
			const text = errorText(e);
			this.settings.lastError = `${new Date().toLocaleString("ru-RU")}: ${text}`;
			await this.saveSettings();
			notice.setMessage(`Бэкап не отправлен: ${text}`);
			window.setTimeout(() => notice.hide(), 15000);
			return false;
		} finally {
			this.running = false;
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ArsBackupSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
	}
}
