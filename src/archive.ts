import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

/** Small file at the archive root: when and where it was made, sizes and dates of every file. */
export const MANIFEST_NAME = ".ars-backup.json";

export interface ManifestEntry {
	/** path */
	p: string;
	/** size in bytes */
	s: number;
	/** modified, ms */
	m: number;
	/** created, ms */
	c: number;
}

export interface Manifest {
	app: "ars-backup";
	format: 1;
	created: number;
	device: string;
	vault: string;
	files: ManifestEntry[];
	skipped: { p: string; s: number }[];
}

export interface ArchiveInput {
	path: string;
	data: Uint8Array;
	mtime: number;
}

/** Already-compressed formats are stored as is: deflating them again only costs battery. */
const STORED = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif",
	"mp3", "m4a", "aac", "ogg", "opus", "flac", "mp4", "mov", "m4v", "webm",
	"zip", "gz", "7z", "rar", "pdf", "epub", "docx", "xlsx", "pptx", "woff", "woff2",
]);

const extOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// ZIP stores dates from 1980 to 2107; fflate refuses anything outside 1980–2099.
const MIN_TIME = new Date(1980, 0, 2).getTime();
const MAX_TIME = new Date(2099, 11, 31).getTime();
const zipTime = (ms: number) => new Date(Math.min(Math.max(ms || MIN_TIME, MIN_TIME), MAX_TIME));

export function makeZip(files: ArchiveInput[], manifest: Manifest): Uint8Array {
	const tree: Zippable = {};
	for (const f of files) {
		tree[f.path] = [f.data, { level: STORED.has(extOf(f.path)) ? 0 : 6, mtime: zipTime(f.mtime) }];
	}
	tree[MANIFEST_NAME] = [strToU8(JSON.stringify(manifest)), { level: 6, mtime: zipTime(manifest.created) }];
	return zipSync(tree);
}

export interface OpenedArchive {
	files: Map<string, Uint8Array>;
	manifest: Manifest | null;
	/** Entries with unsafe paths (absolute or with ".."), never written anywhere. */
	rejected: string[];
}

export function openZip(data: Uint8Array): OpenedArchive {
	const raw = unzipSync(data);
	const files = new Map<string, Uint8Array>();
	const rejected: string[] = [];
	let manifest: Manifest | null = null;
	for (const [name, bytes] of Object.entries(raw)) {
		if (name.endsWith("/")) continue;
		if (name === MANIFEST_NAME) {
			try {
				const parsed = JSON.parse(strFromU8(bytes)) as Manifest;
				if (parsed.app === "ars-backup") manifest = parsed;
			} catch {
				// A broken manifest only costs file dates; the files themselves are fine.
			}
			continue;
		}
		const safe = safePath(name);
		if (safe) files.set(safe, bytes);
		else rejected.push(name);
	}
	return { files, manifest, rejected };
}

export function safePath(name: string): string | null {
	const n = name.replace(/\\/g, "/");
	if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
	const parts = n.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0 || parts.some((p) => p === "..")) return null;
	return parts.join("/");
}

/** Cuts the encrypted archive into attachments; parts are glued back in name order. */
export function splitParts(data: Uint8Array, baseName: string, partBytes: number): { name: string; data: Uint8Array }[] {
	if (data.length <= partBytes) return [{ name: baseName, data }];
	const parts: { name: string; data: Uint8Array }[] = [];
	for (let offset = 0, i = 1; offset < data.length; offset += partBytes, i++) {
		parts.push({ name: `${baseName}.${String(i).padStart(3, "0")}`, data: data.subarray(offset, offset + partBytes) });
	}
	return parts;
}

export interface PickedPart {
	name: string;
	data: Uint8Array;
}

/**
 * Orders the chosen files into one encrypted archive. Accepts a single
 * `….zip.age` file or a full set of `….zip.age.001`, `.002`, ….
 */
export function joinParts(picked: PickedPart[]): Uint8Array {
	if (picked.length === 0) throw new Error("Не выбрано ни одного файла.");
	const numbered = picked.map((p) => {
		const m = /^(.*)\.(\d{3})$/.exec(p.name);
		return { ...p, base: m ? m[1] : p.name, index: m ? Number(m[2]) : 0 };
	});
	if (numbered.length === 1 && numbered[0].index === 0) return numbered[0].data;
	const bases = new Set(numbered.map((p) => p.base));
	if (bases.size > 1) throw new Error("Выбраны части от разных архивов. Выбери части одного бэкапа.");
	if (numbered.some((p) => p.index === 0)) throw new Error("Выбери либо один файл архива, либо все его части.");
	numbered.sort((a, b) => a.index - b.index);
	const max = numbered[numbered.length - 1].index;
	const missing: number[] = [];
	for (let i = 1; i <= max; i++) if (!numbered.some((p) => p.index === i)) missing.push(i);
	if (missing.length) throw new Error(`Не хватает частей: ${missing.join(", ")}.`);
	if (new Set(numbered.map((p) => p.index)).size !== numbered.length) throw new Error("Одна и та же часть выбрана дважды.");
	const total = numbered.reduce((n, p) => n + p.data.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of numbered) {
		out.set(p.data, offset);
		offset += p.data.length;
	}
	return out;
}
