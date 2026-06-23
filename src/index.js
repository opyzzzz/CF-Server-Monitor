import { initDatabase, monthlyCleanup, dropMetricsHistoryOld, getMetricsHistory, rebuildDatabase } from './database/schema.js';
import { checkOfflineNodes, checkExpiringServers } from './services/notification.js';
import { updateDatabase } from './database/updateDatabase.js';
import { handleAdminAPI } from './handlers/admin.js';
import { serveFrontend } from './handlers/frontend.js';
import { handleUpdate, handleWebSocketUpgrade } from './handlers/update.js';
import { handleServerAPI, handleServersAPI } from './handlers/dashboard.js';
import { loadSettings, loadSiteSettings, setDebug } from './utils/settings.js';
import { checkAuth, simpleAuthResponse } from './middleware/auth.js';
import { getServerDetail, getMetricsHistoryCache, setMetricsHistoryCache, getCacheDuration } from './utils/cache.js';
import { AppError, createSuccessResponse, createUnauthorizedResponse, createBadRequestResponse, createNotFoundResponse, createErrorResponse } from './utils/errors.js';
import { verifyTurnstileToken } from './utils/common.js';
import { getCorsAllowedOrigins, createOptionsResponse, applyCors } from './utils/cors.js';
// Durable Objects: 实时指标广播
// 显式 import + extends，确保 wrangler 静态分析器能在入口文件直接识别此 DO 类
import { MetricsBroadcaster as _MetricsBroadcaster }
  from './durable/MetricsBroadcaster.js';

export class MetricsBroadcaster extends _MetricsBroadcaster {}

async function getEncryptionKey(env) {
  const secret = env.TURNSTILE_SECRET_KEY || env.API_SECRET || 'default_secret_key_for_turnstile_encryption';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(hash).slice(0, 32),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

async function encryptCookieData(data, env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encodedData
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptCookieData(encoded, env) {
  try {
    const key = await getEncryptionKey(env);
    const decoded = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const iv = decoded.slice(0, 12);
    const ciphertext = decoded.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    const encoder = new TextDecoder();
    return JSON.parse(encoder.decode(decrypted));
  } catch (e) {
    console.error('Cookie decryption error:', e);
    return null;
  }
}

async function isTurnstileVerified(request, env) {
  const verifiedHeader = request.headers.get('X-Turnstile-Verified');
  
  if (!verifiedHeader) return false;
  
  try {
    const decrypted = await decryptCookieData(verifiedHeader, env);
    return decrypted && decrypted.expires && Date.now() < decrypted.expires * 1000;
  } catch {
    return false;
  }
}

async function fetchHistoryData(env, request, id, hours, columns, sys = null) {
  if (!id) return createBadRequestResponse('Missing ID');
  
  if (!sys) {
    sys = await loadSettings(env.DB);
  }
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  
  if (hours > 1 && !isLoggedIn) {
    return createUnauthorizedResponse();
  }
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse();
  
  // 最多查询7天数据
  const clampedHours = Math.min(hours, 168);
  const cacheDuration = getCacheDuration(clampedHours);

  const cached = getMetricsHistoryCache(id, clampedHours, columns);
  if (cached && Date.now() - cached.timestamp < cacheDuration) {
    return createSuccessResponse(cached.data, { 'X-Cache': 'HIT' });
  }
  
  let data;
  try {
    data = await getMetricsHistory(env.DB, id, clampedHours, columns);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (/no such column/i.test(message)) {
      console.warn('[History] 数据库字段缺失，可能尚未升级数据库:', message);
      return new Response(JSON.stringify({
        code: 'DATABASE_UPGRADE_REQUIRED'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw e;
  }
  
  setMetricsHistoryCache(id, clampedHours, columns, data);
  
  return createSuccessResponse(data, { 'X-Cache': 'MISS' });
}

export default {
  async fetch(request, env, ctx) {
    setDebug(env.DEBUG);

    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    const corsAllowedOrigins = getCorsAllowedOrigins(env);
    
    if (!env.API_SECRET || env.API_SECRET.length === 0) {
      const response = createBadRequestResponse('API_SECRET is required');
      return applyCors(response, request, corsAllowedOrigins);
    }
    
    if (method === 'OPTIONS') {
      return createOptionsResponse(request, corsAllowedOrigins);
    }

    if (env.ASSETS && method === 'GET') {
      try {
        const res = await env.ASSETS.fetch(new Request(`http://static${path}`, request));
        if (res.ok) {
          return applyCors(res, request, corsAllowedOrigins);
        }
      } catch (e) {
      }
    }

    const bypassTurnstilePaths = [
      '/admin/api',
      '/api/ws',
    ];

    const isApiRequest = path.startsWith('/api/') || path.startsWith('/admin/api');
    if (path === '/api/config' || path === '/rebuild') {
      await initDatabase(env.DB);
    }

    // /api/config 在不带 X-Turnstile-Token 且不带 X-Turnstile-Verified 时仍然 bypass（用于初始化判断是否需要验证），
    // 带 token 或 verified header 时则走完整验证流程，以便复用 verified 字段返回验证结果
    const isTurnstileBypassed = (reqPath) => {
      if (bypassTurnstilePaths.includes(reqPath)) return true;
      if (reqPath === '/api/config' && !request.headers.get('X-Turnstile-Token') && !request.headers.get('X-Turnstile-Verified')) return true;
      return false;
    };

    let setTurnstileCookie = false;
    let sys = null;

    if (isApiRequest && !isTurnstileBypassed(path)) {
      sys = await loadSiteSettings(env.DB);
      const turnstileEnabled = sys.turnstile_enabled === 'true';
      const turnstileSecretKey = sys.turnstile_secret_key || '';
      
      if (turnstileEnabled) {
        const hasValidCookie = await isTurnstileVerified(request, env);
        
        if (!hasValidCookie) {
          const turnstileToken = request.headers.get('X-Turnstile-Token');
          const isVerified = await verifyTurnstileToken(turnstileToken, turnstileSecretKey);
          
          if (!isVerified) {
            const response = createErrorResponse(new AppError('Turnstile verification failed', 403));
            return applyCors(response, request, corsAllowedOrigins);
          }
          
          setTurnstileCookie = true;
        }
      }
    }

    async function ensureFullSettings() {
      sys = await loadSettings(env.DB);
      return sys;
    }

    const routes = [
      { method: 'POST', path: '/update', handler: () => handleUpdate(request, env, ctx) },
      { method: 'GET', path: '/__do/health', handler: async () => {
        if (!env.METRICS_BROADCASTER) {
          return createSuccessResponse({ ok: false, reason: 'DO not bound' });
        }
        try {
          const id = env.METRICS_BROADCASTER.idFromName('global');
          const stub = env.METRICS_BROADCASTER.get(id);
          return await stub.fetch('http://internal/health');
        } catch (e) {
          return createSuccessResponse({ ok: false, reason: e.message });
        }
      }},
      { method: 'GET', path: '/api/config', handler: async () => {
        await ensureFullSettings();
        const turnstileEnabled = sys.turnstile_enabled === 'true';
        let verified = false;
        let turnstileVerified = null;

        if (turnstileEnabled) {
          verified = await isTurnstileVerified(request, env);
          if (setTurnstileCookie) {
            verified = true;
            const expires = Math.floor(Date.now() / 1000) + 3600;
            const cookieData = { expires, verified: true, timestamp: Date.now() };
            turnstileVerified = await encryptCookieData(cookieData, env);
          }
        }

        return createSuccessResponse({
          turnstile_enabled: turnstileEnabled,
          turnstile_site_key: sys.turnstile_site_key || '',
          verified: verified,
          turnstile_verified: turnstileVerified,
          show_long_history: sys.show_long_history === 'true'
        });
      }},
      { method: 'GET', path: '/api/server', handler: async () => {
        await ensureFullSettings();
        return handleServerAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/servers', handler: async () => {
        await ensureFullSettings();
        return handleServersAPI(request, env, sys);
      }},
      { method: 'GET', path: '/api/ws', handler: async () => handleWebSocketUpgrade(request, env) },

      { method: 'GET', path: '/api/history/all', handler: async () => {
        await ensureFullSettings();
        const id = url.searchParams.get('id');
        const hours = parseFloat(url.searchParams.get('hours') || '24');
        const allColumns = 'cpu, gpu, gpu_info, ram, disk_total, disk_used, processes, net_in_speed, net_out_speed, tcp_conn, udp_conn, ping_ct, ping_cu, ping_cm, ping_bd, loss_ct, loss_cu, loss_cm, loss_bd, swap_total, swap_used, load_avg';
        return fetchHistoryData(env, request, id, hours, allColumns, sys);
      }},
      { method: 'POST', path: '/admin/api', handler: async () => {
        await ensureFullSettings();
        return handleAdminAPI(request, env, sys);
      }},
      { method: 'POST', path: '/updateDatabase', handler: async () => {
        await ensureFullSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await updateDatabase(env.DB);
        return createSuccessResponse(result);
      }},
      { method: 'POST', path: '/rebuild', handler: async () => {
        await ensureFullSettings();
        if (!await checkAuth(request, env, sys)) {
          return simpleAuthResponse();
        }
        const result = await rebuildDatabase(env.DB);
        return createSuccessResponse(result);
      }}
    ];

    for (const route of routes) {
      if (route.method === method && route.path === path) {
        const response = await route.handler();

        // WebSocket 升级响应直接原样返回，不能修改 response 对象
        if (response.status === 101) {
          return response;
        }

        if (setTurnstileCookie) {
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const cookieData = { expires, verified: true, timestamp: Date.now() };
          const encryptedData = await encryptCookieData(cookieData, env);

          const finalHeaders = new Headers(response.headers);
          finalHeaders.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '');
          finalHeaders.set('Access-Control-Allow-Credentials', 'true');
          finalHeaders.set('Vary', 'Origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
          });
        }

        return applyCors(response, request, corsAllowedOrigins);
      }
    }

    await ensureFullSettings();
    const frontendResponse = await serveFrontend(request, env, sys);
    return applyCors(frontendResponse, request, corsAllowedOrigins);
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.debug(`[Cron] 定时任务触发: ${cron}`);
    
    if (cron === '*/1 * * * *') {
      console.debug('[Cron] 开始执行离线节点检测');
      await checkOfflineNodes(env.DB);
      console.debug('[Cron] 离线节点检测完成');
    } else if (cron === '0 * * * *') {
      const now = new Date();
      const day = now.getUTCDate();
      const hour = now.getUTCHours();
      
      if (day === 1 && hour === 0) {
        console.debug('[Cron] 开始执行每月数据清理任务（表轮换）');
        await monthlyCleanup(env.DB);
        console.debug('[Cron] 每月数据清理任务完成');
      }
      
      if (day === 8 && hour === 0) {
        console.debug('[Cron] 开始执行每月8号清理旧表任务');
        await dropMetricsHistoryOld(env.DB);
        console.debug('[Cron] 每月8号清理旧表任务完成');
      }
      
      if (hour === 12) {
        console.debug('[Cron] 开始执行服务器到期检测');
        await checkExpiringServers(env.DB);
        console.debug('[Cron] 服务器到期检测完成');
      }
    }else if(env.DEBUG == 1){
      if (cron === '* * 1 * *') {
        console.debug('[Cron DEBUG] 开始执行每月数据清理任务（表轮换）');
        await monthlyCleanup(env.DB);
        console.debug('[Cron DEBUG] 每月数据清理任务完成');
      } else if (cron === '* * 8 * *') {
        console.debug('[Cron DEBUG] 开始执行每月8号清理旧表任务');
        await dropMetricsHistoryOld(env.DB);
        console.debug('[Cron DEBUG] 每月8号清理旧表任务完成');
      } else if (cron === '0 12 * * *') {
        console.debug('[Cron DEBUG] 开始执行服务器到期检测');
        await checkExpiringServers(env.DB);
        console.debug('[Cron DEBUG] 服务器到期检测完成');
      }
    }
  }
};