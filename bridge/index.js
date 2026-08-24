import express from 'express';

const app = express();
app.use(express.json());

const SECRET = process.env.BRIDGE_SECRET || 'changeme';
const PORT = process.env.PORT || 3000;

// 内存队列：存放待执行的指令
let commandQueue = [];
// 最近一条指令（供状态查询）
let lastCommand = null;
// 中继上次心跳时间
let lastSeen = null;

// ── 鉴权中间件 ──────────────────────────────────────
function auth(req, res, next) {
  const secret = req.query.secret || req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── BLE 中继轮询：拉取待执行指令 ─────────────────────
// GET /toy-next?secret=xxx
// 每 300ms 由本地中继（toy.html 或 bridge.py）调用
app.get('/toy-next', auth, (req, res) => {
  lastSeen = Date.now();
  const cmd = commandQueue.shift() || null;
  res.json({ cmd });
});

// ── AI / MCP 推送指令 ─────────────────────────────────
// POST /toy-cmd?secret=xxx  body: { speed, pattern, level, stop, sec }
app.post('/toy-cmd', auth, (req, res) => {
  const cmd = req.body;
  if (!cmd || typeof cmd !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
  lastCommand = cmd;
  commandQueue.push(cmd);

  // 如果有持续时间，自动推一条停止指令
  if (cmd.sec && Number(cmd.sec) > 0) {
    setTimeout(() => {
      commandQueue.push({ stop: true });
    }, Number(cmd.sec) * 1000);
  }

  res.json({ ok: true, queued: commandQueue.length });
});

// ── 状态查询 ──────────────────────────────────────────
// GET /toy-status?secret=xxx
app.get('/toy-status', auth, (req, res) => {
  const online = lastSeen && Date.now() - lastSeen < 5000;
  res.json({
    online: !!online,
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    queued: commandQueue.length,
    lastCommand,
  });
});

// ── MCP Server (SSE transport) ────────────────────────
// GET /mcp?secret=xxx  ← Claude.ai Integrations 填这个 URL
app.get('/mcp', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 发送工具列表
  const tools = {
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {
      tools: [
        {
          name: 'toy_set_speed',
          description: '设置设备震动/吮吸强度（0.0~1.0）',
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
          description: '设置震动棒振动花样（1~8）和强度（0.0~1.0）',
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
      ],
    },
  };
  res.write(`data: ${JSON.stringify(tools)}\n\n`);

  req.on('close', () => res.end());
});

// MCP 工具调用
app.post('/mcp', auth, async (req, res) => {
  const { method, params, id } = req.body;

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    let cmd = null;

    if (name === 'toy_set_speed') {
      cmd = { speed: args.speed, sec: args.sec || 0 };
    } else if (name === 'toy_set_pattern') {
      cmd = { pattern: args.pattern, level: args.level ?? 0.5 };
    } else if (name === 'toy_stop') {
      cmd = { stop: true };
    } else if (name === 'toy_status') {
      const online = lastSeen && Date.now() - lastSeen < 5000;
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: online ? '✅ 中继在线' : '❌ 中继离线（请打开 toy.html 或运行 bridge.py）' }] },
      });
    }

    if (cmd) {
      lastCommand = cmd;
      commandQueue.push(cmd);
      if (cmd.sec && Number(cmd.sec) > 0) {
        setTimeout(() => commandQueue.push({ stop: true }), Number(cmd.sec) * 1000);
      }
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `✅ 指令已发送：${JSON.stringify(cmd)}` }] },
      });
    }
  }

  res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });
});

// ── 健康检查 ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'svakom-bridge running' }));

app.listen(PORT, () => {
  console.log(`svakom-bridge listening on port ${PORT}`);
});
