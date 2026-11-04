// In-memory vault that behaves like Obsidian's Vault + DataAdapter for the calls the plugin makes.
import { TFile, TFolder } from "obsidian";

interface Entry {
	data: Uint8Array;
	mtime: number;
	ctime: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const parent = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const hidden = (p: string) => p.split("/").some((s) => s.startsWith("."));
const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export class FakeVault {
	configDir = ".obsidian";
	files = new Map<string, Entry>();
	folders = new Set<string>();
	adapter: FakeAdapter;

	constructor(private name = "ArsMemoria") {
		this.adapter = new FakeAdapter(this);
	}

	put(path: string, content: string | Uint8Array, mtime = Date.UTC(2026, 9, 1, 12)): void {
		const data = typeof content === "string" ? enc.encode(content) : content;
		this.files.set(path, { data, mtime, ctime: mtime - 1000 });
		for (let p = parent(path); p; p = parent(p)) this.folders.add(p);
	}

	text(path: string): string | undefined {
		const e = this.files.get(path);
		return e ? dec.decode(e.data) : undefined;
	}

	getName(): string {
		return this.name;
	}

	private tfile(path: string): TFile {
		const e = this.files.get(path)!;
		const f = new TFile(path);
		f.stat = { size: e.data.length, mtime: e.mtime, ctime: e.ctime };
		return f;
	}

	getFiles(): TFile[] {
		return [...this.files.keys()].filter((p) => !hidden(p)).map((p) => this.tfile(p));
	}

	getFileByPath(path: string): TFile | null {
		return this.files.has(path) && !hidden(path) ? this.tfile(path) : null;
	}

	getFolderByPath(path: string): TFolder | null {
		return this.folders.has(path) && !hidden(path) ? new TFolder(path) : null;
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		return toBuf(this.files.get(file.path)!.data);
	}

	async read(file: TFile): Promise<string> {
		return this.text(file.path)!;
	}

	async create(path: string, text: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
		if (parent(path) && !this.folders.has(parent(path))) throw new Error(`No folder for ${path}`);
		this.put(path, text, Date.now());
		return this.tfile(path);
	}

	async createBinary(path: string, data: ArrayBuffer, options?: { mtime?: number; ctime?: number }): Promise<TFile> {
		if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
		if (parent(path) && !this.folders.has(parent(path))) throw new Error(`No folder for ${path}`);
		this.put(path, new Uint8Array(data), options?.mtime ?? Date.now());
		return this.tfile(path);
	}

	async createFolder(path: string): Promise<void> {
		if (this.folders.has(path)) throw new Error(`Folder already exists: ${path}`);
		if (parent(path) && !this.folders.has(parent(path))) throw new Error(`No parent for ${path}`);
		this.folders.add(path);
	}

	async process(file: TFile, fn: (t: string) => string): Promise<string> {
		const next = fn(this.text(file.path)!);
		const e = this.files.get(file.path)!;
		this.files.set(file.path, { ...e, data: enc.encode(next), mtime: Date.now() });
		return next;
	}
}

class FakeAdapter {
	constructor(private v: FakeVault) {}

	async exists(path: string): Promise<boolean> {
		return this.v.files.has(path) || this.v.folders.has(path);
	}

	async stat(path: string) {
		const e = this.v.files.get(path);
		if (e) return { type: "file", size: e.data.length, mtime: e.mtime, ctime: e.ctime };
		if (this.v.folders.has(path)) return { type: "folder", size: 0, mtime: 0, ctime: 0 };
		return null;
	}

	async list(dir: string) {
		const prefix = dir ? `${dir}/` : "";
		const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
		return {
			files: [...this.v.files.keys()].filter(direct),
			folders: [...this.v.folders].filter(direct),
		};
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const e = this.v.files.get(path);
		if (!e) throw new Error(`ENOENT ${path}`);
		return toBuf(e.data);
	}

	async writeBinary(path: string, data: ArrayBuffer, options?: { mtime?: number }): Promise<void> {
		if (parent(path) && !this.v.folders.has(parent(path))) throw new Error(`No folder for ${path}`);
		this.v.put(path, new Uint8Array(data), options?.mtime ?? Date.now());
	}

	async mkdir(path: string): Promise<void> {
		this.v.folders.add(path);
	}
}

export function fakeApp(vault: FakeVault) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { vault } as any;
}
