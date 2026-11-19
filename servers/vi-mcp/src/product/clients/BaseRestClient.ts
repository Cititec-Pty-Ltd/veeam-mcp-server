/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { ProductRestClient } from '../ProductRestClient';
import { ProductAuthResponseUnifiedDate, ProductRestClientConfig, RequestConfig } from './types';
import { ServiceInfo, ChatBotAuthResponse, CommonInvokeConfig, ToolCallResult } from '@/common/types';
import { createSortFindParams } from '@/utils';

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'node:https';
import { mergeUrlParts } from '@/utils/url';
import safeStringify from '@/utils/safeStringify';
import { rateLimitMessage, sendWithRateLimitRetry } from './rateLimit';

export abstract class BaseRestClient implements ProductRestClient {
    protected readonly config: ProductRestClientConfig;
    protected readonly client: AxiosInstance;

    private accessToken: string | null = null;
    private tokenExpirationTime: number | null = null;

    constructor(config: ProductRestClientConfig) {
        this.config = config;

        const httpsAgent = new https.Agent({
            rejectUnauthorized: !this.config.acceptSelfSignedCert,
        });

        this.client = axios.create({
            httpsAgent,
            // Bound every REST call so an unreachable or black-holed host fails within a
            // predictable time instead of hanging until the OS TCP timeout.
            timeout: 30_000,
        });
    }

    abstract getServiceInfo(): Promise<ServiceInfo>;
    abstract authenticateChatService(): Promise<ChatBotAuthResponse>;
    protected abstract authenticateProductRest(): Promise<ProductAuthResponseUnifiedDate>;

    async getToolCallData(config: CommonInvokeConfig): Promise<ToolCallResult> {
        if (config.tool_name !== 'fetch_data_from_endpoint') {
            return {
                status: 'error',
                data: { message: `Failed to provide Veeam Intelligence response. Unsupported client tool ${String(config.tool_name)}` },
            };
        }

        const { endpoint_path, query_params, method, body, headers } = config.parameters;
        const query = createSortFindParams(query_params ?? {});
        let url = endpoint_path;

        if (query.size > 0) {
            url = `${url}?${query.toString()}`;
        }

        try {
            const response = await this.requestRaw({ method, url, data: body, headers });
            const ok = response.status >= 200 && response.status < 300;

            return {
                status: ok ? 'success' : 'error',
                data: { status: response.status, body: response.data },
            };
        } catch (err: any) {
            return {
                status: 'error',
                data: { message: this.redact(`Failed to call ${method} ${endpoint_path}: ${err.message || 'Unknown error'}`) },
            };
        }
    }

    protected async get<T>(url: string, config?: RequestConfig): Promise<T> {
        return this.request<T>({ ...config, method: 'GET', url });
    }

    protected async post<T>(url: string, data?: any, config?: RequestConfig): Promise<T> {
        return this.request<T>({ ...config, method: 'POST', url, data });
    }

    private async prepareRequest(config: { url: string; headers?: Record<string, string> }) {
        if (this.shouldRefreshToken()) {
            await this.authenticate();
        }

        // Build full URL
        const normalizedUrl = (config.url || '').trim();
        const isAbsoluteUrl = /^https?:\/\//i.test(normalizedUrl);
        const url = isAbsoluteUrl ? normalizedUrl : mergeUrlParts(this.config.baseURL, normalizedUrl);

        // Build headers
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...config.headers,
        };

        this.applyAuthHeader(headers);

        return { url, headers };
    }

    private applyAuthHeader(headers: Record<string, string>): void {
        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
    }

    private async requestRaw(config: {
        method: string;
        url: string;
        data?: any;
        headers?: Record<string, string>;
        params?: Record<string, string>;
    }): Promise<AxiosResponse<unknown>> {
        const { url, headers } = await this.prepareRequest(config);
        const send = () =>
            this.client.request<unknown>({
                method: config.method,
                url,
                data: config.data,
                headers,
                params: config.params,
                validateStatus: () => true,
            });

        const label = pathOf(url);
        const response = await sendWithRateLimitRetry(send, label, config.method);
        if (response.status !== 401) {
            return response;
        }

        await this.authenticate();
        this.applyAuthHeader(headers);
        return sendWithRateLimitRetry(send, label, config.method);
    }

    // Generic request method with automatic token handling
    private async request<T>(config: {
        method: string;
        url: string;
        data?: any;
        headers?: Record<string, string>;
        params?: Record<string, string>;
    }): Promise<T> {
        const { url, headers } = await this.prepareRequest(config);
        const send = () =>
            this.client.request<T>({
                method: config.method,
                url,
                data: config.data,
                headers,
                params: config.params,
                validateStatus: () => true,
            });
        const label = pathOf(url);

        let response: AxiosResponse<T>;
        try {
            response = await sendWithRateLimitRetry(send, label, config.method);

            // Handle 401 - retry with new token
            if (response.status === 401) {
                await this.authenticate();
                this.applyAuthHeader(headers);
                response = await sendWithRateLimitRetry(send, label, config.method);
            }
        } catch (error: any) {
            // Extract detailed error information
            let errorMessage = `Request failed: ${error.message}`;

            // Include cause details if available
            if (error.cause) {
                errorMessage += this.formatErrorCause(error.cause);
            }

            throw new Error(this.redact(errorMessage), { cause: error });
        }

        if (response.status >= 200 && response.status < 300) {
            return response.data;
        }
        if (response.status === 429 || response.status === 503) {
            throw new Error(`Request failed: ${rateLimitMessage(response)}`);
        }
        let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
        if (response.status === 401 && this.config.apiKey) {
            errorMessage +=
                '. The API key was rejected: check that VSPC_API_KEY is a valid Simple REST API key and that its user is enabled.';
        }
        throw new Error(errorMessage);
    }

    // Authentication
    private shouldRefreshToken(): boolean {
        if (!this.accessToken || !this.tokenExpirationTime) {
            return true;
        }

        const bufferTimeMS = 14 * 60 * 1000; // 14 minutes
        return Date.now() + bufferTimeMS >= this.tokenExpirationTime;
    }

    private async authenticate(): Promise<void> {
        try {
            const data = await this.authenticateProductRest();
            this.accessToken = data.access_token;
            this.tokenExpirationTime = data.valid_until;
        } catch (error: any) {
            console.error('Authentication failed:', this.redact(String(error.message || error)));

            if (axios.isAxiosError(error)) {
                const errorMessage =
                    'Axios error during authentication.\n' +
                    `Request endpoint: ${error.config?.method} ${error.config?.url}\n` +
                    `Response status: ${error.response?.status} ${error.response?.statusText}\n` +
                    `Response data: ${safeStringify(error.response?.data)}\n` +
                    `Error message: ${error.message}`;

                const redacted = this.redact(errorMessage);
                console.error(redacted);
                throw new Error(redacted, { cause: error });
            }

            // Extract detailed error information
            let errorMessage = `Authentication failed: ${error.message}`;

            // Include cause details if available
            if (error.cause) {
                errorMessage += ' ' + this.formatErrorCause(error.cause);
            } else if (error.response) {
                errorMessage += ` ${error.response.status} ${error.response.statusText}`;
            } else if (error.message && error.message.toLowerCase().includes('authentication failed')) {
                errorMessage += ' Please verify that ADMIN_USERNAME and ADMIN_PASSWORD are correct.';
            }

            throw new Error(this.redact(errorMessage), { cause: error });
        }
    }

    /** Removes the API key and password from text that may be logged or returned. */
    protected redact(text: string): string {
        let result = text;
        for (const secret of [this.config.apiKey, this.config.password]) {
            if (secret && secret.length >= 4) {
                result = result.split(secret).join('[redacted]');
            }
        }
        return result;
    }

    private formatErrorCause(cause: any): string {
        if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause.code)) {
            return `Network error: ${cause.code} ${cause.message || ''}. Validate that WEB_URL contains correct hostname and port for Rest API.`;
        } else if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause.code)) {
            return `SSL error: ${cause.code}. If Veeam product uses self signed certificate, try setting ACCEPT_SELF_SIGNED_CERT=true.`;
        } else if (cause.code) {
            return `Unexpected network error: ${cause.code}: ${cause.message || ''}`;
        } else {
            return `Unexpected network error: ${cause.message || cause}`;
        }
    }
}

/** The path of a URL, without host or query, for log lines. */
function pathOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url.split('?')[0];
    }
}
