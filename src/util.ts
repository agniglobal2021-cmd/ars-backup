import { Platform } from "obsidian";

export const MB = 1024 * 1024;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = [
	"января", "февраля", "марта", "апреля", "мая", "июня",
	"июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "2026-11-05 14:30" — the format used in the backup log table. */
export function stamp(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "2026-11-05-1430" — safe inside file names. */
export function fileStamp(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** "5 ноября 2026, 14:30" */
export function humanDate(d: Date): string {
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function parseStamp(s: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
	return Number.isNaN(t) ? null : t;
}

export function humanSize(bytes: number): string {
	const fmt = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x))).replace(".", ",");
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < MB) return `${fmt(bytes / 1024)} КБ`;
	if (bytes < 1024 * MB) return `${fmt(bytes / MB)} МБ`;
	return `${fmt(bytes / (1024 * MB))} ГБ`;
}

/** Russian plural: plural(5, "файл", "файла", "файлов") → "файлов". */
export function plural(n: number, one: string, few: string, many: string): string {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
	return many;
}

export function count(n: number, one: string, few: string, many: string): string {
	return `${n} ${plural(n, one, few, many)}`;
}

export function deviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android-планшет" : "Android";
	if (Platform.isMacOS) return "Mac";
	return "компьютер";
}

/** Splits a settings field by commas, semicolons or new lines. */
export function splitList(s: string): string[] {
	return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

/** Keeps only characters that are safe in an attachment file name. */
export function asciiName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "vault";
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** True when the path or one of its folders starts with a dot. */
export function isHiddenPath(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
