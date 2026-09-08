import type { DataAdapter } from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import { gitBlobSha } from "./hash";
import type { TreeMap } from "./github";

/** ignore の接頭辞に当たるパスか。 */
export function isIgnored(path: string, ignore: string[]): boolean {
	return ignore.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * vault 内の全ファイルを列挙する。
 *
 * Vault#getFiles() ではなく DataAdapter を歩くのは、Obsidian が認識しない
 * 拡張子やドットファイルも git の対象になるため。
 */
export async function listVaultFiles(adapter: DataAdapter, ignore: string[]): Promise<string[]> {
	const out: string[] = [];
	const queue = [""];

	while (queue.length > 0) {
		const dir = queue.pop() as string;
		const listed = await adapter.list(dir);
		for (const f of listed.files) {
			if (!isIgnored(f, ignore)) out.push(f);
		}
		for (const d of listed.folders) {
			if (!isIgnored(d, ignore)) queue.push(d);
		}
	}

	out.sort();
	return out;
}

/** 指定パスの blob SHA を求める。存在しないファイルは結果に含めない。 */
export async function hashPaths(adapter: DataAdapter, paths: string[]): Promise<TreeMap> {
	const map: TreeMap = {};
	for (const path of paths) {
		if (!(await adapter.exists(path))) continue;
		const buf = await adapter.readBinary(path);
		map[path] = await gitBlobSha(buf);
	}
	return map;
}

/**
 * vault 全体の path -> blobSHA を作る。
 *
 * 全ファイルを読んでハッシュするので**重い**。起動のたびには実行せず、
 * clone 直後と明示的な再スキャンでのみ呼ぶこと。日常の変更検出は
 * Vault のイベントで拾った差分パスだけを hashPaths に渡す。
 */
export async function computeFullTree(adapter: DataAdapter, ignore: string[]): Promise<TreeMap> {
	return hashPaths(adapter, await listVaultFiles(adapter, ignore));
}

export async function readBase64(adapter: DataAdapter, path: string): Promise<string> {
	return arrayBufferToBase64(await adapter.readBinary(path));
}

export async function writeBase64(
	adapter: DataAdapter,
	path: string,
	base64: string,
): Promise<void> {
	await ensureParent(adapter, path);
	await adapter.writeBinary(path, base64ToArrayBuffer(base64));
}

export async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> {
	if (await adapter.exists(path)) await adapter.remove(path);
}

/** 書き込み先の親フォルダを掘る。深い階層でも1段ずつ作る。 */
export async function ensureParent(adapter: DataAdapter, path: string): Promise<void> {
	const parts = path.split("/");
	parts.pop();
	let dir = "";
	for (const part of parts) {
		dir = dir === "" ? part : `${dir}/${part}`;
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
	}
}
