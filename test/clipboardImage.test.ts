import assert from "node:assert/strict";
import test from "node:test";
import { decodePngBase64 } from "../src/clipboardImage.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("decodePngBase64 accepts PNG bytes", () => {
	assert.deepEqual(Buffer.from(decodePngBase64(PNG_SIGNATURE.toString("base64"))), PNG_SIGNATURE);
});

test("decodePngBase64 rejects empty and non-PNG clipboard data", () => {
	assert.throws(() => decodePngBase64(""), /does not contain an image/);
	assert.throws(() => decodePngBase64(Buffer.from("not png").toString("base64")), /converted to PNG/);
});
