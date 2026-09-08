/**
 * git のオブジェクト ID を計算する。
 *
 * git の blob SHA は本文そのものではなく `blob <byte長>\0<本文>` のハッシュ。
 * これをローカルで出せることが本プラグインの前提になっている。ファイルが
 * GitHub 上の内容と一致するかを、ネットワークにも .git にも触れずに判定できる。
 */

/** `blob <len>\0<data>` の SHA-1 を 40 桁の16進で返す。 */
export async function gitBlobSha(data: ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
	const full = new Uint8Array(header.length + bytes.length);
	full.set(header, 0);
	full.set(bytes, header.length);
	return sha1(full);
}

async function sha1(bytes: Uint8Array): Promise<string> {
	// WebCrypto が使えるならそちらが速い。iOS の WKWebView でも secure context
	// なら使えるが、環境に依存させたくないので失敗したら JS 実装に落とす。
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		try {
			const buf = await subtle.digest("SHA-1", bytes as unknown as BufferSource);
			return toHex(new Uint8Array(buf));
		} catch {
			// 下の JS 実装にフォールバック
		}
	}
	return sha1Js(bytes);
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

function rotl(n: number, s: number): number {
	return ((n << s) | (n >>> (32 - s))) >>> 0;
}

/** SHA-1 の素朴な実装。WebCrypto が使えない環境向けのフォールバック。 */
function sha1Js(msg: Uint8Array): string {
	const ml = msg.length;
	// 末尾に 0x80 と 8 バイトの長さを足して 64 の倍数に揃える
	const total = (((ml + 8) >> 6) << 6) + 64;
	const buf = new Uint8Array(total);
	buf.set(msg);
	buf[ml] = 0x80;

	const view = new DataView(buf.buffer);
	const bitLen = ml * 8;
	view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
	view.setUint32(total - 4, bitLen >>> 0);

	let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);

	for (let off = 0; off < total; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

		let a = h0, b = h1, c = h2, d = h3, e = h4;
		for (let i = 0; i < 80; i++) {
			let f: number, k: number;
			if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
			else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
			else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
			else { f = b ^ c ^ d; k = 0xca62c1d6; }

			const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
			e = d; d = c; c = rotl(b, 30); b = a; a = t;
		}
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
	}

	return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, "0")).join("");
}
