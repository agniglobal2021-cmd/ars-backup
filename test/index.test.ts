// Runs the plugin's real logic against an in-memory vault. Started by test/run.mjs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setRequestHandler, type RequestUrlParam } from "obsidian";
import { joinParts, openZip } from "../src/archive";
import { runBackup } from "../src/backup";
import { Collector } from "../src/collect";
import { createKeys, decrypt, groupIdentity, KeyError, normalizeIdentity, recipientOf } from "../src/crypto";
import { BackupLog } from "../src/log";
import { MailError, sendLetter } from "../src/mail";
import { compareWithVault, restoreMissing, restoreToFolder } from "../src/restore";
import { DEFAULT_SETTINGS, PART_BYTES } from "../src/settings";
import { fakeApp, FakeVault } from "./fake-app";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const random = (n: number) => {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
	return out;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

interface Sent {
	req: RequestUrlParam;
	body: { from: string; to: string[]; subject: string; text: string; attachments: { filename: string; content: string }[] };
}
function captureMail(): Sent[] {
	const sent: Sent[] = [];
	__setRequestHandler((req) => {
		sent.push({ req, body: JSON.parse(req.body!) });
		return { status: 200, json: { id: `id-${sent.length}` } };
	});
	return sent;
}
const attachmentBytes = (s: Sent) => new Uint8Array(Buffer.from(s.body.attachments[0].content, "base64"));

function sampleVault(): FakeVault {
	const v = new FakeVault();
	v.put("05 Inbox/Мысль про Каббалу.md", "# Сфирот\nТекст заметки.");
	v.put("04 Personal/Daily Notes/05 ноября 2026.md", "Личное: проверка.");
	v.put("06 Other/Templates/Шаблон ежедневной заметки.md", "<% tp.date.now() %>");
	v.put("06 Other/Archive/Files/икона.png", random(300_000));
	v.put("Книги/Мастер и Маргарита.epub", random(1000));
	v.put("Книги/Сказки.fb2.zip", random(1000));
	v.put("Видео/большое.mp4", random(26 * 1024 * 1024));
	v.put("Старое/дата.md", "file with a pre-1980 date", 0);
	v.put(".obsidian/app.json", '{"alwaysUpdateLinks":true}');
	v.put(".obsidian/workspace-mobile.json", "{}");
	v.put(".obsidian/themes/Obsidian gruvbox/theme.css", "body{}");
	v.put(".obsidian/plugins/obsidian-livesync/data.json", '{"passphrase":"SECRET"}');
	v.put(".obsidian/plugins/obsidian-livesync/main.js", "code");
	v.put(".obsidian/plugins/obsidian42-brat/data.json", '{"personalAccessToken":"ghp_SECRET"}');
	v.put(".obsidian/plugins/templater-obsidian/data.json", '{"templates_folder":"06 Other/Templates"}');
	v.put(".obsidian/plugins/ars-backup/data.json", '{"resendKey":"re_SECRET"}');
	v.put(".diary/2026-11-05.age", random(500));
	v.put(".trash/удалённое.md", "в корзине");
	v.put(".git/HEAD", "ref: refs/heads/main");
	return v;
}

async function main(): Promise<void> {
	// Speed up retries and pauses.
	(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
	const realSetTimeout = globalThis.setTimeout;
	(globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);

	const settings = { ...DEFAULT_SETTINGS, email: "me@proton.me", resendKey: "re_test" };

	// 1. What goes into the archive.
	{
		const v = sampleVault();
		const { files, skipped } = await new Collector(fakeApp(v), settings, "ars-backup").collect();
		const paths = new Set(files.map((f) => f.path));
		for (const p of [
			"05 Inbox/Мысль про Каббалу.md", "04 Personal/Daily Notes/05 ноября 2026.md", "06 Other/Archive/Files/икона.png",
			".obsidian/app.json", ".obsidian/themes/Obsidian gruvbox/theme.css",
			".obsidian/plugins/templater-obsidian/data.json", ".diary/2026-11-05.age", "Старое/дата.md",
		]) check(`collect: includes ${p}`, paths.has(p));
		for (const p of [
			"Книги/Мастер и Маргарита.epub", "Книги/Сказки.fb2.zip", "Видео/большое.mp4",
			".obsidian/workspace-mobile.json", ".obsidian/plugins/obsidian-livesync/data.json",
			".obsidian/plugins/obsidian-livesync/main.js", ".obsidian/plugins/obsidian42-brat/data.json",
			".obsidian/plugins/ars-backup/data.json", ".trash/удалённое.md", ".git/HEAD",
		]) check(`collect: excludes ${p}`, !paths.has(p));
		check("collect: big video counted as skipped", skipped.length === 1 && skipped[0].path === "Видео/большое.mp4");
		const noConfig = await new Collector(fakeApp(v), { ...settings, includeConfig: false }, "ars-backup").collect();
		check("collect: config can be switched off", !noConfig.files.some((f) => f.path.startsWith(".obsidian/")));
		const folders = await new Collector(fakeApp(v), { ...settings, excludeFolders: "04 Personal\n06 Other/Archive" }, "ars-backup").collect();
		check("collect: excluded folders", !folders.files.some((f) => f.path.startsWith("04 Personal/") || f.path.startsWith("06 Other/Archive/")));
	}

	// 2. Keys.
	const { identity, recipient } = await createKeys();
	{
		check("keys: post-quantum secret key", identity.startsWith("AGE-SECRET-KEY-PQ-1") && identity.length === 77, identity.length.toString());
		check("keys: post-quantum public key", recipient.startsWith("age1pq1"));
		const messy = groupIdentity(identity).toLowerCase().replace(/e/g, "е").replace(/c/g, "с").replace(/-/g, "–");
		check("keys: grouped, lowercase, Cyrillic lookalikes, dashes normalise back", normalizeIdentity(messy) === identity);
		check("keys: recipientOf on messy input", (await recipientOf(messy)) === recipient);
		const typo = identity.slice(0, 30) + (identity[30] === "Q" ? "P" : "Q") + identity.slice(31);
		try {
			await recipientOf(typo);
			check("keys: typo detected", false);
		} catch (e) {
			check("keys: typo detected with a clean message", e instanceof KeyError && !e.message.includes("AGE-SECRET"), String(e));
		}
		try {
			await recipientOf("hello");
			check("keys: garbage rejected", false);
		} catch (e) {
			check("keys: garbage rejected", e instanceof KeyError);
		}
	}

	// 3. Log note.
	const v = sampleVault();
	const app = fakeApp(v);
	const log = new BackupLog(app, settings.logPath);
	{
		check("log: no recipient before setup", (await log.recipient()) === null);
		await log.setRecipient(recipient);
		check("log: note created in 06 Other", v.files.has("06 Other/Бэкапы.md"));
		check("log: recipient read back", (await log.recipient()) === recipient);
		check("log: no backups yet", (await log.last()) === null);
	}

	// 4. A normal backup: one letter, opens with the secret key, matches the vault byte for byte.
	let sealedPath = "";
	{
		const sent = captureMail();
		const result = await runBackup({ app, settings, selfId: "ars-backup", recipient, progress: () => {} });
		check("backup: one letter", sent.length === 1 && result.parts === 1, String(sent.length));
		const s = sent[0];
		check("backup: Resend endpoint", s.req.url === "https://api.resend.com/emails" && s.req.method === "POST");
		check("backup: bearer key", s.req.headers?.Authorization === "Bearer re_test");
		check("backup: idempotency key", (s.req.headers?.["Idempotency-Key"] ?? "").startsWith("ars-backup-ArsMemoria-"));
		check("backup: from/to", s.body.from === DEFAULT_SETTINGS.from && s.body.to[0] === "me@proton.me");
		check("backup: subject", /^Бэкап ArsMemoria \d{4}-\d{2}-\d{2}$/.test(s.body.subject), s.body.subject);
		check("backup: attachment name", /^ArsMemoria-\d{4}-\d{2}-\d{2}-\d{4}\.zip\.age$/.test(s.body.attachments[0].filename), s.body.attachments[0].filename);
		check("backup: letter says how to open", s.body.text.includes("age -d -i ключ.txt") && !s.body.text.includes("cat "));
		const sealed = attachmentBytes(s);
		check("backup: attachment is age binary", dec.decode(sealed.subarray(0, 21)) === "age-encryption.org/v1");
		check("backup: no plaintext in attachment", !Buffer.from(sealed).includes(Buffer.from("Сфирот")) && !Buffer.from(sealed).includes(Buffer.from("SECRET")));
		const zip = await decrypt(identity, joinParts([{ name: s.body.attachments[0].filename, data: sealed }]));
		const opened = openZip(zip);
		const { files } = await new Collector(app, settings, "ars-backup").collect();
		check("backup: every collected file is in the archive", files.every((f) => opened.files.has(f.path)) && opened.files.size === files.length,
			`${opened.files.size} vs ${files.length}`);
		check("backup: contents identical", files.every((f) => same(opened.files.get(f.path)!, v.files.get(f.path)!.data)));
		check("backup: manifest with dates", opened.manifest?.files.find((f) => f.p === "05 Inbox/Мысль про Каббалу.md")?.m === Date.UTC(2026, 9, 1, 12));
		check("backup: manifest lists skipped video", opened.manifest?.skipped[0]?.p === "Видео/большое.mp4");
		check("backup: secrets not in archive", ![...opened.files.keys()].some((p) => p.includes("obsidian-livesync/data.json") || p.includes("ars-backup/data.json")));
		await log.addRow(result);
		const last = await log.last();
		check("log: row parsed back", !!last && last.device === "iPad" && Math.abs(last.time - result.time.getTime()) < 60_000);
		const dir = mkdtempSync(join(tmpdir(), "ars-"));
		sealedPath = join(dir, s.body.attachments[0].filename);
		writeFileSync(sealedPath, sealed);
		writeFileSync(join(dir, "key.txt"), `${identity}\n`);
	}

	// 5. The official age program opens it, and a standard unzip reads the Cyrillic names.
	{
		const age = process.env.AGE_BIN;
		if (age) {
			const dir = sealedPath.slice(0, sealedPath.lastIndexOf("/"));
			execFileSync(age, ["-d", "-i", join(dir, "key.txt"), "-o", join(dir, "archive.zip"), sealedPath]);
			const listing = execFileSync("python3", ["-c",
				"import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(i.filename for i in z.infolist())); z.testzip() is None or sys.exit(3)",
				join(dir, "archive.zip")]).toString();
			check("interop: official age decrypts the archive", listing.includes("05 Inbox/Мысль про Каббалу.md"), listing.slice(0, 200));
			check("interop: zip has UTF-8 names and valid CRCs", listing.includes("04 Personal/Daily Notes/05 ноября 2026.md"));
			const unzipped = execFileSync("python3", ["-c",
				"import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))",
				join(dir, "archive.zip"), "05 Inbox/Мысль про Каббалу.md"]);
			check("interop: note text intact", unzipped.toString() === "# Сфирот\nТекст заметки.");
		} else {
			console.log("interop: skipped — set AGE_BIN to the official age program to run it");
		}
	}

	// 6. Log note: a second backup goes on top; replacing keys leaves a dated remark.
	{
		await log.addRow({ time: new Date(2030, 0, 1, 9, 5), device: "iPhone", files: 3, skipped: 0, size: 1000, parts: 1 });
		const text = v.text("06 Other/Бэкапы.md")!;
		const rows = text.split("\n").filter((l) => /^\| \d{4}-/.test(l));
		check("log: newest row first", rows[0].includes("2030-01-01 09:05") && rows.length === 2, rows.join(" / "));
		check("log: last() picks the newest", (await log.last())?.device === "iPhone");
		const other = await createKeys();
		await log.setRecipient(other.recipient);
		const after = v.text("06 Other/Бэкапы.md")!;
		check("log: key replaced", (await log.recipient()) === other.recipient && !after.includes(recipient));
		check("log: replacement remark", /Ключ заменён .+ прежним ключом\./.test(after));
		check("log: table kept", after.split("\n").filter((l) => /^\| \d{4}-/.test(l)).length === 2);
		await log.setRecipient(recipient);
	}

	// 7. A big backup is split into 17 MB parts that glue back together in name order.
	{
		const big = new FakeVault();
		big.put("Фото/1.png", random(13 * 1024 * 1024));
		big.put("Фото/2.png", random(13 * 1024 * 1024));
		big.put("Фото/3.png", random(13 * 1024 * 1024));
		big.put("Заметка.md", "текст");
		const sent = captureMail();
		const r = await runBackup({ app: fakeApp(big), settings, selfId: "ars-backup", recipient, progress: () => {} });
		check("split: three letters", sent.length === 3 && r.parts === 3, String(sent.length));
		check("split: letter text says what the mail service sees", sent[0].body.text.includes("почтовые сервисы их не видят"));
		check("split: subjects numbered", sent.every((s, i) => s.body.subject.endsWith(`(${i + 1}/3)`)));
		check("split: parts within the size limit", sent.every((s) => attachmentBytes(s).length <= PART_BYTES));
		check("split: letter explains gluing", sent[0].body.text.includes("cat ") && sent[0].body.text.includes("Это письмо 1 из 3"));
		const parts = sent.map((s) => ({ name: s.body.attachments[0].filename, data: attachmentBytes(s) })).reverse();
		check("split: names .001-.003", parts.map((p) => p.name.slice(-4)).sort().join() === ".001,.002,.003");
		const opened = openZip(await decrypt(identity, joinParts(parts)));
		check("split: glued archive opens", same(opened.files.get("Фото/2.png")!, big.files.get("Фото/2.png")!.data));
		const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return String(e); } };
		check("split: missing part named", err(() => joinParts([parts[0], parts[2]])).includes("Не хватает частей: 2"));
		check("split: mixed archives refused", err(() => joinParts([parts[0], { name: "Other.zip.age.002", data: new Uint8Array(1) }])).includes("разных архивов"));
		check("split: truncated set fails cleanly", await decrypt(identity, joinParts(parts.filter((p) => !p.name.endsWith(".003"))))
			.then(() => false, (e) => e instanceof KeyError && e.message.includes("не все его части")));
		check("split: wrong key fails cleanly", await decrypt((await createKeys()).identity, joinParts(parts))
			.then(() => false, (e) => e instanceof KeyError && e.message.includes("не открывает")));
	}

	// 8. Restore: compare, bring back missing files, full copy into a folder.
	{
		const sent = captureMail();
		const vault = sampleVault();
		const a = fakeApp(vault);
		await runBackup({ app: a, settings, selfId: "ars-backup", recipient, progress: () => {} });
		const archive = openZip(await decrypt(identity, attachmentBytes(sent[0])));
		vault.put("05 Inbox/Мысль про Каббалу.md", "изменено");
		vault.files.delete("04 Personal/Daily Notes/05 ноября 2026.md");
		vault.files.delete(".obsidian/app.json");
		vault.put("05 Inbox/Новая.md", "новая");
		const cmp = await compareWithVault(a, archive, settings, "ars-backup", () => {});
		const text = cmp.lines.join("\n");
		check("compare: changed note", text.includes("Изменены после бэкапа: 1.") && text.includes("Мысль про Каббалу"), text);
		check("compare: deleted files", text.includes("Удалены из хранилища после бэкапа: 2."), text);
		check("compare: new note", text.includes("Появились после бэкапа: 1."), text);
		check("compare: nothing written", vault.text("05 Inbox/Мысль про Каббалу.md") === "изменено");

		const back = await restoreMissing(a, archive, () => {});
		check("restore missing: two files back", back.lines[0] === "Вернул: 2.", back.lines.join(" | "));
		check("restore missing: note text back", vault.text("04 Personal/Daily Notes/05 ноября 2026.md") === "Личное: проверка.");
		check("restore missing: hidden config back", vault.text(".obsidian/app.json") === '{"alwaysUpdateLinks":true}');
		check("restore missing: modified date restored", vault.files.get("04 Personal/Daily Notes/05 ноября 2026.md")!.mtime === Date.UTC(2026, 9, 1, 12));
		check("restore missing: changed note untouched", vault.text("05 Inbox/Мысль про Каббалу.md") === "изменено");

		const copy = await restoreToFolder(a, archive, () => {});
		const folder = /«(.+)»/.exec(copy.lines[0])?.[1] ?? "";
		check("restore to folder: folder named by backup date", /^Восстановлено \d{4}-\d{2}-\d{2}-\d{4}$/.test(folder), folder);
		check("restore to folder: every file", [...archive.files.keys()].every((p) => vault.files.has(`${folder}/${p}`)));
		check("restore to folder: nothing failed", copy.lines.some((l) => l === "Не получилось записать: 0."), copy.lines.join(" | "));
		const again = await restoreToFolder(a, archive, () => {});
		check("restore to folder: second copy gets a new name", again.lines[0].includes(`${folder} (2)`), again.lines[0]);

		// Empty vault on a new device: everything comes back.
		const fresh = new FakeVault();
		const r = await restoreMissing(fakeApp(fresh), archive, () => {});
		check("restore into empty vault: all files", r.lines[0] === `Вернул: ${archive.files.size}.`, r.lines[0]);
	}

	// 9. Resend errors are explained and retried only when it helps.
	{
		const letter = { from: "a <onboarding@resend.dev>", to: "x@proton.me", subject: "s", text: "t", attachment: { name: "f.age", data: enc.encode("x") }, idempotencyKey: "k" };
		__setRequestHandler(() => ({ status: 403, json: { name: "validation_error", message: "You can only send testing emails to your own email address (me@proton.me)." } }));
		const own = await sendLetter("re", letter).then(() => null, (e) => e);
		check("mail: own-address rule explained", own instanceof MailError && own.message.includes("зарегистрирован") && !own.retryable);
		__setRequestHandler(() => ({ status: 401, json: { message: "API key is invalid" } }));
		const bad = await sendLetter("re", letter).then(() => null, (e) => e);
		check("mail: bad key explained", bad instanceof MailError && bad.message.includes("ключ API"));
		let calls = 0;
		__setRequestHandler(() => (++calls < 3 ? { status: 503, json: { message: "down" } } : { status: 200, json: { id: "ok" } }));
		check("mail: retries server errors", (await sendLetter("re", letter)) === "ok" && calls === 3, String(calls));
		calls = 0;
		__setRequestHandler(() => { calls++; throw new Error("offline"); });
		const off = await sendLetter("re", letter).then(() => null, (e) => e);
		check("mail: offline explained after 3 tries", off instanceof MailError && off.message.includes("нет связи") && calls === 3, String(calls));
	}

	console.log(`passed: ${passed}`);
	if (failures.length) {
		console.log(`FAILED: ${failures.length}`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
