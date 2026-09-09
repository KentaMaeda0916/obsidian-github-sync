import type { StoredAuth } from "./auth";

export interface Settings {
	/** GitHub App の Client ID。公開情報なので秘密ではない。 */
	clientId: string;
	owner: string;
	repo: string;
	/** 同期対象から外すパス接頭辞。git 側に無いローカル専用のものを弾く。 */
	ignore: string[];
	/** 起動時に自動で pull するか。 */
	pullOnStartup: boolean;
}

export interface PluginData {
	settings: Settings;
	auth: StoredAuth | null;
}

/**
 * この vault 用に作った GitHub App の Client ID。
 * device flow は client secret を使わないため、これは公開情報であり秘密ではない
 * （CLI ツールが client_id をソースに埋め込んでいるのと同じ）。
 * 別の App を使いたい場合は設定画面から上書きできる。
 */
const DEFAULT_CLIENT_ID = "Iv23lizZeip3nAY9Wk88";

export const DEFAULT_SETTINGS: Settings = {
	clientId: DEFAULT_CLIENT_ID,
	owner: "KentaMaeda0916",
	repo: "ObsidianVault",
	ignore: [".obsidian", ".git", ".trash", ".DS_Store", ".worktrees"],
	pullOnStartup: false,
};

export const DEFAULT_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	auth: null,
};
