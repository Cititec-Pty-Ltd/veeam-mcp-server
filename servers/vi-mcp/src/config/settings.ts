/**
 * Copyright © Veeam Software Group GmbH. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

import { z } from 'zod';

const Product = {
    vbr: 'Veeam Backup & Replication',
    vone: 'Veeam One',
    vspc: 'Veeam Service Provider Console',
} as const;

type ProductCode = keyof typeof Product;

export function getProductCode(): ProductCode {
    return settings.PRODUCT_NAME as ProductCode;
}

export function getProductName(): string {
    return Product[getProductCode()];
}

export const ProductCodeEnum = z.enum(Object.keys(Product), {
    error: (issue: any) => {
        if (issue.code === 'invalid_type' && issue.input === undefined) {
            return `PRODUCT_NAME environment variable is required. Valid values are: ${Object.keys(Product).join(', ')}`;
        }
        return `PRODUCT_NAME environment variable has unexpected value "${issue.input}". Valid values are: ${Object.keys(Product).join(', ')}.`;
    },
});

// Unset and empty both mean "not set".
const optionalString = z.preprocess((val) => (typeof val === 'string' && val.trim() !== '' ? val : undefined), z.string().optional());

export const settingsSchema = z
    .object({
        // Required variables
        PRODUCT_NAME: z
            .preprocess((val) => (typeof val === 'string' ? val.toLowerCase().trim() : val), ProductCodeEnum)
            .describe(
                `Product code: "vbr" for Veeam Backup & Replication, "vone" for Veeam One, "vspc" for Veeam Service Provider Console`,
            ),
        WEB_URL: z.url('WEB_URL must be a valid Veeam product web UI URL').describe('Veeam product web UI endpoint URL'),
        // Required unless VSPC_API_KEY is set (checked below).
        ADMIN_USERNAME: optionalString.describe('Administrator username for Veeam product authentication'),
        ADMIN_PASSWORD: optionalString.describe('Administrator password for Veeam product authentication'),

        // Optional variables
        VSPC_API_KEY: optionalString.describe(
            'Veeam Service Provider Console REST API key (Simple key). When set, it is sent as the bearer token and ADMIN_USERNAME / ADMIN_PASSWORD are not used.',
        ),
        ACCEPT_SELF_SIGNED_CERT: z
            .preprocess((val) => (typeof val === 'string' ? val.toLowerCase().trim() === 'true' : false), z.boolean())
            .default(false),
        ACTION_CONFIRMATION_TIMEOUT_SEC: z
            .preprocess(
                (val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : undefined),
                z.number().int().positive().max(1700),
            )
            .default(1500)
            .describe(
                'How long a proposed action waits for the user decision before it is declined (must stay below the 1800 s Veeam Intelligence budget).',
            ),
        CHAT_TURN_TIMEOUT_SEC: z
            .preprocess((val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : undefined), z.number().int().positive())
            .default(3600)
            .describe('Upper bound for a single Veeam Intelligence answer, including confirmation waits.'),
    })
    .superRefine((value, ctx) => {
        if (value.VSPC_API_KEY !== undefined) {
            if (value.PRODUCT_NAME !== 'vspc') {
                ctx.addIssue({
                    code: 'custom',
                    path: ['VSPC_API_KEY'],
                    message: 'VSPC_API_KEY is only supported when PRODUCT_NAME is "vspc". Use ADMIN_USERNAME and ADMIN_PASSWORD instead.',
                });
            }
            return;
        }
        if (value.ADMIN_USERNAME === undefined) {
            ctx.addIssue({ code: 'custom', path: ['ADMIN_USERNAME'], message: 'ADMIN_USERNAME environment variable is required' });
        }
        if (value.ADMIN_PASSWORD === undefined) {
            ctx.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'ADMIN_PASSWORD environment variable is required' });
        }
    });

export function parseSettings(env: NodeJS.ProcessEnv = process.env) {
    try {
        return settingsSchema.parse(env);
    } catch (err) {
        if (err instanceof z.ZodError) {
            const errorMessages = err.issues.map((issue) => issue.message);
            if (errorMessages.length == 1) {
                throw new Error(errorMessages[0], { cause: err });
            } else if (errorMessages.length > 1) {
                const message = 'Configuration errors:\n' + errorMessages.map((msg) => ` - ${msg}`).join('\n');
                throw new Error(message, { cause: err });
            }
        }

        throw err;
    }
}

export const settings = parseSettings();
