import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const SECRET = process.env.BRIDGE_SECRET || 'changeme';
const PORT = process.env.PORT || 3000;

// 内存队列：存放待执行的指令
let commandQueue = [];
let lastCommand = null;
let lastSeen = null;

// ── 鉴权中间件 ──────────────────────────────────────
function auth(req, res, next) {
  const secret = req.query.secret
    || req.headers['x-secret']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── BLE 中继轮询 ─────────────────────────────────────
app.get('/toy-next', auth, (req, res) => {
  lastSeen = Date.now();
  const cmd = commandQueue.shift() || null;
  res.json({ cmd });
});

// ── REST 推送指令 ────────────────────────────────────
app.post('/toy-cmd', auth, (req, res) => {
  const cmd = req.body;
  if (!cmd || typeof cmd !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
  lastCommand = cmd;
  commandQueue.push(cmd);
  if (cmd.sec && Number(cmd.sec) > 0) {
    setTimeout(() => commandQueue.push({ stop: true }), Number(cmd.sec) * 1000);
  }
  res.json({ ok: true, queued: commandQueue.length });
});

// ── REST 状态查询 ────────────────────────────────────
app.get('/toy-status', auth, (req, res) => {
  const online = lastSeen && Date.now() - lastSeen < 5000;
  res.json({
    online: !!online,
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    queued: commandQueue.length,
    lastCommand,
  });
});

// ══════════════════════════════════════════════════════
// MCP SSE Transport (标准协议)
// ══════════════════════════════════════════════════════

const MCP_TOOLS = [
  {
    name: 'toy_set_speed',
    description: '设置设备震动/吮吸强度（0.0~1.0），可指定持续秒数',
    inputSchema: {
      type: 'object',
      properties: {
        speed: { type: 'number', minimum: 0, maximum: 1, description: '强度 0.0~1.0' },
        sec: { type: 'number', description: '持续秒数，0 或不填表示持续' },
      },
      required: ['speed'],
    },
  },
  {
    name: 'toy_set_pattern',
    description: '设置震动花样（1~8）和强度（0.0~1.0）',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'integer', minimum: 1, maximum: 8, description: '花样编号 1~8' },
        level: { type: 'number', minimum: 0, maximum: 1, description: '强度 0.0~1.0' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'toy_stop',
    description: '立即停止设备',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'toy_status',
    description: '查询本地蓝牙中继是否在线',
    inputSchema: { type: 'object', properties: {} },
  },
];

// 存储活跃 SSE 连接
const sessions = new Map();

// SSE 连接端点
app.get('/sse', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, res);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.write(`event: endpoint\ndata: ${baseUrl}/message?sessionId=${sessionId}&secret=${SECRET}\n\n`);

  const keepalive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    sessions.delete(sessionId);
  });
});

// 消息端点
app.post('/message', auth, (req, res) => {
  const sessionId = req.query.sessionId;
  const sseRes = sessions.get(sessionId);

  if (!sseRes) {
    return res.status(400).json({ error: 'session not found' });
  }

  const { jsonrpc, id, method, params } = req.body;

  let result;

  if (method === 'initialize') {
    result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'svakom-bridge', version: '1.0.0' },
    };
  } else if (method === 'notifications/initialized') {
    res.status(202).end();
    return;
  } else if (method === 'tools/list') {
    result = { tools: MCP_TOOLS };
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    result = handleToolCall(name, args || {});
  } else if (method === 'ping') {
    result = {};
  } else {
    result = { content: [{ type: 'text', text: 'unknown method' }] };
  }

  const response = { jsonrpc: '2.0', id, result };
  sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  res.status(202).end();
});

function handleToolCall(name, args) {
  if (name === 'toy_set_speed') {
    const cmd = { speed: args.speed, sec: args.sec || 0 };
    lastCommand = cmd;
    commandQueue.push(cmd);
    if (cmd.sec && Number(cmd.sec) > 0) {
      setTimeout(() => commandQueue.push({ stop: true }), Number(cmd.sec) * 1000);
    }
    return { content: [{ type: 'text', text: `✅ 已设置强度 ${args.speed}${args.sec ? `，持续 ${args.sec} 秒` : ''}` }] };
  }

  if (name === 'toy_set_pattern') {
    const cmd = { pattern: args.pattern, level: args.level ?? 0.5 };
    lastCommand = cmd;
    commandQueue.push(cmd);
    return { content: [{ type: 'text', text: `✅ 已设置花样 ${args.pattern}，强度 ${cmd.level}` }] };
  }

  if (name === 'toy_stop') {
    const cmd = { stop: true };
    lastCommand = cmd;
    commandQueue.push(cmd);
    return { content: [{ type: 'text', text: '✅ 已停止' }] };
  }

  if (name === 'toy_status') {
    const online = lastSeen && Date.now() - lastSeen < 5000;
    return { content: [{ type: 'text', text: online ? '✅ 中继在线' : '❌ 中继离线（请打开 toy.html）' }] };
  }

  return { content: [{ type: 'text', text: `未知工具: ${name}` }] };
}

// ── 健康检查 ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'svakom-bridge running' }));

app.listen(PORT, () => {
  console.log(`svakom-bridge listening on port ${PORT}`);
});
