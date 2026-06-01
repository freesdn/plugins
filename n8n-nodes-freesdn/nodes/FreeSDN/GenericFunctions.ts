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
import { NodeApiError } from 'n8n-workflow';

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

/**
 * Make paginated GET request, returns all items.
 */
export async function apiRequestAllItems(
  this: IExecuteFunctions | ILoadOptionsFunctions,
  method: IHttpRequestMethods,
  resource: string,
  body: IDataObject = {},
  query: IDataObject = {},
): Promise<unknown[]> {
  const returnData: unknown[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const responseData = await apiRequest.call(this, method, resource, body, {
      ...query,
      page,
      limit,
    });

    const items = Array.isArray(responseData)
      ? responseData
      : (responseData as IDataObject).items ?? [];

    returnData.push(...(items as unknown[]));

    if ((items as unknown[]).length < limit) {
      break;
    }
    page++;
  }

  return returnData;
}
