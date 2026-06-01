// SPDX-License-Identifier: MIT
// Copyright (C) 2024-2026 FreeSDN
import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { apiRequest } from './GenericFunctions';

interface FabricCatalogOp {
  id: string;
  title?: string;
  write?: boolean;
  permission?: string | null;
}

export class FreeSDN implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FreeSDN',
    name: 'freeSDN',
    icon: 'file:freesdn.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Interact with FreeSDN network management platform',
    defaults: {
      name: 'FreeSDN',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'freeSDNApi',
        required: true,
      },
    ],
    properties: [
      // ── Resource selector ──────────────────────────────────────────────
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Fabric (Catalog Op / Event)', value: 'fabric' },
          { name: 'Alert', value: 'alert' },
          { name: 'Automation Rule', value: 'automation' },
          { name: 'Backup', value: 'backup' },
          { name: 'Controller', value: 'controller' },
          { name: 'Device', value: 'device' },
          { name: 'Site', value: 'site' },
          { name: 'VLAN', value: 'vlan' },
          { name: 'WiFi Network', value: 'wifi' },
        ],
        default: 'fabric',
      },

      // ── Fabric: catalog-driven operations (self-updating) ──────────────
      {
        displayName: 'Fabric Action',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['fabric'] } },
        options: [
          {
            name: 'Invoke Operation',
            value: 'invoke',
            description: 'Run any FreeSDN Fabric operation (writes stage for sign-off)',
            action: 'Invoke a Fabric operation',
          },
          {
            name: 'Emit Event',
            value: 'emit',
            description: 'Post an external callback into FreeSDN (fires matching Connections)',
            action: 'Emit a Fabric event',
          },
        ],
        default: 'invoke',
      },
      {
        // The operation list is loaded LIVE from GET /fabric/catalog, so it
        // reflects whatever this FreeSDN instance can do — no node update needed.
        displayName: 'Operation Name or ID',
        name: 'fabricOperationId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getFabricOperations' },
        required: true,
        default: '',
        description:
          'The Fabric operation to invoke. Choose from the list (loaded live from the connected FreeSDN), or specify an ID using an expression.',
        displayOptions: { show: { resource: ['fabric'], operation: ['invoke'] } },
      },
      {
        displayName: 'Parameters (JSON)',
        name: 'fabricParams',
        type: 'json',
        default: '{}',
        description: 'Parameters for the operation (matches its input schema)',
        displayOptions: { show: { resource: ['fabric'], operation: ['invoke'] } },
      },
      {
        displayName: 'Name',
        name: 'ingestName',
        type: 'string',
        default: 'n8n_callback',
        description: 'Routing label (sanitized to [a-z0-9_-]); match it in a Connection condition on payload.name',
        displayOptions: { show: { resource: ['fabric'], operation: ['emit'] } },
      },
      {
        displayName: 'Payload (JSON)',
        name: 'ingestPayload',
        type: 'json',
        default: '{}',
        description: 'The JSON body to carry into FreeSDN as the ingest.external event data',
        displayOptions: { show: { resource: ['fabric'], operation: ['emit'] } },
      },

      // ── Device operations ──────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['device'] } },
        options: [
          { name: 'Get', value: 'get', description: 'Get a single device', action: 'Get a device' },
          { name: 'Get Many', value: 'getAll', description: 'Get multiple devices', action: 'Get many devices' },
          { name: 'Get Clients', value: 'getClients', description: 'Get clients connected to a device', action: 'Get clients' },
          { name: 'Get Ports', value: 'getPorts', description: 'Get ports on a switch', action: 'Get ports' },
          { name: 'Reboot', value: 'reboot', description: 'Reboot a device', action: 'Reboot a device' },
        ],
        default: 'getAll',
      },

      // ── Alert operations ──────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['alert'] } },
        options: [
          { name: 'Get', value: 'get', action: 'Get an alert' },
          { name: 'Get Many', value: 'getAll', action: 'Get many alerts' },
          { name: 'Acknowledge', value: 'acknowledge', action: 'Acknowledge an alert' },
          { name: 'Resolve', value: 'resolve', action: 'Resolve an alert' },
        ],
        default: 'getAll',
      },

      // ── VLAN operations ────────────────────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['vlan'] } },
        options: [
          { name: 'Create', value: 'create', action: 'Create a VLAN' },
          { name: 'Delete', value: 'delete', action: 'Delete a VLAN' },
          { name: 'Get', value: 'get', action: 'Get a VLAN' },
          { name: 'Get Many', value: 'getAll', action: 'Get many VLANs' },
          { name: 'Update', value: 'update', action: 'Update a VLAN' },
        ],
        default: 'getAll',
      },

      // ── Site / Controller / WiFi / Automation / Backup — Get + Get Many
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['site', 'controller', 'wifi'] } },
        options: [
          { name: 'Get', value: 'get', action: 'Get one' },
          { name: 'Get Many', value: 'getAll', action: 'Get many' },
        ],
        default: 'getAll',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['automation'] } },
        options: [
          { name: 'Get Many', value: 'getAll', action: 'Get many rules' },
          { name: 'Enable', value: 'enable', action: 'Enable a rule' },
          { name: 'Disable', value: 'disable', action: 'Disable a rule' },
        ],
        default: 'getAll',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['backup'] } },
        options: [
          { name: 'Create', value: 'create', action: 'Create a backup' },
          { name: 'Get', value: 'get', action: 'Get a backup' },
          { name: 'List', value: 'getAll', action: 'List backups' },
        ],
        default: 'getAll',
      },

      // ── Shared ID field ────────────────────────────────────────────────
      {
        displayName: 'ID',
        name: 'id',
        type: 'string',
        required: true,
        default: '',
        displayOptions: {
          show: {
            operation: ['get', 'reboot', 'acknowledge', 'resolve', 'delete', 'update', 'enable', 'disable', 'getClients', 'getPorts'],
          },
        },
        description: 'The ID of the resource',
      },

      // ── Filters for getAll ─────────────────────────────────────────────
      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        default: false,
        displayOptions: { show: { operation: ['getAll'] } },
        description: 'Whether to return all results or only up to a given limit',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        displayOptions: {
          show: { operation: ['getAll'], returnAll: [false] },
        },
        description: 'Max number of results to return',
      },

      // ── VLAN create/update fields ──────────────────────────────────────
      {
        displayName: 'VLAN ID',
        name: 'vlanId',
        type: 'number',
        required: true,
        default: 100,
        displayOptions: { show: { resource: ['vlan'], operation: ['create'] } },
      },
      {
        displayName: 'VLAN Name',
        name: 'vlanName',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['vlan'], operation: ['create', 'update'] } },
      },

      // ── Reboot reason ─────────────────────────────────────────────────
      {
        displayName: 'Reason',
        name: 'reason',
        type: 'string',
        default: 'Rebooted from n8n workflow',
        displayOptions: { show: { resource: ['device'], operation: ['reboot'] } },
      },
    ],
  };

  methods = {
    loadOptions: {
      // Populate the Fabric "Operation" dropdown live from GET /fabric/catalog,
      // so the node self-updates as the connected FreeSDN gains capabilities.
      async getFabricOperations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const catalog = (await apiRequest.call(this, 'GET', '/fabric/catalog')) as {
          operations?: FabricCatalogOp[];
        };
        const ops = catalog.operations ?? [];
        ops.sort((a, b) => a.id.localeCompare(b.id));
        return ops.map((o) => ({
          name: `${o.title || o.id}${o.write ? ' (writes - stages)' : ''}`,
          value: o.id,
          description: o.permission ? `permission: ${o.permission}` : 'no permission required',
        }));
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < items.length; i++) {
      let responseData: unknown;

      try {
        if (resource === 'fabric') {
          if (operation === 'invoke') {
            const opId = this.getNodeParameter('fabricOperationId', i) as string;
            const raw = this.getNodeParameter('fabricParams', i, {}) as unknown;
            const params = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
            responseData = await apiRequest.call(
              this,
              'POST',
              `/fabric/operations/${encodeURIComponent(opId)}/invoke`,
              { params },
            );
          } else if (operation === 'emit') {
            const name = this.getNodeParameter('ingestName', i) as string;
            const raw = this.getNodeParameter('ingestPayload', i, {}) as unknown;
            const payload = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
            responseData = await apiRequest.call(this, 'POST', '/fabric/ingest', { name, payload });
          }
        } else if (resource === 'device') {
          if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/devices/${id}`);
          } else if (operation === 'getAll') {
            const limit = this.getNodeParameter('returnAll', i) ? 1000 : (this.getNodeParameter('limit', i) as number);
            responseData = await apiRequest.call(this, 'GET', '/devices', {}, { limit });
          } else if (operation === 'getClients') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/devices/${id}/clients`);
          } else if (operation === 'getPorts') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/devices/${id}/ports`);
          } else if (operation === 'reboot') {
            const id = this.getNodeParameter('id', i) as string;
            const reason = this.getNodeParameter('reason', i) as string;
            responseData = await apiRequest.call(this, 'POST', `/devices/${id}/reboot`, { reason });
          }
        } else if (resource === 'alert') {
          if (operation === 'getAll') {
            const limit = this.getNodeParameter('returnAll', i) ? 1000 : (this.getNodeParameter('limit', i) as number);
            responseData = await apiRequest.call(this, 'GET', '/alert-rules/alerts', {}, { limit });
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/alert-rules/alerts/${id}`);
          } else if (operation === 'acknowledge') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'POST', `/alert-rules/alerts/${id}/acknowledge`);
          } else if (operation === 'resolve') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'POST', `/alert-rules/alerts/${id}/resolve`);
          }
        } else if (resource === 'vlan') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/network/vlans');
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/network/vlans/${id}`);
          } else if (operation === 'create') {
            const vlanId = this.getNodeParameter('vlanId', i) as number;
            const vlanName = this.getNodeParameter('vlanName', i) as string;
            responseData = await apiRequest.call(this, 'POST', '/network/vlans', { vlan_id: vlanId, name: vlanName });
          } else if (operation === 'update') {
            const id = this.getNodeParameter('id', i) as string;
            const vlanName = this.getNodeParameter('vlanName', i) as string;
            responseData = await apiRequest.call(this, 'PATCH', `/network/vlans/${id}`, { name: vlanName });
          } else if (operation === 'delete') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'DELETE', `/network/vlans/${id}`);
          }
        } else if (resource === 'site') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/sites');
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/sites/${id}`);
          }
        } else if (resource === 'controller') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/controllers');
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/controllers/${id}`);
          }
        } else if (resource === 'wifi') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/network/wifi');
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/network/wifi/${id}`);
          }
        } else if (resource === 'automation') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/automation/rules');
          } else if (operation === 'enable') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'POST', `/automation/rules/${id}/enable`);
          } else if (operation === 'disable') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'POST', `/automation/rules/${id}/disable`);
          }
        } else if (resource === 'backup') {
          if (operation === 'getAll') {
            responseData = await apiRequest.call(this, 'GET', '/backups');
          } else if (operation === 'get') {
            const id = this.getNodeParameter('id', i) as string;
            responseData = await apiRequest.call(this, 'GET', `/backups/${id}`);
          } else if (operation === 'create') {
            responseData = await apiRequest.call(this, 'POST', '/backups');
          }
        }

        const rows = Array.isArray(responseData) ? responseData : [responseData];
        for (const row of rows) {
          returnData.push({ json: (row ?? {}) as IDataObject, pairedItem: i });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ json: { error: (error as Error).message }, pairedItem: i });
        } else {
          throw error;
        }
      }
    }

    return [returnData];
  }
}
