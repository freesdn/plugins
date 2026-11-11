// SPDX-License-Identifier: MIT
// Copyright (C) 2024-2026 FreeSDN
import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  ILoadOptionsFunctions,
  IRequestOptions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * Make an authenticated request to the FreeSDN API.
 */
export async function apiRequest(
  this: IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions,
  method: IHttpRequestMethods,
  resource: string,
  body: IDataObject = {},
  qs: IDataObject = {},
): Promise<unknown> {
  const credentials = await this.getCredentials('freeSDNApi');
  const serverUrl = (credentials.serverUrl as string).replace(/\/$/, '');

  const options: IRequestOptions = {
    method,
    headers: {
      'X-API-Key': credentials.apiKey as string,
      'Content-Type': 'application/json',
    },
    qs,
    uri: `${serverUrl}/api/v1${resource}`,
    json: true,
  };

  if (Object.keys(body).length) {
    options.body = body;
  }

  try {
    return await this.helpers.request(options);
  } catch (error) {
    throw new NodeApiError(this.getNode(), error as JsonObject);
  }
}

/** Fetch resource rows using the pagination contract of its backend router. */
export async function apiRequestAllItems(
  this: IExecuteFunctions | ILoadOptionsFunctions,
  method: IHttpRequestMethods,
  resource: string,
  body: IDataObject = {},
  query: IDataObject = {},
  pagination: 'page' | 'skip' | 'offset' = 'page',
  itemKey = 'items',
  maximum = Infinity,
): Promise<unknown[]> {
  const returnData: unknown[] = [];
  let page = 1;
  // All supported routers accept 100. Keep it fixed between numbered pages;
  // reducing the final page size would change the server's computed offset.
  const pageSize = Math.min(100, maximum);

  while (returnData.length < maximum) {
    const cursor = pagination === 'page'
      ? { page, per_page: pageSize }
      : { [pagination]: returnData.length, limit: pageSize };
    const responseData = await apiRequest.call(this, method, resource, body, {
      ...query,
      ...cursor,
    }) as IDataObject;
    const items = responseData?.[itemKey];
    if (!Array.isArray(items)) {
      throw new NodeOperationError(this.getNode(), 'Invalid paginated response from FreeSDN');
    }
    returnData.push(...items.slice(0, maximum - returnData.length));
    if (items.length < pageSize ||
        (typeof responseData.total === 'number' && returnData.length >= responseData.total)) {
      break;
    }
    page++;
  }
  return returnData;
}
