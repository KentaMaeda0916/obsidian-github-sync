import { requestUrl, RequestUrlResponse } from "obsidian";

/** path -> blob SHA。ツリーを平坦化したもの。state の baseline と同じ形。 */
export type TreeMap = Record<string, string>;

export interface RepoRef {
	owner: string;
	repo: string;
}

export interface BranchInfo {
	name: string;
	sha: string;
}

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}

export class GitHubApiError extends Error {
	constructor(readonly status: number, message: string, readonly body = "") {
		super(message);
		this.name = "GitHubApiError";
	}
}

/**
 * リポジトリ自体に到達できない。名前の間違い、GitHub App が install されていない、
 * 権限不足のいずれか。GitHub はどれも 404 で返すので、これ以上の特定はできない。
 */
export class RepoUnreachableError extends Error {}

/** 401 を受けたときにトークンを取り直すための供給元。 */
export interface TokenSource {
	getAccessToken(): Promise<string>;
	forceRefresh(): Promise<string>;
}

const API = "https://api.github.com";
const RETRYABLE = new Set([500, 502, 503, 504]);

export class GitHubClient {
	constructor(
		private readonly repo: RepoRef,
		private readonly tokens: TokenSource,
	) {}

	// ---- 低レベル ----------------------------------------------------------

	private async request(
		method: string,
		path: string,
		body?: unknown,
		retriesLeft = 3,
		didRefresh = false,
	): Promise<RequestUrlResponse> {
		const token = await this.tokens.getAccessToken();
		const res = await requestUrl({
			url: path.startsWith("http") ? path : `${API}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			throw: false,
		});

		if (res.status === 401 && !didRefresh) {
			// アクセストークンが切れている。1度だけ取り直して再試行する。
			await this.tokens.forceRefresh();
			return this.request(method, path, body, retriesLeft, true);
		}

		if ((RETRYABLE.has(res.status) || res.status === 429) && retriesLeft > 0) {
			await sleep(backoffMs(4 - retriesLeft, res));
			return this.request(method, path, body, retriesLeft - 1, didRefresh);
		}

		if (res.status >= 400) {
			throw new GitHubApiError(res.status, describe(res, method, path), res.text ?? "");
		}
		return res;
	}

	private async get<T>(path: string): Promise<T> {
		return (await this.request("GET", path)).json as T;
	}

	private get base(): string {
		return `/repos/${this.repo.owner}/${this.repo.repo}`;
	}

	// ---- refs --------------------------------------------------------------

	/**
	 * ブランチの先頭コミット SHA。ブランチが無ければ null。
	 *
	 * リポジトリに到達できない場合は RepoUnreachableError。ref の 404 だけでは
	 * この2つを区別できないため（GitHub はプライベートリポジトリの存在を隠すため
	 * 403 ではなく 404 を返す）、404 のときはリポジトリ自体を引いて確かめる。
	 * これをしないと「App を install していない」が「ブランチが無い」に化ける。
	 */
	async getBranchHead(branch: string): Promise<string | null> {
		try {
			const ref = await this.get<{ object: { sha: string } }>(
				`${this.base}/git/ref/heads/${refPath(branch)}`,
			);
			return ref.object.sha;
		} catch (e) {
			if (e instanceof GitHubApiError && e.status === 404) {
				await this.assertRepoReachable();
				return null;
			}
			throw e;
		}
	}

	/** リポジトリが読めることを確かめる。読めなければ RepoUnreachableError。 */
	async assertRepoReachable(): Promise<void> {
		try {
			await this.get<unknown>(this.base);
		} catch (e) {
			if (e instanceof GitHubApiError && (e.status === 404 || e.status === 403)) {
				throw new RepoUnreachableError(
					`リポジトリ ${this.repo.owner}/${this.repo.repo} にアクセスできません。` +
						"次を確認してください:\n" +
						"・設定の owner / repo が正しいか（Organization のリポジトリなら owner は Organization 名）\n" +
						"・GitHub App をこのリポジトリに install しているか\n" +
						"・App の Repository permissions で Contents が Read and write か（後から変えた場合は再接続が必要）",
				);
			}
			throw e;
		}
	}

	async listBranches(): Promise<BranchInfo[]> {
		const out: BranchInfo[] = [];
		for (let page = 1; ; page++) {
			const batch = await this.get<{ name: string; commit: { sha: string } }[]>(
				`${this.base}/branches?per_page=100&page=${page}`,
			);
			out.push(...batch.map((b) => ({ name: b.name, sha: b.commit.sha })));
			if (batch.length < 100) return out;
		}
	}

	async createBranch(branch: string, sha: string): Promise<void> {
		await this.request("POST", `${this.base}/git/refs`, {
			ref: `refs/heads/${branch}`,
			sha,
		});
	}

	async deleteBranch(branch: string): Promise<void> {
		await this.request("DELETE", `${this.base}/git/refs/heads/${refPath(branch)}`);
	}

	/**
	 * ブランチの先頭を進める。force は既定で false なので、リモートが先に
	 * 進んでいる場合は 422 で弾かれる（＝ fast-forward でないと通らない）。
	 */
	async updateBranch(branch: string, sha: string, force = false): Promise<void> {
		await this.request("PATCH", `${this.base}/git/refs/heads/${refPath(branch)}`, {
			sha,
			force,
		});
	}

	// ---- objects -----------------------------------------------------------

	async getCommitTreeSha(commitSha: string): Promise<string> {
		const c = await this.get<{ tree: { sha: string } }>(`${this.base}/git/commits/${commitSha}`);
		return c.tree.sha;
	}

	/**
	 * コミットの内容を path -> blobSHA の平坦なマップで返す。
	 * サブモジュール（type: "commit"）とディレクトリは落とす。
	 */
	async getFlatTree(commitSha: string): Promise<TreeMap> {
		const treeSha = await this.getCommitTreeSha(commitSha);
		const res = await this.get<{ tree: TreeEntry[]; truncated: boolean }>(
			`${this.base}/git/trees/${treeSha}?recursive=1`,
		);
		if (res.truncated) {
			throw new Error(
				"リポジトリが大きすぎてツリーを一度に取得できませんでした（GitHub の truncated 応答）。",
			);
		}
		const map: TreeMap = {};
		for (const e of res.tree) {
			if (e.type === "blob") map[e.path] = e.sha;
		}
		return map;
	}

	/** blob の中身を取得する。戻り値は base64。 */
	async getBlobBase64(sha: string): Promise<string> {
		const b = await this.get<{ content: string; encoding: string }>(
			`${this.base}/git/blobs/${sha}`,
		);
		if (b.encoding !== "base64") {
			throw new Error(`想定外の blob encoding: ${b.encoding}`);
		}
		// GitHub は 60 文字ごとに改行を入れて返す
		return b.content.replace(/\n/g, "");
	}

	async createBlob(base64: string): Promise<string> {
		const res = await this.request("POST", `${this.base}/git/blobs`, {
			content: base64,
			encoding: "base64",
		});
		return (res.json as { sha: string }).sha;
	}

	/**
	 * base_tree からの差分でツリーを作る。sha に null を渡すとそのパスを削除する。
	 * 差分だけを送れるので、変更ファイル数に比例したコストで済む。
	 */
	async createTree(
		baseTree: string,
		changes: { path: string; sha: string | null }[],
	): Promise<string> {
		const res = await this.request("POST", `${this.base}/git/trees`, {
			base_tree: baseTree,
			tree: changes.map((c) => ({
				path: c.path,
				mode: "100644",
				type: "blob",
				sha: c.sha,
			})),
		});
		return (res.json as { sha: string }).sha;
	}

	async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
		const res = await this.request("POST", `${this.base}/git/commits`, {
			message,
			tree,
			parents,
		});
		return (res.json as { sha: string }).sha;
	}
}

/**
 * ブランチ名を ref パスに変換する。
 *
 * スラッシュはそのまま残す。feature/foo は refs/heads/feature/foo という
 * 階層のある ref なので、%2F にすると GitHub 側で解決できず 404 になる。
 */
function refPath(branch: string): string {
	return branch.split("/").map(encodeURIComponent).join("/");
}

function describe(res: RequestUrlResponse, method: string, path: string): string {
	let detail = "";
	try {
		const j = res.json as { message?: string } | undefined;
		if (j?.message) detail = `: ${j.message}`;
	} catch {
		// JSON でない応答は無視して status だけ伝える
	}
	return `GitHub API ${method} ${path} が ${res.status} を返しました${detail}`;
}

function backoffMs(attempt: number, res: RequestUrlResponse): number {
	const retryAfter = Number(res.headers?.["retry-after"] ?? res.headers?.["Retry-After"]);
	if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
	return Math.min(1000 * 2 ** attempt, 8000);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
