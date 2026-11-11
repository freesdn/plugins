const test = require('node:test');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');
const path = require('node:path');
const root = process.env.FREESDN_PACKAGE_ROOT || path.resolve(__dirname, '..');
const {FreeSdnTrigger} = require(path.join(root, 'dist/nodes/FreeSDN/FreeSdnTrigger.node.js'));
const {FreeSDN} = require(path.join(root, 'dist/nodes/FreeSDN/FreeSDN.node.js'));
const {FreeSDNApi} = require(path.join(root, 'dist/credentials/FreeSDNApi.credentials.js'));
const {apiRequest, apiRequestAllItems} = require(path.join(root, 'dist/nodes/FreeSDN/GenericFunctions.js'));

function context() {
  const state = {calls: [], staticData: {}, credentials: {
    serverUrl: 'https://owned.example.invalid/', apiKey: 'owned-fixture-api-key', webhookSecret: 'owned-fixture-signing-secret',
  }, parameters: {events: ['device.*', 'alert.fired'], webhookName: 'Owned trigger'}};
  const ctx = {
    getCredentials: async () => state.credentials,
    getNode: () => ({id: 'owned', name: 'Owned', type: 'test', typeVersion: 1, position: [0, 0], parameters: {}}),
    getNodeParameter: name => state.parameters[name],
    getNodeWebhookUrl: () => 'https://workflow.example.invalid/hook',
    getWorkflowStaticData: () => state.staticData,
    getInputData: () => [{json: {}}], continueOnFail: () => false,
    helpers: {request: async options => {state.calls.push(options); return state.respond ? state.respond(options) : {id: 'hook-id'};},
      returnJsonArray: values => values.map(json => ({json}))},
  };
  return {state, ctx};
}

function delivery() {
  const fixture = context();
  const body = {type: 'device.status.changed', value: 'é'};
  const raw = Buffer.from(' {"type":"device.status.changed", "value":"é"}\n');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', fixture.state.credentials.webhookSecret)
    .update(Buffer.concat([Buffer.from(timestamp + '.'), raw])).digest('hex');
  const request = {rawBody: raw};
  const headers = {'x-webhook-signature': 'sha256=' + signature, 'x-webhook-timestamp': timestamp};
  const response = {status(code) {this.code = code; return this;}, json(data) {this.data = data; return this;}};
  Object.assign(fixture.ctx, {getRequestObject: () => request, getHeaderData: () => headers,
    getResponseObject: () => response, getBodyData: () => body});
  return {...fixture, request, headers, response, body, raw};
}

const trigger = new FreeSdnTrigger();
const hooks = trigger.webhookMethods.default;

test('credential requires protected API and signing values', () => {
  const properties = new FreeSDNApi().properties;
  for (const name of ['apiKey', 'webhookSecret']) {
    const prop = properties.find(p => p.name === name);
    assert.equal(prop.required, true); assert.equal(prop.typeOptions.password, true);
  }
});

test('API requests preserve authentication, path, body and query', async () => {
  const {ctx, state} = context();
  await apiRequest.call(ctx, 'POST', '/fabric/ingest', {name: 'owned'}, {limit: 1});
  assert.deepEqual(state.calls[0], {method: 'POST', uri: 'https://owned.example.invalid/api/v1/fabric/ingest',
    headers: {'X-API-Key': state.credentials.apiKey, 'Content-Type': 'application/json'},
    qs: {limit: 1}, json: true, body: {name: 'owned'}});
});

test('pagination traverses a full page and preserves caller filters', async () => {
  const {ctx, state} = context();
  state.respond = options => ({items: Array.from({length: options.qs.page === 1 ? 100 : 2}, (_, i) => ({id: (options.qs.page - 1) * 100 + i}))});
  const rows = await apiRequestAllItems.call(ctx, 'GET', '/devices', {}, {site_id: 'owned-site'});
  assert.equal(rows.length, 102); assert.deepEqual(state.calls.map(c => c.qs), [1, 2].map(page => ({site_id: 'owned-site', page, per_page: 100})));
});

test('registration uses backend schema and retains only a secret fingerprint', async () => {
  const {ctx, state} = context();
  assert.equal(await hooks.create.call(ctx), true);
  assert.deepEqual(state.calls[0].body, {name: 'Owned trigger', url: ctx.getNodeWebhookUrl(), event_types: state.parameters.events,
    enabled: true, secret: state.credentials.webhookSecret});
  assert.equal(state.staticData.webhookId, 'hook-id');
  assert.ok(!JSON.stringify(state.staticData).includes(state.credentials.webhookSecret));
  assert.equal(await hooks.checkExists.call(ctx), true);
  state.parameters.events.reverse(); assert.equal(await hooks.checkExists.call(ctx), true);
  state.parameters.events.push('site.created'); assert.equal(await hooks.checkExists.call(ctx), false);
  await hooks.create.call(ctx); assert.equal(state.calls.at(-1).method, 'PATCH');
  assert.equal(state.calls.filter(c => c.method === 'POST').length, 1);
});

test('secret rotation and URL drift invalidate a previous registration', async () => {
  const {ctx, state} = context(); await hooks.create.call(ctx);
  state.credentials.webhookSecret = 'owned-rotated-secret'; assert.equal(await hooks.checkExists.call(ctx), false);
  await hooks.create.call(ctx); assert.equal(await hooks.checkExists.call(ctx), true);
  ctx.getNodeWebhookUrl = () => 'https://workflow.example.invalid/changed';
  assert.equal(await hooks.checkExists.call(ctx), false);
});

for (const statusCode of [401, 403, 429, 500, 503]) {
  test(`a PATCH ${statusCode} cannot silently create a duplicate webhook`, async () => {
    const {ctx, state} = context(); state.staticData.webhookId = 'retained-id';
    state.respond = options => {if (options.method === 'PATCH') throw {statusCode, message: 'owned refusal'}; return {id: 'duplicate'};};
    await assert.rejects(() => hooks.create.call(ctx));
    assert.equal(state.staticData.webhookId, 'retained-id');
    assert.deepEqual(state.calls.map(c => c.method), ['PATCH']);
  });
}

test('a confirmed missing registration can be recreated', async () => {
  const {ctx, state} = context(); state.staticData.webhookId = 'deleted-id';
  state.respond = options => {if (options.method === 'PATCH') throw {statusCode: 404, message: 'owned missing'}; return {id: 'replacement'};};
  assert.equal(await hooks.create.call(ctx), true); assert.equal(state.staticData.webhookId, 'replacement');
  assert.deepEqual(state.calls.map(c => c.method), ['PATCH', 'POST']);
});

test('delete failure retains the ID for an operator retry', async () => {
  const {ctx, state} = context(); state.staticData.webhookId = 'retained-id';
  state.respond = () => {throw {statusCode: 503, message: 'owned unavailable'};};
  assert.equal(await hooks.delete.call(ctx), false); assert.equal(state.staticData.webhookId, 'retained-id');
  delete state.respond; assert.equal(await hooks.delete.call(ctx), true); assert.equal(state.staticData.webhookId, undefined);
});

test('HMAC accepts the original UTF-8 wire bytes, with lazy body parsing', async () => {
  const f = delivery(); delete f.request.rawBody;
  f.request.readRawBody = async () => {f.request.rawBody = f.raw;};
  const result = await trigger.webhook.call(f.ctx);
  assert.deepEqual(result.workflowData, [[{json: f.body}]]); assert.equal(f.response.code, undefined);
});

for (const failure of ['secret', 'signature', 'timestamp', 'body', 'expired', 'future', 'tamper', 'multibyte', 'parse']) {
  test(`delivery ${failure} fails closed with an immediate response`, async () => {
    const f = delivery();
    if (failure === 'secret') f.state.credentials.webhookSecret = '';
    if (failure === 'signature') delete f.headers['x-webhook-signature'];
    if (failure === 'timestamp') delete f.headers['x-webhook-timestamp'];
    if (failure === 'body' || failure === 'parse') delete f.request.rawBody;
    if (failure === 'parse') f.request.readRawBody = async () => {throw new Error('owned parser refusal');};
    if (failure === 'expired') f.headers['x-webhook-timestamp'] = String(Math.floor(Date.now() / 1000) - 301);
    if (failure === 'future') f.headers['x-webhook-timestamp'] = String(Math.floor(Date.now() / 1000) + 301);
    if (failure === 'tamper') f.request.rawBody = Buffer.from(JSON.stringify(f.body));
    if (failure === 'multibyte') f.headers['x-webhook-signature'] = 'é'.repeat(32);
    assert.deepEqual(await trigger.webhook.call(f.ctx), {noWebhookResponse: true});
    assert.equal(f.response.code, failure === 'secret' ? 500 : 401); assert.ok(f.response.data.error);
  });
}

test('compiled action node encodes Fabric operation ID and preserves pairing', async () => {
  const {ctx, state} = context(); Object.assign(state.parameters, {resource: 'fabric', operation: 'invoke', fabricOperationId: 'owned/op', fabricParams: '{"value":1}'});
  const result = await new FreeSDN().execute.call(ctx);
  assert.equal(state.calls[0].uri, 'https://owned.example.invalid/api/v1/fabric/operations/owned%2Fop/invoke');
  assert.deepEqual(state.calls[0].body, {params: {value: 1}}); assert.equal(result[0][0].pairedItem, 0);
});

test('compiled getClients resolves the device site and calls the network router', async () => {
  const {ctx, state} = context(); Object.assign(state.parameters, {resource: 'device', operation: 'getClients', id: 'owned-id'});
  state.respond = options => options.uri.endsWith('/devices/owned-id') ? {site_id: 'owned-site'} : [];
  await new FreeSDN().execute.call(ctx);
  assert.equal(state.calls[1].uri, 'https://owned.example.invalid/api/v1/network/clients');
  assert.deepEqual(state.calls[1].qs, {site_id: 'owned-site', limit: 200});
});

// These envelope/query contracts come from the backend routers and OpenAPI.
const listContracts = [
  ['device', '/devices/', 'page', 'items'], ['site', '/sites/', 'page', 'items'],
  ['controller', '/controllers/', 'page', 'items'], ['automation', '/automation/', 'page', 'items'],
  ['backup', '/backups/', 'page', 'items'], ['vlan', '/network/vlans', 'skip', 'items'],
  ['wifi', '/network/wifi', 'skip', 'items'], ['alert', '/alert-rules/alerts', 'offset', 'alerts'],
];
for (const [resource, route, pagination, key] of listContracts) {
  for (const returnAll of [true, false]) {
    test(`${resource} Get Many ${returnAll ? 'returns all pages' : 'honors the requested limit'}`, async () => {
      const {ctx, state} = context();
      Object.assign(state.parameters, {resource, operation: 'getAll', returnAll, limit: 125});
      const records = Array.from({length: 205}, (_, id) => ({id}));
      state.respond = options => {
        assert.equal(options.uri, 'https://owned.example.invalid/api/v1' + route);
        const size = options.qs[pagination === 'page' ? 'per_page' : 'limit'];
        assert.ok(size > 0 && size <= 100, 'use a page size valid for every supported router');
        const offset = pagination === 'page' ? (options.qs.page - 1) * size : options.qs[pagination];
        return {[key]: records.slice(offset, offset + size), total: records.length};
      };
      const [rows] = await new FreeSDN().execute.call(ctx);
      assert.deepEqual(rows.map(r => r.json), records.slice(0, returnAll ? 205 : 125));
      assert.ok(rows.every(r => r.pairedItem === 0));
      assert.equal(state.calls.length, returnAll ? 3 : 2);
    });
  }
}

test('Get Many surfaces an invalid response instead of silently losing records', async () => {
  const {ctx, state} = context();
  Object.assign(state.parameters, {resource: 'device', operation: 'getAll', returnAll: true});
  state.respond = () => ({detail: 'unexpected envelope'});
  await assert.rejects(() => new FreeSDN().execute.call(ctx), /paginated response/i);
});

test('backup creation includes the required name and keeps the safe backend defaults', async () => {
  const {ctx, state} = context();
  Object.assign(state.parameters, {resource: 'backup', operation: 'create', backupName: 'Owned configuration snapshot'});
  await new FreeSDN().execute.call(ctx);
  assert.equal(state.calls[0].uri, 'https://owned.example.invalid/api/v1/backups/');
  assert.deepEqual(state.calls[0].body, {name: 'Owned configuration snapshot'});
  const field = new FreeSDN().description.properties.find(p => p.name === 'backupName');
  assert.equal(field.required, true);
});
