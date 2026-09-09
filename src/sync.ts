import type { DataAdapter } from "obsidian";
import { base64ToArrayBuffer } from "obsidian";
import type { BranchInfo, GitHubClient, TreeMap } from "./github";
import { type Change, diffTrees } from "./diff";
import type { CacheEntry, CommitSnapshot, QueuedCommit, Store, SyncState } from "./state";
import type { Settings } from "./settings";
import { gitBlobSha } from "./hash";
import * as vfs from "./vaultfs";
import { isIgnored as isIgnoredPath } from "./vaultfs";

export type Progress = (message: string, done?: number, total?: number) => void;

/** 未コミットの変更があるため実行できない操作。 */
export class DirtyTreeError extends Error {}
/** リモートが先に進んでいるため fast-forward できない。 */
export class NotFastForwardError extends Error {}
/** clone がまだ行われておらず、基準となるコミットが無い。 */
export class NotClonedError extends Error {}

const noop: Progress = () => undefined;

/** blob の並列取得数。増やすと速いが iOS のメモリを圧迫する。 */
const FETCH_CONCURRENCY = 6;

export class SyncEngine {
	/**
	 * vault の現状（path -> blobSHA）。
	 *
	 * 一度作ったらメモリに保持し、以降は Vault のイベントで変わったパスだけ
	 * 差し替える。毎回 1,800 件を走査し直すと iOS では体感で止まるため。
	 */
	private localTree: TreeMap | null = null;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly client: GitHubClient,
		private readonly store: Store,
		private readonly settings: Settings,
		public state: SyncState,
	) {}

	private async save(): Promise<void> {
		await this.store.saveState(this.state);
	}

	// ---- 変更検出 ----------------------------------------------------------

	/**
	 * vault の現状を path -> blobSHA で返す。
	 *
	 * mtime と size が前回と同じファイルはキャッシュ済みのハッシュを使い回すので、
	 * 実際に読むのは変更されたファイルだけになる。全件ハッシュを避けるのが要点。
	 */
	private async scanAll(progress: Progress = noop): Promise<TreeMap> {
		const paths = await vfs.listVaultFiles(this.adapter, this.settings.ignore);
		const tree: TreeMap = {};
		const nextCache: Record<string, CacheEntry> = {};
		let hashed = 0;

		for (let i = 0; i < paths.length; i++) {
			const path = paths[i];
			const stat = await this.adapter.stat(path);
			if (!stat || stat.type !== "file") continue;

			const hit = this.state.cache[path];
			if (hit && hit.m === stat.mtime && hit.s === stat.size) {
				tree[path] = hit.h;
				nextCache[path] = hit;
				continue;
			}

			const sha = await gitBlobSha(await this.adapter.readBinary(path));
			tree[path] = sha;
			nextCache[path] = { m: stat.mtime, s: stat.size, h: sha };
			hashed++;
			if (hashed % 50 === 0) progress("変更を確認中", i + 1, paths.length);
		}

		this.state.cache = nextCache;
		return tree;
	}

	/**
	 * baseline に未 push のコミットを重ねたもの。
	 *
	 * 「GitHub にあるか、こちらでコミット済みか」の状態を表す。変更リストは
	 * これとの差分を取るので、コミットした分はリストから消える（＝コミット前後が
	 * 見た目で区別できる）。
	 */
	async effectiveTree(): Promise<TreeMap> {
		const tree: TreeMap = { ...this.state.baseline };
		for (const commit of this.state.queue) {
			for (const [path, sha] of Object.entries(await this.commitShas(commit))) {
				tree[path] = sha;
			}
			for (const path of commit.deleted) delete tree[path];
		}
		return tree;
	}

	/** キューが SHA を持っていなければスナップショットから補って保存する。 */
	private async commitShas(commit: QueuedCommit): Promise<Record<string, string>> {
		if (commit.shas) return commit.shas;

		const snapshot = await this.store.loadSnapshot(commit.id);
		const shas: Record<string, string> = {};
		for (const path of commit.paths) {
			const base64 = snapshot[path];
			if (base64 !== undefined) {
				shas[path] = await gitBlobSha(new Uint8Array(base64ToArrayBuffer(base64)));
			}
		}
		commit.shas = shas;
		await this.save();
		return shas;
	}

	/** 走査済みのツリーを返す。まだ無ければ1回だけ全走査する。 */
	private async ensureLocalTree(progress: Progress = noop): Promise<TreeMap> {
		if (!this.localTree) this.localTree = await this.scanAll(progress);
		return this.localTree;
	}

	/** まだコミットしていない変更。コミット済みの分はここに出ない。 */
	async localChanges(progress: Progress = noop): Promise<Change[]> {
		return diffTrees(await this.effectiveTree(), await this.ensureLocalTree(progress));
	}

	/**
	 * 1ファイルの変更を取り込む。Vault のイベントから呼ぶ。
	 * 走査はせず、そのパスだけ読み直すので何度呼んでも軽い。
	 */
	async notePathChanged(path: string): Promise<void> {
		if (!this.localTree) return; // まだ走査していないなら次の全走査で拾われる
		if (isIgnoredPath(path, this.settings.ignore)) return;

		const stat = await this.adapter.stat(path).catch(() => null);
		if (!stat || stat.type !== "file") {
			delete this.localTree[path];
			delete this.state.cache[path];
			return;
		}

		const sha = await gitBlobSha(await this.adapter.readBinary(path));
		this.localTree[path] = sha;
		this.state.cache[path] = { m: stat.mtime, s: stat.size, h: sha };
	}

	/** キャッシュを捨てて全ファイルを読み直す。ズレを疑ったときの手動操作。 */
	async rescan(progress: Progress = noop): Promise<Change[]> {
		this.state.cache = {};
		this.localTree = null;
		const changes = await this.localChanges(progress);
		await this.save();
		return changes;
	}

	/** 変更のうち、実際にコミット対象になるもの（除外されていないもの）。 */
	selected(changes: Change[]): Change[] {
		const excluded = new Set(this.state.unstaged);
		return changes.filter((c) => !excluded.has(c.path));
	}

	// ---- ステージ ----------------------------------------------------------

	/** 除外リストを丸ごと差し替える（全選択・全解除用）。 */
	async setUnstaged(paths: string[]): Promise<void> {
		this.state.unstaged = [...new Set(paths)].sort();
		await this.save();
	}

	async toggle(path: string): Promise<void> {
		const excluded = new Set(this.state.unstaged);
		if (excluded.has(path)) excluded.delete(path);
		else excluded.add(path);
		await this.setUnstaged([...excluded]);
	}

	isSelected(path: string): boolean {
		return !this.state.unstaged.includes(path);
	}

	// ---- コミット（ローカル・ネットワーク不要） -----------------------------

	/**
	 * ステージ済みの変更を1コミットとしてキューに積む。
	 *
	 * このときファイルの内容をスナップショットとして保存する。そうしないと
	 * push までの間に加えた編集が、過去のコミットの中身として送られてしまう。
	 */
	async commit(message: string, progress: Progress = noop): Promise<void> {
		const changes = this.selected(await this.localChanges(progress));
		if (changes.length === 0) throw new Error("コミットするファイルが選ばれていません");

		const snapshot: CommitSnapshot = {};
		const shas: Record<string, string> = {};
		const paths: string[] = [];
		const deleted: string[] = [];

		for (const change of changes) {
			if (change.kind === "deleted") {
				deleted.push(change.path);
			} else {
				snapshot[change.path] = await vfs.readBase64(this.adapter, change.path);
				shas[change.path] = change.sha as string;
				paths.push(change.path);
			}
		}

		const id = this.state.nextCommitId++;
		await this.store.saveSnapshot(id, snapshot);
		this.state.queue.push({ id, message, ts: Date.now(), paths, deleted, shas });
		// コミットした分の除外指定はもう意味を持たない
		const committed = new Set(changes.map((c) => c.path));
		this.state.unstaged = this.state.unstaged.filter((p) => !committed.has(p));
		await this.save();
	}

	/**
	 * 未 push のコミットから指定パスを外す。paths 省略でコミットごと取り消す。
	 *
	 * 作業ツリーのファイルには触らない。実効ツリーから外れる結果、その分が
	 * 「未コミットの変更」として戻ってくる。
	 */
	async uncommit(id: number, paths?: string[]): Promise<void> {
		const index = this.state.queue.findIndex((c) => c.id === id);
		if (index < 0) return;

		const commit = this.state.queue[index];
		const target = new Set(paths ?? [...commit.paths, ...commit.deleted]);

		commit.paths = commit.paths.filter((p) => !target.has(p));
		commit.deleted = commit.deleted.filter((p) => !target.has(p));
		if (commit.shas) for (const path of target) delete commit.shas[path];

		if (commit.paths.length === 0 && commit.deleted.length === 0) {
			this.state.queue.splice(index, 1);
			await this.store.deleteSnapshot(commit.id);
		} else {
			const snapshot = await this.store.loadSnapshot(commit.id);
			for (const path of target) delete snapshot[path];
			await this.store.saveSnapshot(commit.id, snapshot);
		}
		await this.save();
	}

	// ---- push --------------------------------------------------------------

	/**
	 * キューを古い順に実コミットとして再生し、最後に1度だけ ref を進める。
	 * fast-forward でない場合は何も書き込まずに中断する。
	 */
	async push(progress: Progress = noop): Promise<number> {
		if (this.state.queue.length === 0) return 0;
		if (!this.state.headSha) throw new NotClonedError("まだ clone されていません");

		const remoteHead = await this.client.getBranchHead(this.state.branch);
		if (remoteHead !== this.state.headSha) {
			throw new NotFastForwardError(
				"リモートが先に進んでいます。先に pull してください。",
			);
		}

		let parent = this.state.headSha;
		let parentTree = await this.client.getCommitTreeSha(parent);
		const pushed = [...this.state.queue];

		// ref を進めるまでは GitHub 上に未参照のオブジェクトを作っているだけで、
		// ブランチの内容は変わらない。途中で失敗しても壊れない。
		const nextBaseline: TreeMap = { ...this.state.baseline };

		for (let i = 0; i < pushed.length; i++) {
			const commit = pushed[i];
			progress(`コミットを送信中 (${i + 1}/${pushed.length})`, i, pushed.length);

			const snapshot = await this.store.loadSnapshot(commit.id);
			const entries: { path: string; sha: string | null }[] = [];

			for (const path of commit.paths) {
				const base64 = snapshot[path];
				if (base64 === undefined) continue;
				const sha = await this.client.createBlob(base64);
				entries.push({ path, sha });
				nextBaseline[path] = sha;
			}
			for (const path of commit.deleted) {
				entries.push({ path, sha: null });
				delete nextBaseline[path];
			}

			parentTree = await this.client.createTree(parentTree, entries);
			parent = await this.client.createCommit(commit.message, parentTree, [parent]);
		}

		// ここで初めてブランチが動く。
		await this.client.updateBranch(this.state.branch, parent);

		for (const commit of pushed) await this.store.deleteSnapshot(commit.id);

		this.state.baseline = nextBaseline;
		this.state.headSha = parent;
		this.state.queue = [];
		await this.save();
		return pushed.length;
	}

	// ---- pull --------------------------------------------------------------

	/**
	 * リモートの変更を取り込む。
	 *
	 * マージはしない。リモートの変更が、こちらで触っているファイルと重なった
	 * 場合は何もせずに中断する（どちらを残すかの判断を勝手にしない）。
	 */
	async pull(progress: Progress = noop): Promise<Change[]> {
		if (!this.state.headSha) throw new NotClonedError("まだ clone されていません");

		const remoteHead = await this.client.getBranchHead(this.state.branch);
		if (!remoteHead) throw new Error(`ブランチ ${this.state.branch} がリモートにありません`);
		if (remoteHead === this.state.headSha) return [];

		progress("リモートのツリーを取得中");
		const remoteTree = await this.client.getFlatTree(remoteHead);
		const incoming = diffTrees(this.state.baseline, remoteTree);

		const touched = await this.touchedPaths(progress);
		const overlap = incoming.filter((c) => touched.has(c.path));
		if (overlap.length > 0) {
			throw new DirtyTreeError(
				`ローカルで編集中のファイルがリモートでも変更されています:\n` +
					overlap.slice(0, 10).map((c) => `・${c.path}`).join("\n"),
			);
		}

		await this.applyChanges(incoming, remoteTree, progress);
		this.state.headSha = remoteHead;
		await this.save();
		return incoming;
	}

	/** ローカルで手が入っているパス（未コミットの変更 + 未 push のコミット）。 */
	private async touchedPaths(progress: Progress): Promise<Set<string>> {
		const touched = new Set<string>();
		for (const change of await this.localChanges(progress)) touched.add(change.path);
		for (const commit of this.state.queue) {
			for (const path of commit.paths) touched.add(path);
			for (const path of commit.deleted) touched.add(path);
		}
		return touched;
	}

	// ---- clone -------------------------------------------------------------

	/**
	 * 空の vault にリポジトリの中身を展開する。
	 *
	 * ツリーの取得は1リクエスト。あとは blob を1件ずつ落として即書き込むので、
	 * メモリ使用量はファイル数に比例しない。既存ファイルは削除せず上書きのみ。
	 */
	async clone(branch: string, progress: Progress = noop): Promise<number> {
		const head = await this.client.getBranchHead(branch);
		if (!head) throw new Error(`ブランチ ${branch} がリモートにありません`);

		progress("ファイル一覧を取得中");
		const remoteTree = await this.client.getFlatTree(head);
		const incoming = diffTrees({}, remoteTree);

		await this.applyChanges(incoming, remoteTree, progress);

		this.state.branch = branch;
		this.state.headSha = head;
		this.state.unstaged = [];
		this.state.queue = [];
		await this.save();
		return incoming.length;
	}

	// ---- discard -----------------------------------------------------------

	/**
	 * 指定パスを実効ツリー（GitHub の内容 + コミット済みの内容）に戻す。
	 * どちらにも無いもの（新規追加）は削除する。
	 */
	async discard(paths: string[], progress: Progress = noop): Promise<void> {
		const target = await this.effectiveTree();

		for (let i = 0; i < paths.length; i++) {
			const path = paths[i];
			progress(`元に戻しています (${i + 1}/${paths.length})`, i, paths.length);

			const sha = target[path];
			if (sha === undefined) {
				await vfs.removeIfExists(this.adapter, path);
			} else {
				// コミット済みならスナップショットから復元できる（通信不要）
				const local = await this.queuedContent(path);
				const base64 = local ?? (await this.client.getBlobBase64(sha));
				await vfs.writeBase64(this.adapter, path, base64);
			}
			delete this.state.cache[path];
			if (this.localTree) {
				if (sha === undefined) delete this.localTree[path];
				else this.localTree[path] = sha;
			}
		}
		this.state.unstaged = this.state.unstaged.filter((p) => !paths.includes(p));
		await this.save();
	}

	/** 未 push のコミットが持っている内容。新しいコミットを優先する。 */
	private async queuedContent(path: string): Promise<string | null> {
		for (let i = this.state.queue.length - 1; i >= 0; i--) {
			const commit = this.state.queue[i];
			if (!commit.paths.includes(path)) continue;
			const snapshot = await this.store.loadSnapshot(commit.id);
			if (snapshot[path] !== undefined) return snapshot[path];
		}
		return null;
	}

	// ---- ブランチ ----------------------------------------------------------

	async listBranches(): Promise<BranchInfo[]> {
		return this.client.listBranches();
	}

	/** 現在のコミットから枝を作る。ツリーは同一なのでファイルは1つも動かない。 */
	async createBranch(name: string): Promise<void> {
		if (!this.state.headSha) throw new NotClonedError("まだ clone されていません");
		await this.client.createBranch(name, this.state.headSha);
		this.state.branch = name;
		await this.save();
	}

	async switchBranch(name: string, progress: Progress = noop): Promise<Change[]> {
		if (this.state.queue.length > 0) {
			throw new DirtyTreeError("未 push のコミットがあります。先に push してください。");
		}
		const changes = await this.localChanges(progress);
		if (changes.length > 0) {
			throw new DirtyTreeError(
				"未コミットの変更があります。コミットするか元に戻してから切り替えてください。",
			);
		}

		const head = await this.client.getBranchHead(name);
		if (!head) throw new Error(`ブランチ ${name} がリモートにありません`);

		progress("差分を計算中");
		const targetTree = await this.client.getFlatTree(head);
		const incoming = diffTrees(this.state.baseline, targetTree);

		await this.applyChanges(incoming, targetTree, progress);
		this.state.branch = name;
		this.state.headSha = head;
		await this.save();
		return incoming;
	}

	async deleteBranch(name: string): Promise<void> {
		if (name === this.state.branch) {
			throw new Error("今いるブランチは削除できません");
		}
		await this.client.deleteBranch(name);
	}

	// ---- 共通の適用処理 ----------------------------------------------------

	/**
	 * 差分をローカルに書き込む。1件ずつ取得して即書き込むので、
	 * まとめて読み込むことはしない（メモリを一定に保つため）。
	 */
	private async applyChanges(
		changes: Change[],
		resultTree: TreeMap,
		progress: Progress,
	): Promise<void> {
		const writes = changes.filter((c) => c.kind !== "deleted");
		const deletes = changes.filter((c) => c.kind === "deleted");
		let done = 0;

		await mapLimit(writes, FETCH_CONCURRENCY, async (change) => {
			const base64 = await this.client.getBlobBase64(change.sha as string);
			await vfs.writeBase64(this.adapter, change.path, base64);
			delete this.state.cache[change.path];
			if (this.localTree) this.localTree[change.path] = change.sha as string;
			done++;
			if (done % 20 === 0 || done === writes.length) {
				progress("ファイルを取得中", done, writes.length);
			}
		});

		for (const change of deletes) {
			await vfs.removeIfExists(this.adapter, change.path);
			delete this.state.cache[change.path];
			if (this.localTree) delete this.localTree[change.path];
		}

		this.state.baseline = { ...resultTree };
	}
}

/** 同時実行数を絞って走らせる。iOS で一度に大量の通信を投げないため。 */
async function mapLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			await fn(items[index]);
		}
	});
	await Promise.all(workers);
}
