/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { describe, it, expect } from '@jest/globals';

import { isRateLimited, parseRetryAfter, retryAfterMsOf, retryDelayMs, RATE_LIMIT_RETRY } from '../rateLimit';

describe('parseRetryAfter', () => {
    it('reads seconds, numbers and HTTP dates', () => {
        const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
        expect(parseRetryAfter('5')).toBe(5000);
        expect(parseRetryAfter(' 1.5 ')).toBe(1500);
        expect(parseRetryAfter(3)).toBe(3000);
        expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', now)).toBe(10_000);
    });

    it('ignores missing or invalid values', () => {
        expect(parseRetryAfter(undefined)).toBeUndefined();
        expect(parseRetryAfter('')).toBeUndefined();
        expect(parseRetryAfter('-1')).toBeUndefined();
        expect(parseRetryAfter(-1)).toBeUndefined();
        expect(parseRetryAfter('later')).toBeUndefined();
    });
});

describe('retryAfterMsOf', () => {
    it('prefers the header and falls back to the body retryAfter', () => {
        expect(retryAfterMsOf({ headers: { 'retry-after': '2' }, data: { retryAfter: 9 } })).toBe(2000);
        expect(retryAfterMsOf({ headers: {}, data: { retryAfter: 9 } })).toBe(9000);
        expect(retryAfterMsOf({ headers: {}, data: 'not json' })).toBeUndefined();
    });
});

describe('isRateLimited', () => {
    const r = (status: number, headers: Record<string, string> = {}) => ({ status, headers, data: {} });

    it('retries a 429 for any method', () => {
        expect(isRateLimited(r(429), 'GET')).toBe(true);
        expect(isRateLimited(r(429), 'POST')).toBe(true);
    });

    it('retries a 503 with a wait only for read-only methods', () => {
        expect(isRateLimited(r(503, { 'retry-after': '1' }), 'get')).toBe(true);
        expect(isRateLimited(r(503, { 'retry-after': '1' }), 'POST')).toBe(false);
        expect(isRateLimited(r(503, { 'retry-after': '1' }), 'PATCH')).toBe(false);
        expect(isRateLimited(r(503), 'GET')).toBe(false);
    });
});

describe('retryDelayMs', () => {
    it('backs off when no wait is given, and stops after the retry limit', () => {
        expect(retryDelayMs(0, undefined, 0, () => 0)).toBe(RATE_LIMIT_RETRY.baseBackoffMs);
        expect(retryDelayMs(1, undefined, 0, () => 0)).toBe(RATE_LIMIT_RETRY.baseBackoffMs * 2);
        expect(retryDelayMs(RATE_LIMIT_RETRY.maxRetries, 0, 0)).toBeUndefined();
    });

    it('never waits longer than the single or total cap', () => {
        expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs + 1, 0)).toBeUndefined();
        expect(retryDelayMs(1, 10_000, 15_000)).toBeUndefined();
        expect(retryDelayMs(0, 10_000, 0)).toBe(10_000);
    });
});
