import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineDecoder, parseRpcLine } from "../src/core/rpcProtocol.js";

test("JSONL decoder preserves UTF-8 across chunks and accepts CRLF", () => {
	const decoder = new JsonLineDecoder();
	const bytes = Buffer.from('{"text":"héllo"}\r\n{"n":2}\n', "utf8");
	const split = bytes.indexOf(Buffer.from("é")) + 1;
	assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
	const lines = decoder.push(bytes.subarray(split));
	assert.deepEqual(lines, ['{"text":"héllo"}\r', '{"n":2}']);
	assert.deepEqual(lines.map(parseRpcLine), [{ text: "héllo" }, { n: 2 }]);
	assert.deepEqual(decoder.end(), []);
});

test("JSONL decoder splits on LF only", () => {
	const decoder = new JsonLineDecoder();
	assert.deepEqual(decoder.push('{"text":"a b"}\n'), ['{"text":"a b"}']);
});

test("JSONL decoder rejects unbounded and incomplete lines", () => {
	assert.throws(() => new JsonLineDecoder(4).push("12345"), /exceeds 4/);
	const decoder = new JsonLineDecoder();
	decoder.push('{"unfinished":true}');
	assert.throws(() => decoder.end(), /incomplete JSONL line/);
});

test("blank frames and non-object RPC lines are rejected", () => {
	const decoder = new JsonLineDecoder();
	assert.deepEqual(decoder.push("\n"), [""]);
	assert.throws(() => parseRpcLine(""), /Unexpected end of JSON input/);
	assert.throws(() => parseRpcLine("[]"), /JSON object/);
	assert.throws(() => parseRpcLine("null"), /JSON object/);
});
