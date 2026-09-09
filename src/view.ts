import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
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

const KIND_VERB: Record<Change["kind"], string> = {
	added: "Add",
	modified: "Update",
	deleted: "Delete",
};

export class SyncView extends ItemView {
	private changes: Change[] = [];
	/** ユーザーが自分で書いたメッセージ。空なら自動生成を使う。 */
	private typedMessage = "";
	private busy = false;
	private status = "";
	/** Vault のイベントで変更が知らされ、まだ取り込んでいないパス。 */
	private readonly pending = new Set<string>();
	/** 中身を開いている未 push コミットの id。 */
	private readonly expanded = new Set<number>();

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
		// 編集を検知して変更リストを追従させる。取り込むのは変わったパスだけなので、
		// 何度発火しても全走査にはならない。
		const touch = (path: string) => {
			this.pending.add(path);
			this.absorbPending();
		};
		this.registerEvent(this.app.vault.on("create", (f) => touch(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f) => touch(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => touch(f.path)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				touch(oldPath);
				touch(f.path);
			}),
		);
		// 他のペインから戻ってきたときにも最新にする（差分を取り直すだけなので軽い）
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.refresh()));

		await this.refresh();
	}

	/** 溜まったパスをまとめて取り込む。連続入力で毎回走らせないよう間引く。 */
	private readonly absorbPending = debounce(
		() => {
			void (async () => {
				const engine = this.plugin.engine;
				if (!engine || this.busy || this.pending.size === 0) return;

				const paths = [...this.pending];
				this.pending.clear();
				for (const path of paths) await engine.notePathChanged(path);
				await this.refresh();
			})();
		},
		700,
		true,
	);

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
		} catch (e) {
			this.status = "";
			new Notice(describe(e), 8000);
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("github-sync-view");

		if (!this.plugin.engine) {
			root.createEl("p", { text: "設定で GitHub と接続してください。" });
			return;
		}

		this.renderHeader(root);
		if (this.status) root.createEl("div", { cls: "ghs-status", text: this.status });
		this.renderChanges(root);
		this.renderQueue(root);
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

		const more = header.createEl("button", { cls: "ghs-more" });
		setIcon(more, "more-vertical");
		more.onclick = (evt) => this.openOverflowMenu(evt);
	}

	private openOverflowMenu(evt: MouseEvent): void {
		const engine = this.plugin.engine!;
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("未コミットの変更を全部取り消す")
				.setIcon("undo")
				.setDisabled(this.changes.length === 0)
				.onClick(async () => {
					const paths = this.changes.map((c) => c.path);
					const ok = await confirmModal(
						this.app,
						"変更を全部取り消す",
						`${paths.length} 件の未コミットの変更を破棄します。取り消せません。\n` +
							"コミット済み・未 push の内容はそのまま残ります。",
					);
					if (!ok) return;
					await this.run("元に戻しています…", async () => {
						await engine.discard(paths, (m) => this.setStatus(m));
						return `${paths.length} 件を元に戻しました`;
					});
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("再スキャン")
				.setIcon("refresh-cw")
				.onClick(() =>
					this.run("再スキャン中…", async () => {
						const changes = await engine.rescan((m) => this.setStatus(m));
						return `変更 ${changes.length} 件`;
					}),
				),
		);

		menu.showAtMouseEvent(evt);
	}

	/** コミット済み・未 push のコミット一覧。ここに出ている分は変更リストから消える。 */
	private renderQueue(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const queue = engine.state.queue;
		if (queue.length === 0) return;

		root.createDiv({
			cls: "ghs-list-head",
			text: `コミット済み・未 push ${queue.length}件`,
		});

		const list = root.createDiv({ cls: "ghs-list" });
		for (const commit of queue) {
			const files = [...commit.paths, ...commit.deleted];
			const row = list.createDiv({ cls: "ghs-row ghs-commit" });

			const caret = row.createSpan({ cls: "ghs-caret" });
			setIcon(caret, this.expanded.has(commit.id) ? "chevron-down" : "chevron-right");

			const label = row.createSpan({ cls: "ghs-path", text: commit.message });
			label.title = commit.message;
			row.createSpan({ cls: "ghs-count", text: `${files.length}` });

			const toggle = () => {
				if (this.expanded.has(commit.id)) this.expanded.delete(commit.id);
				else this.expanded.add(commit.id);
				this.render();
			};
			caret.onclick = toggle;
			label.onclick = toggle;

			const more = row.createEl("button", { cls: "ghs-more" });
			setIcon(more, "more-horizontal");
			more.onclick = (evt) => {
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle("このコミットを取り消す")
						.setIcon("undo")
						.onClick(() =>
							this.run("取り消しています…", async () => {
								await engine.uncommit(commit.id);
								return "コミットを取り消しました";
							}),
						),
				);
				menu.showAtMouseEvent(evt);
			};

			if (!this.expanded.has(commit.id)) continue;

			for (const path of files) {
				const child = list.createDiv({ cls: "ghs-row ghs-child" });
				const name = child.createSpan({ cls: "ghs-path", text: shorten(path) });
				name.title = path;
				name.onclick = () =>
					void this.openFile({
						path,
						kind: commit.deleted.includes(path) ? "deleted" : "modified",
						sha: null,
					});

				const undo = child.createEl("button", { text: "戻す" });
				undo.onclick = () =>
					this.run("戻しています…", async () => {
						await engine.uncommit(commit.id, [path]);
						return `${basename(path)} を未コミットに戻しました`;
					});
			}
		}
	}

	private renderChanges(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const selected = engine.selected(this.changes);

		const head = root.createDiv({ cls: "ghs-list-head" });
		head.createSpan({ text: `未コミット ${this.changes.length}件（${selected.length}件を選択中）` });

		if (this.changes.length > 0) {
			const allOn = selected.length === this.changes.length;
			const toggleAll = head.createEl("button", { text: allOn ? "全解除" : "全選択" });
			toggleAll.onclick = () =>
				this.run("", () =>
					engine.setUnstaged(allOn ? this.changes.map((c) => c.path) : []),
				);
		}

		if (this.changes.length === 0) {
			root.createEl("p", { cls: "ghs-empty", text: "未コミットの変更はありません" });
			return;
		}

		const list = root.createDiv({ cls: "ghs-list" });
		for (const change of this.changes) {
			const row = list.createDiv({ cls: "ghs-row" });

			const check = row.createEl("input", { type: "checkbox" });
			check.checked = engine.isSelected(change.path);
			check.onclick = () => this.run("", () => engine.toggle(change.path));

			row.createSpan({
				cls: `ghs-kind ghs-kind-${change.kind}`,
				text: KIND_LABEL[change.kind],
			});

			// パスをタップしたらそのファイルを開く
			const path = row.createSpan({ cls: "ghs-path", text: shorten(change.path) });
			path.title = change.path;
			path.onclick = () => void this.openFile(change);

			const more = row.createEl("button", { cls: "ghs-more" });
			setIcon(more, "more-horizontal");
			more.onclick = (evt) => this.openRowMenu(evt, change);
		}
	}

	private renderActions(root: HTMLElement): void {
		const engine = this.plugin.engine!;
		const selected = engine.selected(this.changes);
		const queued = engine.state.queue.length;
		const box = root.createDiv({ cls: "ghs-actions" });

		// 空のままなら自動生成したメッセージを使う。中身は見えるので直せる。
		const input = box.createEl("input", { type: "text", placeholder: "コミットメッセージ" });
		input.value = this.typedMessage || generateMessage(selected);
		input.oninput = () => {
			this.typedMessage = input.value;
		};

		const buttons = box.createDiv({ cls: "ghs-buttons" });

		const commit = buttons.createEl("button", { text: "コミット" });
		commit.disabled = this.busy || selected.length === 0;
		commit.onclick = () =>
			this.run("コミット中…", async () => {
				const count = selected.length;
				await engine.commit(this.commitMessage(selected));
				this.typedMessage = "";
				return `${count} 件をコミットしました`;
			});

		const push = buttons.createEl("button", {
			cls: "mod-cta",
			text: queued > 0 ? `Push (${queued})` : "Push",
		});
		push.disabled = this.busy || (queued === 0 && selected.length === 0);
		push.onclick = () =>
			this.run("送信中…", async () => {
				// 未コミットの選択が残っているなら、まとめてコミットしてから送る
				if (engine.state.queue.length === 0) {
					await engine.commit(this.commitMessage(selected));
					this.typedMessage = "";
				}
				const n = await engine.push((m) => this.setStatus(m));
				return `${n} コミットを push しました`;
			});
	}

	private commitMessage(selected: Change[]): string {
		return this.typedMessage.trim() || generateMessage(selected);
	}

	private async openFile(change: Change): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(change.path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
			return;
		}
		new Notice(
			change.kind === "deleted"
				? "削除済みのファイルです"
				: `開けませんでした: ${change.path}`,
		);
	}

	private openRowMenu(evt: MouseEvent, change: Change): void {
		const engine = this.plugin.engine!;
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("開く")
				.setIcon("file-text")
				.onClick(() => void this.openFile(change)),
		);

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

/**
 * コミットメッセージを変更内容から組み立てる。
 * リポジトリの履歴に残るものなので英語に統一する（ファイル名はそのまま）。
 */
export function generateMessage(changes: Change[]): string {
	if (changes.length === 0) return "Sync vault";

	const kinds = new Set(changes.map((c) => c.kind));
	const verb = kinds.size === 1 ? KIND_VERB[changes[0].kind] : "Update";
	const name = basename(changes[0].path);
	const rest = changes.length - 1;

	if (rest === 0) return `${verb} ${name}`;
	return `${verb} ${name} and ${rest} more ${rest === 1 ? "file" : "files"}`;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** モバイルの幅に収まるよう、長いパスは中央を省く。 */
function shorten(path: string): string {
	if (path.length <= 44) return path;
	return `…/${basename(path)}`;
}

function describe(e: unknown): string {
	if (e instanceof NotFastForwardError || e instanceof DirtyTreeError) return e.message;
	if (e instanceof NotClonedError) return `${e.message}。設定から「クローン」を実行してください。`;
	return e instanceof Error ? e.message : String(e);
}
