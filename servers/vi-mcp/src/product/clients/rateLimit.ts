/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import type { AxiosResponse } from 'axios';
import { log } from '@/utils/logger';

/**
 * Bounded retry for rate-limited product REST responses.
 *
 * A short wait is retried so a brief burst does not surface as an error. A long one is returned
 * at once, so a call is never held for minutes: the caller gets the 429 and how long to wait.
 * A 503 is retried only when it says how long to wait.
 */
export const RATE_LIMIT_RETRY = {
    /** Retries after the first attempt. */
    maxRetries: 2,
    /** Longest single wait. A longer requested wait is not waited for. */
    maxWaitMs: 10_000,
    /** Longest total wait across the retries of one request. */
    maxTotalWaitMs: 20_000,
    /** Backoff for the first retry when the response does not say how long to wait; doubles each retry. */
    baseBackoffMs: 1_000,
};

/** Parses a Retry-After value (seconds or an HTTP date) into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value >= 0 ? Math.ceil(value * 1000) : undefined;
    }
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
    // Otherwise it must be an HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT").
    if (!/[a-z]/i.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    return Math.max(0, date - now);
}

/**
 * How long the response asks us to wait, in milliseconds: the Retry-After header, or the
 * `retryAfter` property (seconds) that Veeam Service Provider Console puts in a 429 body.
 */
export function retryAfterMsOf(response: Pick<AxiosResponse, 'headers' | 'data'>, now: number = Date.now()): number | undefined {
    const headers = response.headers as Record<string, unknown> | undefined;
    const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const fromHeader = parseRetryAfter(header, now);
    if (fromHeader !== undefined) return fromHeader;
    const data = response.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
        return parseRetryAfter(data.retryAfter ?? (data.error as Record<string, unknown> | undefined)?.retryAfter, now);
    }
    return undefined;
}

/** Whole seconds to wait (at least 1), or undefined when the response does not say. */
export function retryAfterSecondsOf(response: Pick<AxiosResponse, 'headers' | 'data'>): number | undefined {
    const ms = retryAfterMsOf(response);
    return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

export function isRateLimited(response: Pick<AxiosResponse, 'status' | 'headers' | 'data'>): boolean {
    return response.status === 429 || (response.status === 503 && retryAfterMsOf(response) !== undefined);
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based), or undefined when the request
 * should not be retried.
 */
export function retryDelayMs(
    attempt: number,
    retryAfterMs: number | undefined,
    waitedMs: number,
    random: () => number = Math.random,
): number | undefined {
    if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
    const delay = retryAfterMs ?? RATE_LIMIT_RETRY.baseBackoffMs * 2 ** attempt + Math.floor(random() * 250);
    if (delay > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
    if (waitedMs + delay > RATE_LIMIT_RETRY.maxTotalWaitMs) return undefined;
    return delay;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a request (with `validateStatus: () => true`) with the bounded retry above. Returns the
 * last response, which may still be a 429 for the caller to report.
 */
export async function sendWithRateLimitRetry<T>(send: () => Promise<AxiosResponse<T>>, label: string): Promise<AxiosResponse<T>> {
    let response = await send();
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
        if (!isRateLimited(response)) return response;
        const delay = retryDelayMs(attempt, retryAfterMsOf(response), waitedMs);
        if (delay === undefined) return response;
        log.warn(`Rate limited (HTTP ${response.status}) on ${label}; retrying in ${delay} ms`);
        await sleep(delay);
        waitedMs += delay;
        response = await send();
    }
}

/** Error text for a response that is still rate-limited after the retries. */
export function rateLimitMessage(response: Pick<AxiosResponse, 'status' | 'headers' | 'data'>): string {
    const seconds = retryAfterSecondsOf(response);
    return (
        `Rate limited by the Veeam product REST API (HTTP ${response.status}).` +
        (seconds !== undefined ? ` Try again in ${seconds} s.` : ' Try again in a minute.')
    );
}
