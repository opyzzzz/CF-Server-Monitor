export async function sendTelegramNotification(sys, msg) {
  if (sys.tg_notify !== 'true' || !sys.tg_bot_token || !sys.tg_chat_id) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${sys.tg_bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: sys.tg_chat_id,
        text: msg,
        parse_mode: 'Markdown'  // 改为 Markdown
      })
    });
  } catch (e) {
    console.error('Telegram 通知发送失败:', e);
  }
}

export async function sendWeworkNotification(sys, msg) {
  if (sys.tg_notify !== 'true' || !sys.tg_bot_token) return;

  try {
    await fetch(sys.tg_bot_token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: "markdown",  // 改为 markdown
        markdown: { content: msg }  // 改为 markdown 字段
      })
    });
  } catch (e) {
    console.error('企业微信通知发送失败:', e);
  }
}

export async function checkOfflineNodes(db, sys) {
  if (sys.tg_notify !== 'true') return;
  
  try {
    const { results: allServers } = await db.prepare(
      'SELECT id, name, last_updated FROM servers'
    ).all();
    
    let alertState = {};
    const stateRes = await db.prepare(
      "SELECT value FROM settings WHERE key = 'alert_state'"
    ).first();
    
    if (stateRes) {
      try {
        alertState = JSON.parse(stateRes.value);
      } catch (e) {
        alertState = {};
      }
    }

    let stateChanged = false;
    const now = Date.now();

    for (const s of allServers) {
      const diff = now - s.last_updated;
      const isOffline = diff > 120000;

      if (isOffline && !alertState[s.id]) {
        const msg = `⚠️ **节点离线告警**\n\n` +
          `**节点名称:** ${s.name}\n` +
          `**状态:** 离线 (超过2分钟未上报)\n` +
          `**时间:** ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`;
        
        await sendTelegramNotification(sys, msg);
        await sendWeworkNotification(sys, msg);
        
        alertState[s.id] = true;
        stateChanged = true;
      } else if (!isOffline && alertState[s.id]) {
        const msg = `✅ **节点恢复通知**\n\n` +
          `**节点名称:** ${s.name}\n` +
          `**状态:** 恢复在线\n` +
          `**时间:** ${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}`;
        
        await sendTelegramNotification(sys, msg);
        await sendWeworkNotification(sys, msg);
        
        delete alertState[s.id];
        stateChanged = true;
      }
    }

    if (stateChanged) {
      await db.prepare(
        'INSERT INTO settings (key, value) VALUES ("alert_state", ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(JSON.stringify(alertState)).run();
    }
  } catch (e) {
    console.error('离线检测失败:', e);
  }
}