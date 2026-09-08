import type { DataAdapter } from "obsidian";
import type { TreeMap } from "./github";

/** 未 push のローカルコミット1件。本文は queue-<id>.json 側にある。 */
export interface QueuedCommit {
	id: number;
	message: string;
	ts: number;
	/** 追加・変更されたパス。 */
	paths: string[];
	deleted: string[];
}

/** コミット時点のファイル内容のスナップショット（path -> base64）。 */
export type CommitSnapshot = Record<string, string>;

/** ハッシュ済みファイルの記録。mtime と size が一致すれば再ハッシュを省ける。 */
export interface CacheEntry {
	m: number;
	s: number;
	h: string;
}

export interface SyncState {
	branch: string;
	/** state.baseline が対応する GitHub 上のコミット。未 clone なら null。 */
	headSha: string | null;
	/** headSha 時点で GitHub が持っている path -> blobSHA。 */
	baseline: TreeMap;
	staged: string[];
	queue: QueuedCommit[];
	nextCommitId: number;
	cache: Record<string, CacheEntry>;
}

export function emptyState(branch = "main"): SyncState {
	return {
		branch,
		headSha: null,
		baseline: {},
		staged: [],
		queue: [],
		nextCommitId: 1,
		cache: {},
	};
}

/**
 * プラグインフォルダ配下の永続化。
 *
 * baseline は 1,800 件規模になるため plugin の data.json とは分けている
 * （設定を書くたびに巨大な JSON を往復させないため）。どちらも `.obsidian/`
 * 配下なので vault のコミット対象にはならない。
 */
export class Store {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly dir: string,
	) {}

	private get statePath(): string {
		return `${this.dir}/state.json`;
	}

	private snapshotPath(id: number): string {
		return `${this.dir}/queue-${id}.json`;
	}

	async loadState(defaultBranch: string): Promise<SyncState> {
		try {
			if (!(await this.adapter.exists(this.statePath))) return emptyState(defaultBranch);
			const parsed = JSON.parse(await this.adapter.read(this.statePath)) as Partial<SyncState>;
			return { ...emptyState(defaultBranch), ...parsed };
		} catch {
			// 壊れていたら作り直す。clone か再スキャンで復元できる。
			return emptyState(defaultBranch);
		}
	}

	async saveState(state: SyncState): Promise<void> {
		await this.adapter.write(this.statePath, JSON.stringify(state));
	}

	async saveSnapshot(id: number, snapshot: CommitSnapshot): Promise<void> {
		await this.adapter.write(this.snapshotPath(id), JSON.stringify(snapshot));
	}

	async loadSnapshot(id: number): Promise<CommitSnapshot> {
		return JSON.parse(await this.adapter.read(this.snapshotPath(id))) as CommitSnapshot;
	}

	async deleteSnapshot(id: number): Promise<void> {
		if (await this.adapter.exists(this.snapshotPath(id))) {
			await this.adapter.remove(this.snapshotPath(id));
		}
	}
}
