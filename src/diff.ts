import type { TreeMap } from "./github";

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
	path: string;
	kind: ChangeKind;
	/** 変更後の blob SHA。deleted のときは null。 */
	sha: string | null;
}

/**
 * 2つの path -> blobSHA マップの差分を取る。
 *
 * pull・ブランチ切替・clone・ローカル変更の検出が、すべてこの1関数に集約される。
 * clone は「空のマップ」との差分でしかない。
 */
export function diffTrees(from: TreeMap, to: TreeMap): Change[] {
	const changes: Change[] = [];

	for (const path of Object.keys(to)) {
		const before = from[path];
		if (before === undefined) changes.push({ path, kind: "added", sha: to[path] });
		else if (before !== to[path]) changes.push({ path, kind: "modified", sha: to[path] });
	}
	for (const path of Object.keys(from)) {
		if (to[path] === undefined) changes.push({ path, kind: "deleted", sha: null });
	}

	changes.sort((a, b) => a.path.localeCompare(b.path));
	return changes;
}
