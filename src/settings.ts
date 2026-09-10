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
 * 既定値は空。Client ID もリポジトリも利用者が自分のものを設定画面で入れる。
 *
 * Client ID は device flow では公開情報扱いだが、特定の App を既定で埋め込むと
 * 「その App を使う全員がその App の所有者に依存する」形になる。自分の App を
 * 自分で作って入れる方が素直なので、既定では何も持たない。
 */
export const DEFAULT_SETTINGS: Settings = {
	clientId: "",
	owner: "",
	repo: "",
	ignore: [".obsidian", ".git", ".trash", ".DS_Store", ".worktrees"],
	pullOnStartup: false,
};

export const DEFAULT_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	auth: null,
};
