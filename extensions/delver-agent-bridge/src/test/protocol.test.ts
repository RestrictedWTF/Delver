/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { DELVER_DTP_MAX_MESSAGE_BYTES, DtpErrorCode, DtpFrameDecoder, DtpProtocolError, encodeDtpMessage, parseDtpRequest } from '../protocol';

describe('Delver DTP framing', () => {
	it('decodes fragmented and adjacent messages', () => {
		const first = encodeDtpMessage({ id: 1, result: { ready: true } });
		const second = encodeDtpMessage({ id: 2, result: null });
		const decoder = new DtpFrameDecoder();

		assert.deepStrictEqual(decoder.push(first.subarray(0, 7)), []);
		const frames = decoder.push(Buffer.concat([first.subarray(7), second]));
		assert.deepStrictEqual(frames.map(frame => JSON.parse(frame.toString('utf8'))), [
			{ id: 1, result: { ready: true } },
			{ id: 2, result: null },
		]);
	});

	it('rejects malformed and oversized frames', () => {
		const malformed = new DtpFrameDecoder();
		assert.throws(() => malformed.push(Buffer.from('Content-Length: nope\r\n\r\n')), (error: unknown) => {
			return error instanceof DtpProtocolError && error.code === DtpErrorCode.InvalidRequest;
		});

		const oversized = new DtpFrameDecoder();
		assert.throws(() => oversized.push(Buffer.from(`Content-Length: ${DELVER_DTP_MAX_MESSAGE_BYTES + 1}\r\n\r\n`)), (error: unknown) => {
			return error instanceof DtpProtocolError && error.code === DtpErrorCode.RequestTooLarge;
		});
	});

	it('accepts only bounded request envelopes', () => {
		assert.deepStrictEqual(parseDtpRequest(Buffer.from('{"id":3,"method":"agent/capabilities"}')), {
			id: 3,
			method: 'agent/capabilities',
			params: {},
		});
		assert.throws(() => parseDtpRequest(Buffer.from('{"id":-1,"method":"x"}')), (error: unknown) => {
			return error instanceof DtpProtocolError && error.code === DtpErrorCode.InvalidRequest;
		});
	});
});
