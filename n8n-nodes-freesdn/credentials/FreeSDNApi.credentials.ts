// SPDX-License-Identifier: MIT
// Copyright (C) 2024-2026 FreeSDN
import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class FreeSDNApi implements ICredentialType {
  name = 'freeSDNApi';
  displayName = 'FreeSDN API';
  documentationUrl = 'https://docs.freesdn.org/api-keys';

  properties: INodeProperties[] = [
    {
      displayName: 'Server URL',
      name: 'serverUrl',
      type: 'string',
      default: 'https://freesdn.example.com',
      required: true,
      placeholder: 'https://freesdn.example.com',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      placeholder: 'fsd_...',
    },
    {
      displayName: 'Webhook Signing Secret',
      name: 'webhookSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Required for the FreeSDN Trigger. The Trigger registers its webhook with this secret and verifies the timestamp-bound HMAC (X-Webhook-Signature) on every delivery; without it the Trigger fails closed and rejects all deliveries, so a spoofed/unsigned POST to the n8n URL is never trusted.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        'X-API-Key': '={{$credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.serverUrl}}',
      url: '/api/v1/health',
    },
  };
}
