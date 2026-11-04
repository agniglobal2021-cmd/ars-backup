import { ButtonComponent } from "obsidian";

export interface ButtonSpec {
	text: string;
	cta?: boolean;
	warning?: boolean;
	disabled?: boolean;
	onClick: () => void | Promise<void>;
}

/** A row of large buttons that wraps on narrow screens. */
export function buttonRow(parent: HTMLElement, specs: ButtonSpec[]): ButtonComponent[] {
	const row = parent.createDiv({ cls: "ars-backup-buttons" });
	return specs.map((s) => {
		const b = new ButtonComponent(row).setButtonText(s.text).onClick(() => void s.onClick());
		if (s.cta) b.setCta();
		if (s.warning) b.setWarning();
		if (s.disabled) b.setDisabled(true);
		return b;
	});
}

/** Text area for a secret key: no autocorrect, no capitalisation, no suggestions. */
export function keyArea(parent: HTMLElement, placeholder = "AGE-SECRET-KEY-PQ-1…"): HTMLTextAreaElement {
	const area = parent.createEl("textarea", { cls: "ars-backup-key-input", attr: { rows: "4", placeholder } });
	area.setAttr("autocomplete", "off");
	area.setAttr("autocorrect", "off");
	area.setAttr("autocapitalize", "characters");
	area.setAttr("spellcheck", "false");
	return area;
}

export function message(parent: HTMLElement): (text: string, kind?: "error" | "ok" | "") => void {
	const el = parent.createDiv({ cls: "ars-backup-message" });
	return (text, kind = "") => {
		el.setText(text);
		el.toggleClass("is-error", kind === "error");
		el.toggleClass("is-ok", kind === "ok");
	};
}

export function para(parent: HTMLElement, text: string, cls?: string): HTMLParagraphElement {
	return parent.createEl("p", { text, cls });
}
