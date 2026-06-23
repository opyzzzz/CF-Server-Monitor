// Durable Object: 服务器监控指标广播中心
// 负责维护 WebSocket 连接并在收到新指标时向订阅者实时推送
//
// - 连接通过 /api/ws?subscribe=<scope> 建立
//   scope = 'all'        -> 订阅所有服务器更新（首页）
//   scope = <serverId>   -> 只订阅某台服务器的更新（详情页）
//
// - 后端 /update 处理器在成功写入 DB 后，调用 /__do_push/<id>
//   由本 DO 向所有订阅者广播刚收到的指标。
//
// - 心跳：每 25s 向客户端发送 ping，避免中间代理断连。

function parseAllowedOrigins(corsAllowedOrigins) {
  if (!corsAllowedOrigins || corsAllowedOrigins.trim() === '') {
    return [];
  }
  return corsAllowedOrigins
    .split(',')
    .map(o => o.trim())
    .filter(o => o !== '');
}

export class MetricsBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 存储所有活跃 WebSocket：{ id: { ws, scope, createdAt } }
    this.sessions = new Map();
    this.nextSessionId = 0;

    // 心跳定时器
    this.heartbeatTimer = null;
    this._ensureHeartbeat();

    // 可选：某些运行时在 state 上暴露 blockConcurrencyWhile
    // 用于在实例首次启动时串行完成必要初始化，例如从持久化存储回放最新状态
    if (this.state && typeof this.state.blockConcurrencyWhile === 'function') {
      this.state.blockConcurrencyWhile(async () => {
        // 预留：未来可在这里做持久化的最新状态回放
      });
    }
  }

  _ensureHeartbeat() {
    if (this.heartbeatTimer) return;
    // Workers 内的 setTimeout 最长 ~30s 可用；heartbeat 25s 比较稳
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.sessions.size === 0) return;
      for (const { ws } of this.sessions.values()) {
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
          }
        } catch (_) { /* ignore */ }
      }
      this._ensureHeartbeat();
    }, 25000);
  }

  // 根据 scope 判断会话是否需要接收某台服务器的更新
  _shouldDeliver(sessionScope, serverId) {
    if (!sessionScope) return false;
    if (sessionScope === 'all') return true;
    return sessionScope === serverId;
  }

  _broadcast(serverId, payload) {
    if (this.sessions.size === 0) return;
    const message = JSON.stringify({
      type: 'update',
      serverId,
      ts: Date.now(),
      data: payload
    });

    for (const [sid, session] of this.sessions) {
      const { ws, scope } = session;
      if (ws.readyState !== 1) {
        this.sessions.delete(sid);
        continue;
      }
      if (!this._shouldDeliver(scope, serverId)) continue;
      try {
        ws.send(message);
      } catch (e) {
        try { ws.close(); } catch (_) {}
        this.sessions.delete(sid);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1) WebSocket 接入
    if (path === '/ws' || path.endsWith('/ws')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade request', { status: 426 });
      }
      
      const origin = request.headers.get('Origin');
      const allowedOrigins = parseAllowedOrigins(this.env.CORS_ALLOWED_ORIGINS);
      
      const scope = (url.searchParams.get('subscribe') || 'all').toLowerCase();

      // @ts-ignore - Cloudflare Workers 运行时提供 WebSocketPair
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const sid = ++this.nextSessionId;
      this.sessions.set(sid, { ws: server, scope, createdAt: Date.now() });

      const cleanup = () => {
        this.sessions.delete(sid);
        try { server.close(); } catch (_) {}
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      server.addEventListener('message', (event) => {
        // 简单处理客户端的 ping
        try {
          const msg = JSON.parse(event.data || '{}');
          if (msg && msg.type === 'pong') return;
          if (msg && msg.type === 'ping') {
            if (server.readyState === 1) {
              server.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            }
          }
        } catch (_) {}
      });

      // 立即发送一条 "hello" 让客户端确认连接成功
      try {
        server.send(JSON.stringify({
          type: 'hello',
          ts: Date.now(),
          subscribed: scope
        }));
      } catch (_) {}

      const responseHeaders = new Headers();
      responseHeaders.set('Access-Control-Allow-Origin', origin);
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    // 2) 内部广播入口：/update 成功后由 Worker 内部转发
    //    path: /push/<serverId>   body: { metrics } JSON
    if (method === 'POST' && (path.startsWith('/push/') || path.includes('/push/'))) {
      const parts = path.split('/push/');
      const serverId = decodeURIComponent((parts[1] || '').split('/')[0] || '');
      if (!serverId) {
        return new Response(JSON.stringify({ error: 'missing serverId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let payload = null;
      try {
        payload = await request.json();
      } catch (_) {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      this._broadcast(serverId, payload);
      return new Response(JSON.stringify({ ok: true, subscribers: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3) 健康检查
    if (method === 'GET' && (path === '/health' || path.endsWith('/health'))) {
      return new Response(JSON.stringify({ ok: true, subscribers: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default MetricsBroadcaster;
