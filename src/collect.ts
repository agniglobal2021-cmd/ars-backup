import { normalizePath, TFile, type App, type DataAdapter } from "obsidian";
import type { ArsBackupSettings } from "./settings";
import { MB, splitList } from "./util";

export interface SourceFile {
	path: string;
	size: number;
	mtime: number;
	ctime: number;
	/** Inside a dot-folder: read through the adapter, invisible to the Vault API. */
	hidden: boolean;
}

export interface Collection {
	files: SourceFile[];
	skipped: { path: string; size: number }[];
}

/** Plugins whose settings hold passwords or tokens. Their data.json never leaves the device. */
const SECRET_PLUGINS = ["obsidian-livesync", "obsidian42-brat"];

/**
 * Decides what goes into the archive. The same rules are used to compare an
 * archive with the vault, so "new since the backup" means the same thing.
 */
export class Collector {
	private readonly extensions: string[];
	private readonly folders: string[];

	constructor(
		private readonly app: App,
		private readonly settings: ArsBackupSettings,
		private readonly selfId: string,
	) {
		this.extensions = splitList(settings.excludeExtensions).map((e) => e.replace(/^\./, "").toLowerCase());
		this.folders = splitList(settings.excludeFolders).map((f) => normalizePath(f));
	}

	isExcluded(path: string): boolean {
		const lower = path.toLowerCase();
		if (this.extensions.some((ext) => lower.endsWith(`.${ext}`))) return true;
		if (this.folders.some((f) => path === f || path.startsWith(`${f}/`))) return true;
		const config = this.app.vault.configDir;
		if (path === config || path.startsWith(`${config}/`)) return !this.configAllowed(path.slice(config.length + 1));
		return false;
	}

	/** Obsidian settings without plugin code (reinstallable) and without plugin secrets. */
	private configAllowed(rel: string): boolean {
		if (!this.settings.includeConfig) return false;
		if (rel === "workspace.json" || rel === "workspace-mobile.json") return false;
		const m = /^plugins\/([^/]+)\/(.+)$/.exec(rel);
		if (m) {
			const [, id, file] = m;
			if (file === "main.js" || file === "styles.css") return false;
			if (file === "data.json" && (SECRET_PLUGINS.includes(id) || id === this.selfId)) return false;
		}
		return true;
	}

	async collect(): Promise<Collection> {
		const maxBytes = this.settings.maxFileMB * MB;
		const files: SourceFile[] = [];
		const skipped: Collection["skipped"] = [];
		const add = (f: SourceFile) => {
			if (this.isExcluded(f.path)) return;
			if (f.size > maxBytes) skipped.push({ path: f.path, size: f.size });
			else files.push(f);
		};

		for (const file of this.app.vault.getFiles()) {
			add({ path: file.path, size: file.stat.size, mtime: file.stat.mtime, ctime: file.stat.ctime, hidden: false });
		}

		const adapter = this.app.vault.adapter;
		const roots = new Set<string>();
		if (this.settings.includeConfig) roots.add(this.app.vault.configDir);
		for (const folder of splitList(this.settings.hiddenFolders)) roots.add(normalizePath(folder));
		const seen = new Set(files.map((f) => f.path));
		for (const root of roots) {
			if (!(await adapter.exists(root))) continue;
			for (const path of await listRecursive(adapter, root)) {
				if (seen.has(path)) continue;
				seen.add(path);
				const stat = await adapter.stat(path);
				if (!stat || stat.type !== "file") continue;
				add({ path, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, hidden: true });
			}
		}

		files.sort((a, b) => a.path.localeCompare(b.path));
		return { files, skipped };
	}

	async read(f: SourceFile): Promise<Uint8Array> {
		if (!f.hidden) {
			const file = this.app.vault.getFileByPath(f.path);
			if (file instanceof TFile) return new Uint8Array(await this.app.vault.readBinary(file));
		}
		return new Uint8Array(await this.app.vault.adapter.readBinary(f.path));
	}
}

async function listRecursive(adapter: DataAdapter, dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (d: string) => {
		const { files, folders } = await adapter.list(d);
		out.push(...files);
		for (const sub of folders) await walk(sub);
	};
	await walk(dir);
	return out;
}
