import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import type { BranchInfo } from "./github";
import { type DeviceCodeStart, pollDeviceFlow, startDeviceFlow, type StoredAuth } from "./auth";

export class PromptModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private readonly title: string,
		private readonly onSubmit: (value: string) => Promise<void> | void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);

		new Setting(this.contentEl).addText((text) => {
			text.inputEl.style.width = "100%";
			text.onChange((v) => {
				this.value = v;
			});
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") this.submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("OK").setCta().onClick(() => this.submit()),
		);
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) return;
		this.close();
		void this.onSubmit(value);
	}
}

export class BranchPickerModal extends SuggestModal<BranchInfo> {
	constructor(
		app: App,
		private readonly branches: BranchInfo[],
		private readonly onPick: (name: string) => Promise<void> | void,
	) {
		super(app);
		this.setPlaceholder("ブランチを選択");
	}

	getSuggestions(query: string): BranchInfo[] {
		const q = query.toLowerCase();
		return this.branches.filter((b) => b.name.toLowerCase().includes(q));
	}

	renderSuggestion(branch: BranchInfo, el: HTMLElement): void {
		el.createDiv({ text: branch.name });
		el.createEl("small", { text: branch.sha.slice(0, 7) });
	}

	onChooseSuggestion(branch: BranchInfo): void {
		void this.onPick(branch.name);
	}
}

/** 破壊的操作の前に必ず挟む確認。 */
export function confirmModal(app: App, title: string, body: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let decided = false;

		modal.titleEl.setText(title);
		modal.contentEl.createEl("p", { text: body });

		new Setting(modal.contentEl)
			.addButton((btn) =>
				btn.setButtonText("キャンセル").onClick(() => {
					modal.close();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("実行")
					.setWarning()
					.onClick(() => {
						decided = true;
						modal.close();
						resolve(true);
					}),
			);

		modal.onClose = () => {
			if (!decided) resolve(false);
		};
		modal.open();
	});
}

/**
 * device flow の待ち受け画面。
 * ユーザーは表示されたコードを github.com/login/device に入力するだけでよい。
 */
export class DeviceFlowModal extends Modal {
	private cancelled = false;

	constructor(
		app: App,
		private readonly clientId: string,
		private readonly onDone: (auth: StoredAuth) => Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("GitHub と接続");
		const body = this.contentEl;
		body.createEl("p", { text: "コードを取得しています…" });

		let start: DeviceCodeStart;
		try {
			start = await startDeviceFlow(this.clientId);
		} catch (e) {
			body.empty();
			body.createEl("p", { text: e instanceof Error ? e.message : String(e) });
			return;
		}

		body.empty();
		body.createEl("p", { text: "1. 下のコードをコピーする" });
		const code = body.createEl("div", { cls: "ghs-code", text: start.userCode });
		code.onclick = () => {
			void navigator.clipboard?.writeText(start.userCode);
			new Notice("コードをコピーしました");
		};

		body.createEl("p", { text: "2. GitHub を開いて貼り付け、承認する" });
		body.createEl("a", {
			text: start.verificationUri,
			href: start.verificationUri,
		});

		const waiting = body.createEl("p", { text: "承認を待っています…" });

		try {
			const auth = await pollDeviceFlow(this.clientId, start, () => this.cancelled);
			await this.onDone(auth);
			new Notice("GitHub と接続しました");
			this.close();
		} catch (e) {
			if (this.cancelled) return;
			waiting.setText(e instanceof Error ? e.message : String(e));
		}
	}

	onClose(): void {
		this.cancelled = true;
	}
}
