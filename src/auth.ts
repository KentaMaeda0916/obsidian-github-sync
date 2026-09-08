import { requestUrl } from "obsidian";
import type { TokenSource } from "./github";

/**
 * GitHub App の OAuth Device Flow。
 *
 * device flow は client secret を必要としない（公開情報の client_id だけで完結する）。
 * さらに GitHub は「device flow で発行したトークンはリフレッシュにも client secret が
 * 不要」としているため、サーバーを1台も持たずに「短命トークン + 自動更新」が成立する。
 * PAT を端末に置かずに済むのはこの性質による。
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** 期限切れ扱いにする余裕。通信中に切れるのを避ける。 */
const EXPIRY_MARGIN_MS = 60_000;

export interface StoredAuth {
	accessToken: string;
	/** 失効しないトークン設定の App では空になる。 */
	refreshToken: string;
	/** epoch ms。0 は無期限。 */
	expiresAt: number;
	refreshExpiresAt: number;
}

export interface DeviceCodeStart {
	deviceCode: string;
	/** ユーザーが github.com/login/device に入力する8桁のコード。 */
	userCode: string;
	verificationUri: string;
	/** ポーリング間隔（秒）。 */
	interval: number;
	expiresAt: number;
}

export class DeviceFlowError extends Error {}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	error?: string;
	error_description?: string;
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenResponse> {
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(params).toString(),
		throw: false,
	});
	if (res.status >= 400 && res.status !== 401) {
		throw new DeviceFlowError(`GitHub が ${res.status} を返しました`);
	}
	return res.json as TokenResponse;
}

/** 認証を開始し、ユーザーに見せるコードを得る。 */
export async function startDeviceFlow(clientId: string): Promise<DeviceCodeStart> {
	// GitHub App では scope を送らない（権限は App 側の設定で決まる）
	const res = (await postForm(DEVICE_CODE_URL, { client_id: clientId })) as TokenResponse & {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		interval?: number;
	};

	if (res.error || !res.device_code || !res.user_code) {
		throw new DeviceFlowError(
			res.error_description ??
				res.error ??
				"デバイスコードを取得できませんでした。GitHub App で Device Flow が有効か確認してください。",
		);
	}

	return {
		deviceCode: res.device_code,
		userCode: res.user_code,
		verificationUri: res.verification_uri ?? "https://github.com/login/device",
		interval: res.interval ?? 5,
		expiresAt: Date.now() + (res.expires_in ?? 900) * 1000,
	};
}

/**
 * ユーザーが承認するまでポーリングする。
 * GitHub の指示どおり slow_down では間隔を伸ばす（無視すると弾かれる）。
 */
export async function pollDeviceFlow(
	clientId: string,
	start: DeviceCodeStart,
	shouldCancel: () => boolean = () => false,
): Promise<StoredAuth> {
	let intervalMs = start.interval * 1000;

	for (;;) {
		if (shouldCancel()) throw new DeviceFlowError("認証をキャンセルしました");
		if (Date.now() > start.expiresAt) {
			throw new DeviceFlowError("コードの有効期限が切れました。最初からやり直してください。");
		}

		await sleep(intervalMs);

		const res = await postForm(TOKEN_URL, {
			client_id: clientId,
			device_code: start.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});

		if (res.access_token) return toStoredAuth(res);

		switch (res.error) {
			case "authorization_pending":
				break;
			case "slow_down":
				intervalMs += 5000;
				break;
			case "expired_token":
				throw new DeviceFlowError("コードの有効期限が切れました。最初からやり直してください。");
			case "access_denied":
				throw new DeviceFlowError("承認が拒否されました。");
			default:
				throw new DeviceFlowError(res.error_description ?? res.error ?? "認証に失敗しました");
		}
	}
}

/** device flow で取ったトークンは client secret 無しで更新できる。 */
export async function refreshTokens(clientId: string, refreshToken: string): Promise<StoredAuth> {
	const res = await postForm(TOKEN_URL, {
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	if (!res.access_token) {
		throw new DeviceFlowError(
			res.error_description ?? res.error ?? "トークンを更新できませんでした",
		);
	}
	return toStoredAuth(res);
}

function toStoredAuth(res: TokenResponse): StoredAuth {
	const now = Date.now();
	return {
		accessToken: res.access_token ?? "",
		refreshToken: res.refresh_token ?? "",
		expiresAt: res.expires_in ? now + res.expires_in * 1000 : 0,
		refreshExpiresAt: res.refresh_token_expires_in
			? now + res.refresh_token_expires_in * 1000
			: 0,
	};
}

/**
 * 保存済みトークンを持ち、必要になったら黙って更新する。
 * GitHubClient にはこれを TokenSource として渡す。
 */
export class AuthManager implements TokenSource {
	private inFlight: Promise<string> | null = null;

	constructor(
		private clientId: string,
		private auth: StoredAuth | null,
		private readonly persist: (auth: StoredAuth | null) => Promise<void>,
	) {}

	get isAuthenticated(): boolean {
		return this.auth !== null && this.auth.accessToken !== "";
	}

	setClientId(clientId: string): void {
		this.clientId = clientId;
	}

	async signIn(auth: StoredAuth): Promise<void> {
		this.auth = auth;
		await this.persist(auth);
	}

	async signOut(): Promise<void> {
		this.auth = null;
		await this.persist(null);
	}

	async getAccessToken(): Promise<string> {
		if (!this.auth) throw new DeviceFlowError("GitHub に接続されていません");
		const expired = this.auth.expiresAt !== 0 && Date.now() > this.auth.expiresAt - EXPIRY_MARGIN_MS;
		if (!expired) return this.auth.accessToken;
		return this.forceRefresh();
	}

	/** 同時に複数のリクエストが 401 を受けても、更新は1回にまとめる。 */
	async forceRefresh(): Promise<string> {
		if (this.inFlight) return this.inFlight;

		this.inFlight = (async () => {
			if (!this.auth?.refreshToken) {
				throw new DeviceFlowError(
					"再認証が必要です。設定から GitHub に接続し直してください。",
				);
			}
			const next = await refreshTokens(this.clientId, this.auth.refreshToken);
			this.auth = next;
			await this.persist(next);
			return next.accessToken;
		})();

		try {
			return await this.inFlight;
		} finally {
			this.inFlight = null;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
