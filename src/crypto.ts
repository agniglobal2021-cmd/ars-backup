import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";

/** Public key: classic `age1…` or post-quantum `age1pq1…` (bech32, lowercase). */
export const RECIPIENT_RE = /age1(?:pq1)?[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{50,}/;

const IDENTITY_RE = /^AGE-SECRET-KEY-(?:PQ-)?1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]+$/;

/** Cyrillic letters that look like Latin ones, for keys typed from paper on a Russian keyboard. */
const LOOKALIKES: Record<string, string> = {
	А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y",
	а: "A", в: "B", е: "E", к: "K", м: "M", н: "H", о: "O", р: "P", с: "C", т: "T", х: "X", у: "Y",
};

/** Accepts the key with spaces, line breaks, any case and lookalike Cyrillic letters. */
export function normalizeIdentity(input: string): string {
	return input
		.replace(/[\s ​]+/g, "")
		.replace(/[А-Яа-яЁё]/g, (ch) => LOOKALIKES[ch] ?? ch)
		.replace(/[‐-―−]/g, "-")
		.toUpperCase();
}

export function looksLikeIdentity(normalized: string): boolean {
	return IDENTITY_RE.test(normalized);
}

/** Splits the secret key into short groups that are easy to copy by hand. */
export function groupIdentity(identity: string): string {
	const m = /^(AGE-SECRET-KEY-(?:PQ-)?1)(.+)$/.exec(identity);
	if (!m) return identity;
	const groups = m[2].match(/.{1,5}/g) ?? [];
	const lines: string[] = [m[1]];
	for (let i = 0; i < groups.length; i += 4) lines.push(groups.slice(i, i + 4).join(" "));
	return lines.join("\n");
}

export async function createKeys(): Promise<{ identity: string; recipient: string }> {
	const identity = await generateHybridIdentity();
	return { identity, recipient: await identityToRecipient(identity) };
}

export class KeyError extends Error {}

/** Derives the public key from a secret key, with a readable error for typos. */
export async function recipientOf(identityInput: string): Promise<string> {
	const identity = normalizeIdentity(identityInput);
	if (!looksLikeIdentity(identity)) {
		throw new KeyError("Это не похоже на секретный ключ: он начинается с AGE-SECRET-KEY-.");
	}
	try {
		return await identityToRecipient(identity);
	} catch {
		// The library's own message contains the key itself, so it is never shown.
		throw new KeyError("В ключе опечатка: не сходится контрольная сумма. Проверь символы.");
	}
}

export async function encrypt(recipient: string, data: Uint8Array): Promise<Uint8Array> {
	const e = new Encrypter();
	e.addRecipient(recipient);
	return e.encrypt(data);
}

export async function decrypt(identityInput: string, data: Uint8Array): Promise<Uint8Array> {
	await recipientOf(identityInput); // validates the key and gives a clean error
	const d = new Decrypter();
	d.addIdentity(normalizeIdentity(identityInput));
	try {
		return await d.decrypt(data);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		if (/no identity matched/i.test(msg)) {
			throw new KeyError("Этот ключ не открывает архив. Возможно, архив сделан до замены ключей.");
		}
		throw new KeyError("Архив повреждён или выбраны не все его части.");
	}
}
