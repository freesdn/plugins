// SPDX-License-Identifier: MIT
// Copyright (C) 2024-2026 FreeSDN
import type {
  IDataObject,
  IHookFunctions,
  ILoadOptionsFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { apiRequest } from './GenericFunctions';

const EVENT_TYPE_OPTIONS = [
  { name: 'Any Device Event', value: 'device.*' },
  { name: 'Device Online', value: 'device.online' },
  { name: 'Device Offline', value: 'device.offline' },
  { name: 'Device Status Changed', value: 'device.status.changed' },
  { name: 'Device Discovered', value: 'device.discovered' },
  { name: 'Any Alert Event', value: 'alert.*' },
  { name: 'Alert Created', value: 'alert.created' },
  { name: 'Alert Resolved', value: 'alert.resolved' },
  { name: 'Alert Escalated', value: 'alert.escalated' },
  { name: 'Any Controller Event', value: 'controller.*' },
  { name: 'Controller Connected', value: 'controller.connected' },
  { name: 'Controller Disconnected', value: 'controller.disconnected' },
  { name: 'Backup Completed', value: 'backup.complete' },
  { name: 'Backup Failed', value: 'backup.failed' },
  { name: 'Discovery Complete', value: 'discovery.complete' },
  { name: 'Security Anomaly', value: 'security.anomaly' },
];

/**
 * A stable fingerprint of the DESIRED webhook registration (events + whether/which
 * signing secret) so checkExists() can detect drift. n8n has no update() webhook
 * method (lifecycle is {checkExists, create, delete}), so when this differs from
 * what we registered, checkExists() returns false → create() re-runs and PATCHes
 * the webhook in place. The secret is HASHED, not embedded, so a credential value
 * never lands verbatim in the workflow's static data.
 */
async function registrationFingerprint(this: IHookFunctions): Promise<string> {
  const events = (this.getNodeParameter('events') as string[]) ?? [];
  const name = this.getNodeParameter('webhookName') as string;
  const url = this.getNodeWebhookUrl('default') as string;
  const credentials = await this.getCredentials('freeSDNApi');
  const secret = (credentials.webhookSecret as string) || '';
  const { createHash } = await import('crypto');
  const secretHash = secret ? createHash('sha256').update(secret).digest('hex') : '';
  return JSON.stringify({ events: [...events].sort(), name, url, secretHash });
}

export class FreeSdnTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FreeSDN Trigger',
    name: 'freeSdnTrigger',
    icon: 'file:freesdn.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts a workflow when FreeSDN events occur',
    defaults: {
      name: 'FreeSDN Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'freeSDNApi',
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        options: EVENT_TYPE_OPTIONS,
        default: ['device.*'],
        required: true,
        description: 'The events to listen to',
      },
      {
        displayName: 'Webhook Name',
        name: 'webhookName',
        type: 'string',
        default: 'n8n workflow trigger',
        description: 'Name for this webhook registration in FreeSDN',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node');
        if (!webhookData.webhookId) return false;

        // The remote webhook must still exist…
        try {
          await apiRequest.call(this, 'GET', `/webhooks/${webhookData.webhookId}`);
        } catch {
          return false;
        }
        // …AND its registration must match what we want now. If the operator
        // changed the signing secret or the event set (and re-activated the
        // workflow), the fingerprint differs → return false so create() re-runs
        // and PATCHes the new config in (n8n has no update() hook).
        const fp = await registrationFingerprint.call(this);
        return webhookData.fingerprint === fp;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default') as string;
        const events = this.getNodeParameter('events') as string[];
        const name = this.getNodeParameter('webhookName') as string;
        const credentials = await this.getCredentials('freeSDNApi');
        const secret = (credentials.webhookSecret as string) || null;
        const webhookData = this.getWorkflowStaticData('node');

        const body = {
          name,
          url: webhookUrl,
          // Backend schema is event_types/enabled (NOT events/is_active — those
          // were silently dropped by Pydantic, registering an empty event filter).
          event_types: events,
          enabled: true,
          // When set, FreeSDN HMAC-signs each delivery (X-Webhook-Signature +
          // X-Webhook-Timestamp); the webhook() handler below verifies it.
          secret,
        };

        // UPSERT: if we already registered one, PATCH it in place (drift re-sync
        // from checkExists) rather than POSTing a duplicate; fall back to create
        // if the stored id is stale (deleted server-side).
        if (webhookData.webhookId) {
          try {
            await apiRequest.call(this, 'PATCH', `/webhooks/${webhookData.webhookId}`, body);
            webhookData.fingerprint = await registrationFingerprint.call(this);
            return true;
          } catch {
            delete webhookData.webhookId;
          }
        }

        const responseData = await apiRequest.call(this, 'POST', '/webhooks', body);
        webhookData.webhookId = (responseData as IDataObject).id;
        webhookData.fingerprint = await registrationFingerprint.call(this);
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node');
        if (!webhookData.webhookId) return true;

        try {
          await apiRequest.call(this, 'DELETE', `/webhooks/${webhookData.webhookId}`);
        } catch {
          return false;
        }

        delete webhookData.webhookId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const credentials = await this.getCredentials('freeSDNApi');
    const secret = (credentials.webhookSecret as string) || '';

    // a signing secret is MANDATORY. Without it the trigger would accept
    // unsigned, spoofable POSTs to the public webhook URL and forward attacker-
    // controlled event data straight into the workflow. Fail closed when unset
    // (the credential also marks webhookSecret required:true so it cannot be empty).
    if (!secret) {
      return { noWebhookResponse: true };
    }

    // Verify the timestamp-bound HMAC before trusting the delivery — rejects a
    // spoofed POST to the n8n webhook URL and a replayed capture. FreeSDN signs
    // over "{timestamp}.{rawBody}" and sends X-Webhook-Timestamp; we verify over
    // the RAW body (re-serializing could differ).
    {
      const headers = this.getHeaderData() as Record<string, string | undefined>;
      const provided = (headers['x-webhook-signature'] || headers['X-Webhook-Signature'] || '').replace(
        /^sha256=/,
        '',
      );
      const timestamp = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'] || '';
      const req = this.getRequestObject() as unknown as {
        rawBody?: Buffer | string;
        readRawBody?: () => Promise<void>;
      };
      // n8n's body-parser populates req.rawBody (the exact wire bytes, before JSON
      // parsing) for application/json — but LAZILY. Force it if absent, exactly as
      // n8n's own Webhook node does, so verification doesn't spuriously fail.
      if (req.rawBody === undefined && typeof req.readRawBody === 'function') {
        try {
          await req.readRawBody();
        } catch {
          /* leave rawBody undefined → fail closed below */
        }
      }
      const raw: Buffer | string | undefined = req.rawBody;
      // FAIL CLOSED: a configured secret means every delivery MUST carry a raw
      // body, a signature, AND a timestamp. Missing any → reject (no unauthenticated
      // or unversioned POST is trusted).
      if (raw === undefined || !provided || !timestamp) {
        return { noWebhookResponse: true };
      }
      // Replay window: reject deliveries whose timestamp is outside ±300s of now.
      const ts = Number(timestamp);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
        return { noWebhookResponse: true };
      }
      const { createHmac, timingSafeEqual } = await import('crypto');
      const bytes = typeof raw === 'string' ? Buffer.from(raw) : raw;
      // Sign over the exact "{timestamp}." prefix + raw bytes the server used.
      const signed = Buffer.concat([Buffer.from(`${timestamp}.`), bytes]);
      const expected = createHmac('sha256', secret).update(signed).digest('hex');
      // Compare on BYTES, guarding byte-length first — a multi-byte header would
      // make string-length checks lie and timingSafeEqual throw RangeError.
      const provBuf = Buffer.from(provided, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');
      const ok = provBuf.length === expBuf.length && timingSafeEqual(provBuf, expBuf);
      if (!ok) {
        return { noWebhookResponse: true };
      }
    }

    const bodyData = this.getBodyData();
    return {
      workflowData: [this.helpers.returnJsonArray([bodyData])],
    };
  }
}
