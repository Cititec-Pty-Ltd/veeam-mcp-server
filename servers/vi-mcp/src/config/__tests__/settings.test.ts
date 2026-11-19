/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

const BASE = { PRODUCT_NAME: 'vspc', WEB_URL: 'https://vspc-srv.local:1280/' };

// settings.ts parses process.env when it is loaded, so give it a valid environment first.
Object.assign(process.env, BASE, { ADMIN_USERNAME: 'svc-reader', ADMIN_PASSWORD: 'example-password' });

let parseSettings: (env: NodeJS.ProcessEnv) => any;

beforeAll(async () => {
    ({ parseSettings } = await import('../settings'));
});

describe('settings: credentials', () => {
    it('accepts VSPC with only an API key', () => {
        const s = parseSettings({ ...BASE, VSPC_API_KEY: 'example-key' });
        expect(s.VSPC_API_KEY).toBe('example-key');
        expect(s.ADMIN_USERNAME).toBeUndefined();
        expect(s.ADMIN_PASSWORD).toBeUndefined();
    });

    it('still accepts a username and password', () => {
        const s = parseSettings({ ...BASE, ADMIN_USERNAME: 'svc-reader', ADMIN_PASSWORD: 'example-password' });
        expect(s.ADMIN_USERNAME).toBe('svc-reader');
        expect(s.VSPC_API_KEY).toBeUndefined();
    });

    it('treats an empty API key as not set', () => {
        expect(() => parseSettings({ ...BASE, VSPC_API_KEY: '  ' })).toThrow(/ADMIN_USERNAME environment variable is required/);
    });

    it('requires both username and password without an API key', () => {
        expect(() => parseSettings({ ...BASE })).toThrow(/ADMIN_USERNAME[\s\S]*ADMIN_PASSWORD/);
        expect(() => parseSettings({ ...BASE, ADMIN_USERNAME: 'svc-reader' })).toThrow('ADMIN_PASSWORD environment variable is required');
    });

    it('rejects an API key for products other than VSPC, without echoing it', () => {
        let message = '';
        try {
            parseSettings({ ...BASE, PRODUCT_NAME: 'vbr', VSPC_API_KEY: 'example-secret-key' });
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('VSPC_API_KEY is only supported when PRODUCT_NAME is "vspc"');
        expect(message).not.toContain('example-secret-key');
    });
});
