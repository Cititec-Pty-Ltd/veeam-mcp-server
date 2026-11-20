/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { VspcRestClient } from '../VspcRestClient';
import { ProductRestClientConfig } from '../types';

const BASE_URL = 'https://vspc-srv.local:1280/';
const API_KEY = 'example-api-key-0123456789abcdef';
const PASSWORD = 'example-password-not-real';

type Reply = { status: number; data?: unknown; headers?: Record<string, string> } | Error;

interface SentRequest {
    method: string;
    url: string;
    authorization?: string;
}

/** A VspcRestClient whose HTTP calls are answered by `replies` (in order) instead of the network. */
function createClient(overrides: Partial<ProductRestClientConfig>, replies: Reply[]) {
    const config: ProductRestClientConfig = {
        baseURL: BASE_URL,
        username: '',
        password: '',
        acceptSelfSignedCert: false,
        ...overrides,
    };
    const client = new VspcRestClient(config);
    const sent: SentRequest[] = [];
    const queue = [...replies];

    (client as any).client.defaults.adapter = async (req: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const headers = req.headers as any;
        sent.push({
            method: String(req.method).toUpperCase(),
            url: String(req.url),
            authorization: headers?.Authorization ?? headers?.get?.('Authorization'),
        });
        const reply = queue.shift();
        if (!reply) throw new Error('unexpected request');
        if (reply instanceof Error) throw reply;
        const response: AxiosResponse = {
            status: reply.status,
            statusText: String(reply.status),
            data: reply.data ?? {},
            headers: reply.headers ?? {},
            config: req,
        };
        const validate = req.validateStatus;
        if (validate && !validate(reply.status)) {
            const err: any = new Error(`Request failed with status code ${reply.status}`);
            err.isAxiosError = true;
            err.response = response;
            err.config = req;
            throw err;
        }
        return response;
    };

    return { client, sent };
}

const SERVICE_INFO = { chatBotApiUrl: 'https://vi.example.invalid/', chatbotEnabled: true };

describe('VspcRestClient authentication', () => {
    beforeEach(() => {
        jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('sends the API key as the bearer token and never requests a token', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 200, data: SERVICE_INFO },
            { status: 200, data: SERVICE_INFO },
        ]);

        const info = await client.getServiceInfo();
        await client.getServiceInfo();

        expect(info.chatbotApiUrl).toBe('https://vi.example.invalid/');
        expect(sent.map((r) => r.url).some((u) => u.includes('/api/v3/token'))).toBe(false);
        expect(sent.every((r) => r.authorization === `Bearer ${API_KEY}`)).toBe(true);
    });

    it('keeps the username and password token flow when no API key is set', async () => {
        const { client, sent } = createClient({ username: 'svc-reader', password: PASSWORD }, [
            { status: 200, data: { access_token: 'session-token', expires_in: 3600, token_type: 'Bearer' } },
            { status: 200, data: SERVICE_INFO },
        ]);

        await client.getServiceInfo();

        expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://vspc-srv.local:1280/api/v3/token' });
        expect(sent[1].authorization).toBe('Bearer session-token');
    });

    it('reports a rejected API key without including the key', async () => {
        const { client } = createClient({ apiKey: API_KEY }, [
            { status: 401, data: { error: 'unauthorized' } },
            { status: 401, data: { error: 'unauthorized' } },
        ]);

        const err = (await client.getServiceInfo().catch((e: Error) => e)) as Error;

        expect(err.message).toContain('401');
        expect(err.message).toContain('VSPC_API_KEY');
        expect(err.message).not.toContain(API_KEY);
    });

    it('redacts the API key from network error messages', async () => {
        const { client } = createClient({ apiKey: API_KEY }, [new Error(`socket hang up near Bearer ${API_KEY}`)]);

        const err = (await client.getServiceInfo().catch((e: Error) => e)) as Error;

        expect(err.message).toContain('[redacted]');
        expect(err.message).not.toContain(API_KEY);
    });

    it('redacts the API key from fetch_data_from_endpoint errors', async () => {
        const { client } = createClient({ apiKey: API_KEY }, [new Error(`boom ${API_KEY}`)]);

        const result = await client.getToolCallData({
            tool_name: 'fetch_data_from_endpoint',
            parameters: { endpoint_path: '/api/v3/organizations/companies', method: 'GET' },
        } as any);

        expect(result.status).toBe('error');
        expect(JSON.stringify(result)).not.toContain(API_KEY);
    });
});

describe('VspcRestClient rate limiting', () => {
    beforeEach(() => {
        jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    it('retries a 429 that asks for a short wait (Retry-After header)', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 429, headers: { 'retry-after': '0' } },
            { status: 200, data: SERVICE_INFO },
        ]);

        await expect(client.getServiceInfo()).resolves.toBeDefined();
        expect(sent).toHaveLength(2);
    });

    it('retries a 429 whose body carries retryAfter', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 429, data: { retryAfter: 0 } },
            { status: 200, data: SERVICE_INFO },
        ]);

        await expect(client.getServiceInfo()).resolves.toBeDefined();
        expect(sent).toHaveLength(2);
    });

    it('does not wait for a long Retry-After and says when to try again', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [{ status: 429, headers: { 'retry-after': '60' } }]);

        const err = (await client.getServiceInfo().catch((e: Error) => e)) as Error;

        expect(sent).toHaveLength(1);
        expect(err.message).toContain('HTTP 429');
        expect(err.message).toContain('Try again in 60 s');
    });

    it('gives up after two retries', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 429, headers: { 'retry-after': '0' } },
            { status: 429, headers: { 'retry-after': '0' } },
            { status: 429, headers: { 'retry-after': '0' } },
        ]);

        const err = (await client.getServiceInfo().catch((e: Error) => e)) as Error;

        expect(sent).toHaveLength(3);
        expect(err.message).toContain('HTTP 429');
    });

    it('never replays an action (POST) after a 503', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [{ status: 503, headers: { 'retry-after': '0' } }]);

        const result = await client.getToolCallData({
            tool_name: 'fetch_data_from_endpoint',
            parameters: { endpoint_path: '/api/v3/jobs/00000000-0000-0000-0000-000000000000/start', method: 'POST' },
        } as any);

        expect(sent).toHaveLength(1);
        expect(result.status).toBe('error');
    });

    it('retries an action (POST) that was throttled with 429', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 429, headers: { 'retry-after': '0' } },
            { status: 202, data: {} },
        ]);

        const result = await client.getToolCallData({
            tool_name: 'fetch_data_from_endpoint',
            parameters: { endpoint_path: '/api/v3/jobs/00000000-0000-0000-0000-000000000000/start', method: 'POST' },
        } as any);

        expect(sent).toHaveLength(2);
        expect(result.status).toBe('success');
    });

    it('retries a GET after a 503 that says how long to wait', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 503, headers: { 'retry-after': '0' } },
            { status: 200, data: SERVICE_INFO },
        ]);

        await expect(client.getServiceInfo()).resolves.toBeDefined();
        expect(sent).toHaveLength(2);
    });

    it('retries rate-limited fetch_data_from_endpoint calls too', async () => {
        const { client, sent } = createClient({ apiKey: API_KEY }, [
            { status: 429, headers: { 'retry-after': '0' } },
            { status: 200, data: { data: [] } },
        ]);

        const result = await client.getToolCallData({
            tool_name: 'fetch_data_from_endpoint',
            parameters: { endpoint_path: '/api/v3/organizations/companies', method: 'GET' },
        } as any);

        expect(sent).toHaveLength(2);
        expect(result).toEqual({ status: 'success', data: { status: 200, body: { data: [] } } });
    });
});
