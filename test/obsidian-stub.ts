// Minimal stand-in for the "obsidian" module so the plugin's logic runs under Node.

export const Platform = {
	isIosApp: true,
	isAndroidApp: false,
	isTablet: true,
	isPhone: false,
	isMacOS: false,
	isMobile: true,
	isDesktopApp: false,
};

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").normalize("NFC");
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	return Buffer.from(buf).toString("base64");
}

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string;
	headers?: Record<string, string>;
	throw?: boolean;
}

type Handler = (req: RequestUrlParam) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>;
let handler: Handler = () => ({ status: 500, json: { message: "no handler" } });
export function __setRequestHandler(h: Handler): void {
	handler = h;
}

export async function requestUrl(req: RequestUrlParam) {
	const res = await handler(req);
	return { status: res.status, json: res.json, text: JSON.stringify(res.json ?? null) };
}

export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {
	stat = { size: 0, mtime: 0, ctime: 0 };
	get extension(): string {
		return this.name.includes(".") ? this.name.slice(this.name.lastIndexOf(".") + 1) : "";
	}
}

export class TFolder extends TAbstractFile {}

export class Notice {
	constructor(public message: string) {}
	setMessage(m: string) {
		this.message = m;
		return this;
	}
	hide() {}
}

export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class ButtonComponent {}
