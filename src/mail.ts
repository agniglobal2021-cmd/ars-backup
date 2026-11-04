import { arrayBufferToBase64, requestUrl } from "obsidian";
import { sleep } from "./util";

export interface Letter {
	from: string;
	to: string;
	subject: string;
	text: string;
	attachment: { name: string; data: Uint8Array };
	/** Resend drops a repeat with the same key for 24 hours, so a retry never sends twice. */
	idempotencyKey: string;
}

export class MailError extends Error {
	constructor(message: string, readonly retryable: boolean) {
		super(message);
	}
}

const ENDPOINT = "https://api.resend.com/emails";

export async function sendLetter(apiKey: string, letter: Letter): Promise<string> {
	const data = letter.attachment.data;
	const body = JSON.stringify({
		from: letter.from,
		to: [letter.to],
		subject: letter.subject,
		text: letter.text,
		attachments: [{
			filename: letter.attachment.name,
			content: arrayBufferToBase64(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer),
		}],
	});
	for (let attempt = 1; ; attempt++) {
		try {
			return await post(apiKey, body, letter.idempotencyKey);
		} catch (e) {
			if (!(e instanceof MailError) || !e.retryable || attempt >= 3) throw e;
			await sleep(attempt * 4000);
		}
	}
}

async function post(apiKey: string, body: string, idempotencyKey: string): Promise<string> {
	let res;
	try {
		res = await requestUrl({
			url: ENDPOINT,
			method: "POST",
			contentType: "application/json",
			headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": idempotencyKey },
			body,
			throw: false,
		});
	} catch {
		throw new MailError("нет связи с Resend. Проверь интернет.", true);
	}
	let json: { id?: string; message?: string } = {};
	try {
		json = res.json ?? {};
	} catch {
		// Not JSON: fall back to the status code below.
	}
	if (res.status >= 200 && res.status < 300 && json.id) return json.id;
	throw explain(res.status, json.message ?? "");
}

function explain(status: number, message: string): MailError {
	if (/own email address/i.test(message)) {
		return new MailError("Resend пишет только на адрес, с которым ты в нём зарегистрирован. Укажи его в настройках плагина.", false);
	}
	if (status === 401 || /api key/i.test(message)) {
		return new MailError("Resend не принял ключ API. Проверь его в настройках плагина.", false);
	}
	if (status === 429) return new MailError("Resend просит подождать: слишком много писем подряд.", true);
	if (status >= 500) return new MailError(`у Resend сбой (код ${status}).`, true);
	return new MailError(`Resend отклонил письмо (код ${status})${message ? `: ${message}` : ""}.`, false);
}
