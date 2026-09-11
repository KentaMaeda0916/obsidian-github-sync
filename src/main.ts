import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { AuthManager, type StoredAuth } from "./auth";
import { GitHubClient } from "./github";
import { Store } from "./state";
import { SyncEngine } from "./sync";
import { SyncView, VIEW_TYPE } from "./view";
import { DEFAULT_SETTINGS, type PluginData, type Settings } from "./settings";
import { DeviceFlowModal, confirmModal } from "./modals";

export default class GitHubSyncPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	auth!: AuthManager;
	engine: SyncEngine | null = null;

	async onload(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };

		this.auth = new AuthManager(this.settings.clientId, data.auth ?? null, (auth) =>
			this.persist(auth),
		);

		await this.buildEngine();

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncView(leaf, this));
		this.addRibbonIcon("git-branch", "GitHub Sync", () => void this.openView());
		this.addSettingTab(new SyncSettingTab(this.app, this));

		this.addCommand({
			id: "open-view",
			name: "パネルを開く",
			callback: () => void this.openView(),
		});
		this.addCommand({
			id: "pull",
			name: "Pull",
			callback: () => void this.withEngine((e) => e.pull()),
		});
		this.addCommand({
			id: "push",
			name: "Push",
			callback: () => void this.withEngine((e) => e.push()),
		});

		if (this.settings.pullOnStartup && this.auth.isAuthenticated) {
			this.app.workspace.onLayoutReady(() => {
				void this.withEngine((e) => e.pull(), { silent: true });
			});
		}
	}

	onunload(): void {
		this.engine = null;
	}

	/** 設定・認証情報の保存先は .obsidian 配下なので vault にはコミットされない。 */
	private async persist(auth: StoredAuth | null): Promise<void> {
		const current = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		await this.saveData({ settings: this.settings, auth: auth ?? current.auth ?? null });
	}

	async saveSettings(): Promise<void> {
		const current = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		await this.saveData({ settings: this.settings, auth: current.auth ?? null });
		this.auth.setClientId(this.settings.clientId);
		await this.buildEngine();
	}

	/** Client ID・リポジトリ・接続の3つが揃っているか。 */
	get isConfigured(): boolean {
		return (
			this.settings.clientId !== "" &&
			this.settings.owner !== "" &&
			this.settings.repo !== "" &&
			this.auth.isAuthenticated
		);
	}

	async buildEngine(): Promise<void> {
		const dir = this.manifest.dir;
		if (!dir || !this.settings.owner || !this.settings.repo) {
			this.engine = null;
			return;
		}

		const store = new Store(this.app.vault.adapter, dir);
		const state = await store.loadState("main");
		const client = new GitHubClient(
			{ owner: this.settings.owner, repo: this.settings.repo },
			this.auth,
		);
		this.engine = new SyncEngine(
			this.app.vault.adapter,
			client,
			store,
			this.settings,
			state,
		);
	}

	async openView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async withEngine(
		fn: (engine: SyncEngine) => Promise<unknown>,
		opts: { silent?: boolean } = {},
	): Promise<void> {
		if (!this.engine || !this.isConfigured) {
			new Notice("設定で GitHub App の Client ID とリポジトリを入力し、GitHub と接続してください");
			return;
		}
		try {
			await fn(this.engine);
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				await (leaf.view as SyncView).refresh();
			}
		} catch (e) {
			if (!opts.silent) new Notice(e instanceof Error ? e.message : String(e), 8000);
		}
	}
}

class SyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GitHubSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"自分の GitHub App を1つ作り（Device Flow を有効化、権限は Contents: Read and write のみ、" +
				"同期したいリポジトリにだけインストール）、その Client ID をここに入れる。手順は README。",
		});

		new Setting(containerEl)
			.setName("GitHub App の Client ID")
			.setDesc("自分で作った GitHub App の Client ID。client secret は不要。")
			.addText((text) =>
				text
					.setPlaceholder("Iv1.xxxxxxxxxxxxxxxx")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (v) => {
						this.plugin.settings.clientId = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("リポジトリ")
			.setDesc("同期先。GitHub App をインストールしたリポジトリを owner/repo の形で。")
			.addText((text) =>
				text
					.setPlaceholder("owner/repo")
					.setValue(
						this.plugin.settings.owner && this.plugin.settings.repo
							? `${this.plugin.settings.owner}/${this.plugin.settings.repo}`
							: "",
					)
					.onChange(async (v) => {
						const [owner, repo] = v.split("/").map((x) => x.trim());
						if (!owner || !repo) return;
						this.plugin.settings.owner = owner;
						this.plugin.settings.repo = repo;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("起動時に Pull")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (v) => {
					this.plugin.settings.pullOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		this.displayConnection(containerEl);
		this.displayClone(containerEl);
		this.displayMaintenance(containerEl);
	}

	private displayConnection(containerEl: HTMLElement): void {
		const connected = this.plugin.auth.isAuthenticated;

		new Setting(containerEl)
			.setName("GitHub との接続")
			.setDesc(connected ? "接続済み" : "未接続")
			.addButton((btn) =>
				btn
					.setButtonText(connected ? "接続し直す" : "GitHub と接続")
					.setCta()
					.onClick(() => {
						if (!this.plugin.settings.clientId) {
							new Notice("先に Client ID を入力してください");
							return;
						}
						new DeviceFlowModal(this.app, this.plugin.settings.clientId, async (auth) => {
							await this.plugin.auth.signIn(auth);
							this.display();
						}).open();
					}),
			);

		if (connected) {
			new Setting(containerEl).addButton((btn) =>
				btn.setButtonText("接続を解除").setWarning().onClick(async () => {
					await this.plugin.auth.signOut();
					this.display();
				}),
			);
		}
	}

	private displayClone(containerEl: HTMLElement): void {
		const engine = this.plugin.engine;
		if (!engine) return;

		new Setting(containerEl)
			.setName("クローン")
			.setDesc(
				engine.state.headSha
					? `${engine.state.branch} を同期中`
					: "空の vault にリポジトリの中身を展開する。初回だけ実行する。",
			)
			.addButton((btn) =>
				btn.setButtonText("クローン").onClick(async () => {
					const ok = await confirmModal(
						this.app,
						"クローン",
						"リポジトリの中身をこの vault に展開します。同名のファイルは上書きされます。",
					);
					if (!ok) return;
					const notice = new Notice("クローン中…", 0);
					try {
						const n = await engine.clone(engine.state.branch, (m, done, total) => {
							notice.setMessage(total ? `${m} (${done}/${total})` : m);
						});
						notice.hide();
						new Notice(`${n} 件のファイルを取得しました`);
						this.display();
					} catch (e) {
						notice.hide();
						new Notice(e instanceof Error ? e.message : String(e), 8000);
					}
				}),
			);
	}

	private displayMaintenance(containerEl: HTMLElement): void {
		const engine = this.plugin.engine;
		if (!engine) return;

		new Setting(containerEl)
			.setName("再スキャン")
			.setDesc("ハッシュのキャッシュを捨てて全ファイルを読み直す。表示がずれているときに。")
			.addButton((btn) =>
				btn.setButtonText("再スキャン").onClick(async () => {
					const notice = new Notice("再スキャン中…", 0);
					try {
						const changes = await engine.rescan((m, done, total) => {
							notice.setMessage(total ? `${m} (${done}/${total})` : m);
						});
						notice.hide();
						new Notice(`変更 ${changes.length} 件`);
					} catch (e) {
						notice.hide();
						new Notice(e instanceof Error ? e.message : String(e), 8000);
					}
				}),
			);
	}
}
