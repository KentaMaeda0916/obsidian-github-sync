import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { Change } from "./diff";
import { DirtyTreeError, NotClonedError, NotFastForwardError } from "./sync";
import type GitHubSyncPlugin from "./main";
import { BranchPickerModal, PromptModal, confirmModal } from "./modals";

export const VIEW_TYPE = "github-sync-view";

const KIND_LABEL: Record<Change["kind"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
};

export class SyncView extends ItemView {
	private changes: Change[] = [];
	private message = "";
	private busy = false;
	private status = "";

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GitHubSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "GitHub Sync";
	}

	getIcon(): string {
		return "git-branch";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	/** 変更リストを取り直して描画する。 */
	async refresh(): Promise<void> {
		const engine = this.plugin.engine;
		if (engine) {
			try {
				this.changes = await engine.localChanges();
			} catch (e) {
				this.changes = [];
				this.status = describe(e);
			}
		}
		this.render();
	}

	/** 長い処理を実行しつつ、進捗をヘッダに出す。 */
	private async run(label: string, fn: () => Promise<string | void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.status = label;
		this.render();
		try {
			const result = await fn();
			this.status = "";
			if (result) new Notice(result);
			await this.refresh();
		} catch (e) {
			this.status = "";
			new Notice(describe(e), 8000);
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("github-sync-view");

		const engine = this.plugin.engine;
		if (!engine) {
			root.createEl("p", { text: "設定で GitHub と接続してください。" });
			return;
		}

		this.renderHeader(root);
		if (this.status) root.createEl("div", { cls: "ghs-status", text: this.status });
		this.renderChanges(root);
		this.renderActions(root);
	}

	private renderHeader(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const header = root.createDiv({ cls: "ghs-header" });

		const branch = header.createEl("button", { cls: "ghs-branch" });
		setIcon(branch.createSpan(), "git-branch");
		branch.createSpan({ text: engine.state.branch });
		branch.onclick = (evt) => this.openBranchMenu(evt);

		const pull = header.createEl("button", { text: "Pull" });
		pull.disabled = this.busy;
		pull.onclick = () =>
			this.run("取得中…", async () => {
				const applied = await engine.pull((m) => this.setStatus(m));
				return applied.length === 0
					? "最新です"
					: `${applied.length} 件のファイルを更新しました`;
			});
	}

	private renderChanges(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const staged = new Set(engine.state.staged);

		const head = root.createDiv({ cls: "ghs-list-head" });
		head.createSpan({ text: `変更 ${this.changes.length}件` });

		if (this.changes.length > 0) {
			const all = head.createEl("button", {
				text: staged.size === this.changes.length ? "全解除" : "全選択",
			});
			all.onclick = () =>
				this.run("", async () => {
					await engine.setStaged(
						staged.size === this.changes.length ? [] : this.changes.map((c) => c.path),
					);
				});
		}

		if (this.changes.length === 0) {
			root.createEl("p", { cls: "ghs-empty", text: "変更はありません" });
			return;
		}

		const list = root.createDiv({ cls: "ghs-list" });
		for (const change of this.changes) {
			const row = list.createDiv({ cls: "ghs-row" });

			const check = row.createEl("input", { type: "checkbox" });
			check.checked = staged.has(change.path);
			check.onclick = () => this.run("", () => engine.toggleStaged(change.path));

			row.createSpan({ cls: `ghs-kind ghs-kind-${change.kind}`, text: KIND_LABEL[change.kind] });
			row.createSpan({ cls: "ghs-path", text: shorten(change.path) }).title = change.path;

			const more = row.createEl("button", { cls: "ghs-more" });
			setIcon(more, "more-horizontal");
			more.onclick = (evt) => this.openRowMenu(evt, change);
		}
	}

	private renderActions(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const box = root.createDiv({ cls: "ghs-actions" });

		const input = box.createEl("input", {
			type: "text",
			placeholder: "コミットメッセージ",
		});
		input.value = this.message;
		input.oninput = () => {
			this.message = input.value;
		};

		const buttons = box.createDiv({ cls: "ghs-buttons" });

		const commit = buttons.createEl("button", { text: "コミット" });
		commit.disabled = this.busy || engine.state.staged.length === 0;
		commit.onclick = () =>
			this.run("コミット中…", async () => {
				const count = engine.state.staged.length;
				await engine.commit(this.message.trim() || defaultMessage(count));
				this.message = "";
				return `${count} 件をコミットしました`;
			});

		const queued = engine.state.queue.length;
		const push = buttons.createEl("button", {
			cls: "mod-cta",
			text: queued > 0 ? `Push (${queued})` : "Push",
		});
		push.disabled = this.busy || queued === 0;
		push.onclick = () =>
			this.run("送信中…", async () => {
				const n = await engine.push((m) => this.setStatus(m));
				return `${n} コミットを push しました`;
			});
	}

	private openRowMenu(evt: MouseEvent, change: Change): void {
		const engine = this.plugin.engine!;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("元に戻す")
				.setIcon("undo")
				.onClick(async () => {
					const ok = await confirmModal(
						this.app,
						"変更を元に戻す",
						`${change.path} の変更を破棄します。取り消せません。`,
					);
					if (!ok) return;
					await this.run("元に戻しています…", async () => {
						await engine.discard([change.path]);
						return "元に戻しました";
					});
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	private openBranchMenu(evt: MouseEvent): void {
		const engine = this.plugin.engine!;
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("ブランチを切り替え")
				.setIcon("git-branch")
				.onClick(async () => {
					const branches = await engine.listBranches();
					new BranchPickerModal(this.app, branches, async (name) => {
						await this.run("切り替え中…", async () => {
							const applied = await engine.switchBranch(name, (m) => this.setStatus(m));
							return `${name} に切り替えました（${applied.length} 件更新）`;
						});
					}).open();
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("ブランチを作成")
				.setIcon("plus")
				.onClick(() => {
					new PromptModal(this.app, "新しいブランチ名", async (name) => {
						await this.run("作成中…", async () => {
							await engine.createBranch(name);
							return `${name} を作成しました`;
						});
					}).open();
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("ブランチを削除")
				.setIcon("trash")
				.onClick(async () => {
					const branches = (await engine.listBranches()).filter(
						(b) => b.name !== engine.state.branch,
					);
					new BranchPickerModal(this.app, branches, async (name) => {
						const ok = await confirmModal(
							this.app,
							"ブランチを削除",
							`${name} を GitHub から削除します。取り消せません。`,
						);
						if (!ok) return;
						await this.run("削除中…", async () => {
							await engine.deleteBranch(name);
							return `${name} を削除しました`;
						});
					}).open();
				}),
		);

		menu.showAtMouseEvent(evt);
	}

	private setStatus(message: string): void {
		this.status = message;
		const el = this.contentEl.querySelector(".ghs-status");
		if (el) el.textContent = message;
	}
}

function defaultMessage(count: number): string {
	const today = new Date().toISOString().slice(0, 10);
	return `vault: update ${count} files (${today})`;
}

/** モバイルの幅に収まるよう、長いパスは中央を省く。 */
function shorten(path: string): string {
	if (path.length <= 44) return path;
	const name = path.slice(path.lastIndexOf("/") + 1);
	return `…/${name}`;
}

function describe(e: unknown): string {
	if (e instanceof NotFastForwardError || e instanceof DirtyTreeError) return e.message;
	if (e instanceof NotClonedError) return `${e.message}。設定から「クローン」を実行してください。`;
	return e instanceof Error ? e.message : String(e);
}
