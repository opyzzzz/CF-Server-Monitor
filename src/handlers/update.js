import { saveMetricsHistory } from '../database/schema.js';
import { checkServerExists } from '../utils/cache.js';
import { mergeMetricsIntoServer } from '../utils/metrics.js';
import { createErrorResponse, createUnauthorizedResponse, createNotFoundResponse } from '../utils/errors.js';

// 将最新一次上报打包成前端可直接消费的 "当前状态" 对象
// 与 /api/server 和 /api/servers 返回的字段保持一致，便于页面直接合并
function buildPayloadForBroadcast(id, metrics, extra = {}) {
  const payload = {};
  mergeMetricsIntoServer(payload, metrics);
  payload.id = id;
  payload.country = metrics.country || extra.country || '';
  payload.last_updated = metrics.timestamp || Date.now();
  payload.timestamp = payload.last_updated;
  return payload;
}

// 内部辅助：向 Durable Object 发送广播
async function broadcastToDO(env, serverId, payload) {
  if (!env || !env.METRICS_BROADCASTER) return false;
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    // 内部调用，不需要鉴权；即使失败也不影响 /update 返回
    await stub.fetch(`http://internal/push/${encodeURIComponent(serverId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (e) {
    // 广播失败不应该让客户端收到错误
    console.warn('[broadcast] DO push failed:', e.message || e);
    return false;
  }
}

export async function handleUpdate(request, env, ctx) {
  try {
    const data = await request.json();
    const { id, secret, metrics } = data;

    if (secret !== env.API_SECRET) {
      return createUnauthorizedResponse('Invalid secret');
    }

    let countryCode = request.cf?.country || request.headers?.get('cf-ipcountry') || '';
    const upperCode = countryCode.toUpperCase();

    const serverExists = await checkServerExists(env.DB, id);

    if (!serverExists) {
      return createNotFoundResponse('Server not found');
    }

    await saveMetricsHistory(env.DB, id, metrics, countryCode);

    const payload = buildPayloadForBroadcast(id, metrics || {}, { country: countryCode });
    ctx.waitUntil(broadcastToDO(env, id, payload));

    return new Response('OK', { status: 200 });
  } catch (e) {
    return createErrorResponse(e);
  }
}

// 暴露给 index.js 路由使用的 WebSocket 接入函数
export async function handleWebSocketUpgrade(request, env) {
  if (!env || !env.METRICS_BROADCASTER) {
    return new Response(JSON.stringify({ error: 'WebSocket not enabled', code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const qs = url.search || '';
  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    // 使用原始 request 构造新的内部请求，保留 WebSocket 升级语义
    return await stub.fetch(new Request(`http://internal/ws${qs}`, request));
  } catch (e) {
    console.error('[ws] DO upgrade failed:', e);
    return new Response(JSON.stringify({ error: 'WebSocket error', code: 500 }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
