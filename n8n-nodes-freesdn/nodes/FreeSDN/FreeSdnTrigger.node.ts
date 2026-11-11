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
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import { apiRequest } from './GenericFunctions';

// Every value here is a name FreeSDN ACTUALLY publishes.
//
// Ten of the sixteen options this list used to offer could never fire:
// device.online, device.offline, alert.created, alert.escalated,
// controller.connected, controller.disconnected, backup.complete,
// backup.failed, discovery.complete and security.anomaly are not published
// anywhere in the platform. Several were near-misses -- discovery.complete for
// discovery.completed, alert.created for alert.fired -- which is the worst
// kind, because the workflow saves, activates, shows no error and simply never
// runs. Nothing on either side reports a subscription that cannot match.
//
// Check a name against a running instance before adding one. The backend test
// tests/plugins/test_event_names_are_real.py resolves the full published set,
// including names completed by an f-string at the call site.
const EVENT_TYPE_OPTIONS = [
  { name: 'Any Device Event', value: 'device.*' },
  { name: 'Device Status Changed', value: 'device.status.changed' },
  { name: 'Device Discovered', value: 'device.discovered' },
  { name: 'Device Adopted', value: 'device.adopted' },
  { name: 'Device Updated', value: 'device.updated' },
  { name: 'Device Action Completed', value: 'device.action_completed' },
  { name: 'Device Action Failed', value: 'device.action_failed' },
  { name: 'Any Alert Event', value: 'alert.*' },
  { name: 'Alert Fired', value: 'alert.fired' },
  { name: 'Alert Resolved', value: 'alert.resolved' },
  { name: 'Any Controller Event', value: 'controller.*' },
  { name: 'Controller Sync Started', value: 'controller.sync.started' },
  { name: 'Controller Sync Completed', value: 'controller.sync.completed' },
  { name: 'Controller Sync Failed', value: 'controller.sync.failed' },
  { name: 'Staged Change Applied', value: 'controller.change.applied' },
  { name: 'Staged Change Failed', value: 'controller.change.failed' },
  { name: 'Staged Change Awaiting Apply', value: 'controller.change.staged' },
  { name: 'Any Discovery Event', value: 'discovery.*' },
  { name: 'Discovery Completed', value: 'discovery.completed' },
  { name: 'Discovery Failed', value: 'discovery.failed' },
  { name: 'Camera Went Offline', value: 'camera.status.offline' },
  { name: 'Camera Came Online', value: 'camera.status.online' },
  { name: 'VLAN Created', value: 'network.vlan.created' },
  { name: 'VLAN Updated', value: 'network.vlan.updated' },
  { name: 'VLAN Deleted', value: 'network.vlan.deleted' },
  { name: 'WiFi Network Created', value: 'network.wifi.created' },
  { name: 'WiFi Network Updated', value: 'network.wifi.updated' },
  { name: 'SLA Breach Opened', value: 'sla.breach.created' },
  { name: 'SLA Breach Resolved', value: 'sla.breach.resolved' },
  { name: 'VPN Connected', value: 'vpn.connected' },
  { name: 'VPN Disconnected', value: 'vpn.disconnected' },
  { name: 'VPN Health Degraded', value: 'vpn.health_degraded' },
  { name: 'Backup Validation Failed', value: 'backup.validation.failed' },
  { name: 'Gateway Distribution Completed', value: 'gateway.distribution.completed' },
  { name: 'Gateway Distribution Failed', value: 'gateway.distribution.failed' },
  { name: 'AI Budget Warning', value: 'ai.budget.warning' },
  { name: 'Webhook Test', value: 'webhook.test' },
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
          } catch (error) {
            // A refusal or uncertain server failure does not prove the existing
            // registration is gone. Keep its ID so a retry cannot duplicate it.
            if (!(error instanceof NodeApiError) || error.httpCode !== '404') throw error;
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

  /**
   * Reject a delivery, and actually SAY SO.
   *
   * `noWebhookResponse: true` means "I have already sent the response" -- it is
   * not a rejection. Returning it without writing to the response object left
   * the connection open with nothing on it, so FreeSDN's delivery worker waited
   * out its full timeout and then recorded the delivery as a TIMEOUT and
   * retried it under the retry policy. A spoofed or replayed POST was therefore
   * retried repeatedly and the operator's failure reason said "timeout" rather
   * than "signature rejected".
   *
   * The workflow still does not run either way; this only makes the refusal
   * visible and immediate to the sender.
   */
  private static reject(
    ctx: IWebhookFunctions,
    status: number,
    reason: string,
  ): IWebhookResponseData {
    const res = ctx.getResponseObject();
    res.status(status).json({ error: reason });
    return { noWebhookResponse: true };
  }

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const credentials = await this.getCredentials('freeSDNApi');
    const secret = (credentials.webhookSecret as string) || '';

    // a signing secret is MANDATORY. Without it the trigger would accept
    // unsigned, spoofable POSTs to the public webhook URL and forward attacker-
    // controlled event data straight into the workflow. Fail closed when unset
    // (the credential also marks webhookSecret required:true so it cannot be empty).
    if (!secret) {
      return FreeSdnTrigger.reject(this, 500, 'No webhook signing secret is configured on this credential');
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
        return FreeSdnTrigger.reject(this, 401, 'Missing signature, timestamp or body');
      }
      // Replay window: reject deliveries whose timestamp is outside ±300s of now.
      const ts = Number(timestamp);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
        return FreeSdnTrigger.reject(this, 401, 'Timestamp outside the accepted replay window');
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
        return FreeSdnTrigger.reject(this, 401, 'Signature verification failed');
      }
    }

    const bodyData = this.getBodyData();
    return {
      workflowData: [this.helpers.returnJsonArray([bodyData])],
    };
  }
}
