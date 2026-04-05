import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { definePluginEntry, emptyPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

const THUMBS_UP = String.fromCodePoint(0x1F44D);
const RECENT_TURN_TTL_MS = 30_000;
const ACK_FALLBACK = THUMBS_UP;
const REACTION_CANDIDATES = [THUMBS_UP, '❤', '🔥', '👌'];

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAliasPattern(agent) {
  return Array.from(new Set([agent.foldedName, ...(agent.aliases || [])].filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map((value) => escapeRegex(value))
    .join('|');
}

function stripProviderPrefix(modelRef) {
  const raw = String(modelRef || '').trim();
  if (!raw) return 'smart-route';
  const parts = raw.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : raw;
}

function buildTurnCacheKey({ content, senderId, timestamp, conversationId }) {
  return JSON.stringify({
    c: String(content || '').trim(),
    s: String(senderId || ''),
    t: Number(timestamp || 0),
    v: String(conversationId || ''),
  });
}

function cleanQuestionTail(value) {
  return String(value || '')
    .replace(/^[:,-]\s*/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}

function isGenericQuestionRequest(value) {
  const folded = foldText(value);
  if (!folded) return true;
  return [
    'bat cu cau gi',
    'bat ky cau gi',
    'mot cau bat ky',
    '1 cau bat ky',
    '1 cau gi',
    'mot cau gi',
    'cau gi cung duoc',
    'cau bat ky',
  ].some((item) => folded.includes(item));
}

function isGenericTaskRequest(value) {
  const folded = foldText(value);
  if (!folded) return true;
  return [
    'bat cu viec gi',
    'bat ky viec gi',
    'bat ky task nao',
    'bat cu task nao',
    'viec gi cung duoc',
    'task gi cung duoc',
  ].some((item) => folded.includes(item));
}

function buildDateFromParts(baseDate, hour, minute, dayOffset = 0) {
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  );
}

function parseReminderSpec(text, nowMs = Date.now()) {
  const raw = String(text || '').trim();
  const folded = foldText(raw);
  if (!folded) return null;

  const now = new Date(nowMs);
  let dueAt = null;
  let matchedText = '';
  let dueText = '';
  let repeatEveryMs = 0;

  const repeatMatch = folded.match(/\b(?:va\s+)?lap lai moi\s+(\d+)?\s*(phut|gio|ngay)\b/);
  if (repeatMatch) {
    const amount = Number(repeatMatch[1] || 1);
    const unit = repeatMatch[2];
    const unitMs = unit === 'phut'
      ? 60_000
      : unit === 'gio'
        ? 3_600_000
        : 86_400_000;
    if (amount > 0) repeatEveryMs = amount * unitMs;
  } else if (/\bmoi phut(?:\/\s*lan)?\b/.test(folded)) {
    repeatEveryMs = 60_000;
  } else if (/\bmoi gio(?:\/\s*lan)?\b/.test(folded)) {
    repeatEveryMs = 3_600_000;
  }

  let match = folded.match(/\bsau\s+(\d+)\s+(phut|gio|ngay|tuan)(?:\s+nua)?\b/);
  if (match) {
    const amount = Number(match[1] || 0);
    const unit = match[2];
    const unitMs = unit === 'phut'
      ? 60_000
      : unit === 'gio'
        ? 3_600_000
        : unit === 'ngay'
          ? 86_400_000
          : 604_800_000;
    if (amount > 0) {
      dueAt = new Date(nowMs + (amount * unitMs));
      matchedText = match[0];
      dueText = `${amount} ${unit}`;
    }
  }

  if (!dueAt) {
    const patterns = [
      /\b(ngay mai|mai|hom nay|toi nay|sang mai|chieu mai)\s*(?:luc|vao)?\s*(\d{1,2})(?:[:h](\d{1,2}))?\s*(sang|chieu|toi)?\b/,
      /\b(\d{1,2})(?:[:h](\d{1,2}))?\s*(sang|chieu|toi)?\s*(ngay mai|mai|hom nay|toi nay|sang mai|chieu mai)?\b/,
    ];
    for (const pattern of patterns) {
      match = folded.match(pattern);
      if (!match) continue;

      const ordered = pattern === patterns[0]
        ? { dayWord: match[1] || '', hour: match[2], minute: match[3], meridiem: match[4] || '' }
        : { hour: match[1], minute: match[2], meridiem: match[3] || '', dayWord: match[4] || '' };
      let hour = Number(ordered.hour || 0);
      const minute = Number(ordered.minute || 0);
      const dayWord = ordered.dayWord || '';
      const meridiem = ordered.meridiem || '';

      if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) continue;
      if (meridiem === 'chieu' || meridiem === 'toi') {
        if (hour < 12) hour += 12;
      }
      if (meridiem === 'sang' && hour === 12) hour = 0;

      let dayOffset = 0;
      if (dayWord === 'ngay mai' || dayWord === 'mai' || dayWord === 'sang mai' || dayWord === 'chieu mai') {
        dayOffset = 1;
      }

      const candidate = buildDateFromParts(now, hour, minute, dayOffset);
      if (!dayWord && candidate.getTime() <= nowMs) candidate.setDate(candidate.getDate() + 1);
      dueAt = candidate;
      matchedText = match[0];
      dueText = `${String(candidate.getHours()).padStart(2, '0')}:${String(candidate.getMinutes()).padStart(2, '0')} ${String(candidate.getDate()).padStart(2, '0')}/${String(candidate.getMonth() + 1).padStart(2, '0')}`;
      break;
    }
  }

  if (!dueAt) return null;

  const cleanedText = raw
    .replace(new RegExp(escapeRegex(matchedText), 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[:,-]\s*/, '')
    .trim();

  const quotedMatch = raw.match(/["“](.+?)["”]/);
  const reminderBody = String(quotedMatch?.[1] || '').trim() || cleanedText || raw;

  return {
    dueAtMs: dueAt.getTime(),
    dueText,
    matchedText,
    repeatEveryMs,
    reminderBody,
    cleanedText: cleanedText || raw,
  };
}

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function loadWorkspacePrompt(workspaceDir) {
  const fileNames = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TEAM.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'RELAY.md'];
  const parts = [];
  for (const fileName of fileNames) {
    const content = await safeRead(path.join(workspaceDir, fileName));
    if (!content.trim()) continue;
    parts.push(`\n# File: ${fileName}\n${content.trim()}`);
  }
  return parts.join('\n');
}

function resolveOpenAiLikeProvider(config, modelRef) {
  const providers = config?.models?.providers || {};
  const preferredKey = String(modelRef || '').split('/')[0] || '';
  const preferred = providers[preferredKey];
  if (preferred?.baseUrl && preferred?.apiKey && preferred?.api === 'openai-completions') {
    return preferred;
  }
  for (const provider of Object.values(providers)) {
    if (provider?.baseUrl && provider?.apiKey && provider?.api === 'openai-completions') {
      return provider;
    }
  }
  return null;
}

async function callOpenAiLikeModel(config, modelRef, messages, logger) {
  const provider = resolveOpenAiLikeProvider(config, modelRef);
  if (!provider) throw new Error('No OpenAI-compatible provider found for relay plugin.');

  const baseUrl = String(provider.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(provider.apiKey || '').trim();
  const model = stripProviderPrefix(modelRef);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn(`relay llm request failed: ${response.status} ${body.slice(0, 300)}`);
    throw new Error(`Relay LLM request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map((item) => item?.text || '').join('').trim();
    if (text) return text;
  }
  throw new Error('Relay LLM response was empty.');
}

async function resolveTelegramUsernames(config, agents) {
  await Promise.all(agents.map(async (agent) => {
    if (agent.username) return;
    const token = String(agent.token || '').trim();
    if (!token) return;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const payload = await response.json();
      const username = payload?.result?.username;
      if (username) agent.username = String(username).toLowerCase();
    } catch {
      // Best effort only.
    }
  }));
}

function resolveTelegramAccountToken(config, accountId) {
  return String(config?.channels?.telegram?.accounts?.[accountId]?.botToken || '').trim();
}

async function fetchTelegramChatInfo(config, accountId, chatIdInput, logger) {
  const token = resolveTelegramAccountToken(config, accountId);
  if (!token) return null;
  const chatId = String(chatIdInput || '').trim();
  if (!chatId) return null;

  const response = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: /^-?\d+$/.test(chatId) ? Number(chatId) : chatId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.debug?.(`relay getChat http failed for ${accountId}: ${response.status} ${body.slice(0, 200)}`);
    return null;
  }

  const payload = await response.json();
  if (!payload?.ok) {
    logger.debug?.(`relay getChat api failed for ${accountId}: ${JSON.stringify(payload).slice(0, 200)}`);
    return null;
  }

  return payload?.result || null;
}

function pickAvailableReaction(chatInfo) {
  const available = chatInfo?.available_reactions;
  if (!available) return REACTION_CANDIDATES[0];
  if (available === 'all') return REACTION_CANDIDATES[0];
  if (!Array.isArray(available)) return null;

  const emojis = available
    .map((item) => item?.type === 'emoji' ? item?.emoji : null)
    .filter(Boolean);

  for (const emoji of REACTION_CANDIDATES) {
    if (emojis.includes(emoji)) return emoji;
  }
  return emojis[0] || null;
}

async function sendTelegramText(config, accountId, to, text, opts = {}) {
  const token = resolveTelegramAccountToken(config, accountId);
  if (!token) throw new Error(`missing token for ${accountId}`);

  const payload = {
    chat_id: /^-?\d+$/.test(String(to)) ? Number(to) : String(to),
    text: String(text || ''),
    reply_parameters: opts.replyToMessageId ? { message_id: Number(opts.replyToMessageId) } : undefined,
    message_thread_id: opts.messageThreadId ? Number(opts.messageThreadId) : undefined,
  };

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sendMessage http ${response.status}: ${body.slice(0, 200)}`);
  }

  const result = await response.json();
  if (!result?.ok) {
    throw new Error(`sendMessage api failed: ${String(result?.description || 'unknown error')}`);
  }

  return {
    messageId: String(result?.result?.message_id || ''),
    chatId: String(result?.result?.chat?.id || to),
  };
}

async function reactMessageTelegram(config, accountId, chatIdInput, messageIdInput, emoji, logger) {
  const token = resolveTelegramAccountToken(config, accountId);
  if (!token) return { ok: false, warning: `missing token for ${accountId}` };

  const chatId = String(chatIdInput || '').trim();
  const messageId = Number(messageIdInput || 0);
  if (!chatId || !messageId) return { ok: false, warning: 'missing chatId or messageId' };

  const response = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: /^-?\d+$/.test(chatId) ? Number(chatId) : chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
      is_big: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.debug?.(`relay reaction http failed for ${accountId}: ${response.status} ${body.slice(0, 200)}`);
    return { ok: false, warning: `http ${response.status}` };
  }

  const payload = await response.json();
  if (!payload?.ok) {
    logger.debug?.(`relay reaction api failed for ${accountId}: ${JSON.stringify(payload).slice(0, 200)}`);
    return { ok: false, warning: String(payload?.description || 'telegram api error') };
  }

  return { ok: true };
}

async function loadReminderStore(storePath) {
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs.filter(Boolean) : [],
    };
  } catch {
    return { version: 1, jobs: [] };
  }
}

async function saveReminderStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({
    version: 1,
    jobs: Array.isArray(store?.jobs) ? store.jobs.filter(Boolean) : [],
  }, null, 2), 'utf8');
}

function buildReminderMessage(recipientMention, reminderBody) {
  const prefix = String(recipientMention || '').trim();
  const body = String(reminderBody || '').trim();
  return prefix ? `${prefix} ${body}`.trim() : body;
}

function extractJsonPayload(raw) {
  const text = String(raw || '').trim();
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start = firstBrace >= 0 && firstBracket >= 0 ? Math.min(firstBrace, firstBracket) : Math.max(firstBrace, firstBracket);
  if (start < 0) throw new Error(`Unable to parse gateway response: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

function buildReminderJobName(input) {
  return `telegram-relay:${input.accountId}:${input.to}:${randomUUID().slice(0, 8)}`;
}

function createReminderManager(logger, runtime) {
  const runGatewayCall = async (method, params) => {
    const res = await runtime.system.runCommandWithTimeout(
      ['openclaw', 'gateway', 'call', method, '--params', JSON.stringify(params || {})],
      { timeoutMs: 30_000 },
    );
    if (res.code !== 0) {
      throw new Error((res.stderr || res.stdout || `gateway call failed: ${method}`).trim());
    }
    return extractJsonPayload(res.stdout);
  };

  const listPluginJobs = async () => {
    const payload = await runGatewayCall('cron.list', { includeDisabled: true, limit: 200 });
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return jobs.filter((job) => String(job?.name || '').startsWith('telegram-relay:'));
  };

  return {
    async start() {
      const payload = await runGatewayCall('cron.status', {});
      logger.info(`relay reminder cron ready storePath=${payload?.storePath || 'unknown'} jobs=${payload?.jobs ?? 'n/a'}`);
    },
    async ensureStarted() {
      return await this.start();
    },
    async stop() {
      return;
    },
    async schedule(input) {
      const schedule = Number(input.repeatEveryMs || 0) > 0
        ? { kind: 'every', everyMs: Number(input.repeatEveryMs), anchorMs: Number(input.dueAtMs) }
        : { kind: 'at', at: new Date(Number(input.dueAtMs)).toISOString() };
      const params = {
        agentId: String(input.agentId || ''),
        name: buildReminderJobName(input),
        description: `Telegram relay reminder for ${input.accountId}`,
        enabled: true,
        deleteAfterRun: Number(input.repeatEveryMs || 0) <= 0,
        schedule,
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: {
          kind: 'systemEvent',
          text: String(input.text || ''),
        },
        delivery: {
          mode: 'announce',
          channel: 'telegram',
          to: String(input.to),
          accountId: String(input.accountId),
          threadId: input.messageThreadId ?? undefined,
          bestEffort: true,
        },
      };
      const job = await runGatewayCall('cron.add', params);
      logger.info(`relay reminder scheduled job=${job?.id || 'unknown'} via native cron`);
      return job;
    },
    async clearAll() {
      const jobs = await listPluginJobs();
      for (const job of jobs) {
        await runGatewayCall('cron.remove', { id: job.id });
      }
      logger.info(`relay reminder cleared jobs=${jobs.length} via native cron`);
      return { removed: jobs.length };
    },
    async clearByAccount(accountId) {
      const jobs = await listPluginJobs();
      const matched = jobs.filter((job) => String(job?.delivery?.accountId || '') === String(accountId || ''));
      for (const job of matched) {
        await runGatewayCall('cron.remove', { id: job.id });
      }
      logger.info(`relay reminder cleared account=${accountId} jobs=${matched.length} via native cron`);
      return { removed: matched.length };
    },
  };
}

function buildAgentState(config, previousAgents = []) {
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  const accounts = config?.channels?.telegram?.accounts || {};
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const previousById = new Map(previousAgents.map((agent) => [agent.agentId, agent]));

  return list.map((agent) => {
    const binding = bindings.find((item) => item?.agentId === agent.id && item?.match?.channel === 'telegram');
    const accountId = binding?.match?.accountId || 'default';
    const name = String(agent.name || agent.id || '').trim();
    const foldedName = foldText(name);
    const foldedId = foldText(agent.id);
    const aliases = new Set([foldedName, foldedId].filter(Boolean));
    if (foldedName.endsWith('s') && foldedName.length > 1) aliases.add(foldedName.slice(0, -1));
    if (foldedId.endsWith('s') && foldedId.length > 1) aliases.add(foldedId.slice(0, -1));
    const previous = previousById.get(agent.id);
    return {
      agentId: agent.id,
      accountId,
      name,
      foldedName,
      aliases: Array.from(aliases),
      workspaceDir: agent.workspace,
      token: accounts?.[accountId]?.botToken || '',
      username: previous?.username || '',
      model: agent?.model?.primary || config?.agents?.defaults?.model?.primary || 'smart-route',
    };
  });
}

function detectRelayIntent(foldedText, agents) {
  const intentSpecs = [
    {
      kind: 'question',
      verbs: ['hoi nguoc lai', 'hoi tiep', 'hoi them', 'hoi giup', 'bao hoi', 'nho hoi', 'hoi lai', 'hoi'],
    },
    {
      kind: 'task',
      verbs: ['giao viec', 'giao task', 'soan task', 'nhac viec', 'nhac', 'bao', 'noi voi', 'yeu cau'],
    },
  ];

  for (const caller of agents) {
    for (const target of agents) {
      if (caller.agentId === target.agentId) continue;
      const callerPattern = buildAliasPattern(caller);
      const targetPattern = buildAliasPattern(target);
      for (const spec of intentSpecs) {
        const regex = new RegExp(`\\b(?:${callerPattern})\\s+(?:${spec.verbs.map((item) => escapeRegex(item)).join('|')})\\s+(?:cho\\s+)?(?:${targetPattern})\\b([\\s\\S]*)`, 'i');
        const match = foldedText.match(regex);
        if (!match) continue;
        const bodyTail = cleanQuestionTail(match[1] || '');
        return {
          kind: spec.kind,
          caller,
          target,
          bodyTail,
          reminder: spec.kind === 'task' ? parseReminderSpec(bodyTail) : null,
        };
      }
    }
  }
  return null;
}

function detectOwner(event, currentAccountId, agents) {
  const rawLower = String(event.content || event.body || '').toLowerCase();
  const exactMentionMatches = agents.filter((agent) => agent.username && rawLower.includes(`@${String(agent.username).toLowerCase()}`));
  if (exactMentionMatches.length === 1) return exactMentionMatches[0].accountId;

  const folded = foldText(event.content || event.body || '');
  const matchedAgents = agents.filter((agent) => {
    if (!agent.username) return agent.aliases.some((alias) => alias && folded.includes(alias));
    return agent.aliases.some((alias) => alias && folded.includes(alias)) || folded.includes(`@${agent.username}`);
  });

  if (matchedAgents.length === 1) return matchedAgents[0].accountId;
  if (event.wasMentioned) return currentAccountId;
  return null;
}

function detectClearRemindersIntent(text, agents) {
  const folded = foldText(text);
  if (!folded) return null;
  const hasDelete = ['xoa', 'xoa het', 'huy', 'dung', 'clear', 'remove'].some((item) => folded.includes(item));
  const hasReminderTarget = ['cron', 'lich nhac', 'nhac hen', 'reminder', 'lich hen'].some((item) => folded.includes(item));
  if (!hasDelete || !hasReminderTarget) return null;

  const matchedAgents = (agents || []).filter((agent) => {
    if (agent.username && folded.includes(`@${agent.username}`)) return true;
    return (agent.aliases || []).some((alias) => alias && folded.includes(alias));
  });

  if (matchedAgents.length === 1) {
    return { targetAccountId: matchedAgents[0].accountId };
  }

  return { targetAccountId: null };
}

function buildQuestionPrompt(caller, target) {
  return [
    {
      role: 'system',
      content: 'You generate one short, natural Telegram group question in Vietnamese. Output question text only, with no quotes and no explanation.',
    },
    {
      role: 'user',
      content: `You are ${caller.name}. Ask ${target.name} exactly one useful question related to ${target.name}'s role. Keep it under 24 words.`,
    },
  ];
}

function buildTaskPrompt(caller, target) {
  return [
    {
      role: 'system',
      content: 'You generate one short, natural Telegram task assignment in Vietnamese. Output task text only, with no quotes and no explanation.',
    },
    {
      role: 'user',
      content: `You are ${caller.name}. Assign ${target.name} exactly one concrete task related to ${target.name}'s role. Keep it under 28 words.`,
    },
  ];
}

function buildAnswerPrompt(targetPrompt, caller, target, userText, questionText) {
  return [
    {
      role: 'system',
      content: `${targetPrompt}\n\nYou are replying publicly in a Telegram group. If you are clearly being addressed, assume a short reaction has already been sent before your text reply. Reply in Vietnamese. Stay concise, practical, and in-character.`,
    },
    {
      role: 'user',
      content: `Original user request:\n${userText}\n\n${caller.name} asks ${target.name} this question:\n${questionText}\n\nReply as ${target.name} only. Do not mention internal handoff.`,
    },
  ];
}

function buildTaskAckPrompt(targetPrompt, caller, target, userText, taskText, reminder, reminderStatus) {
  const reminderLine = reminder && reminderStatus === 'scheduled'
    ? `\nReminder scheduled for: ${reminder.dueText}`
    : reminder && reminderStatus === 'failed'
      ? `\nReminder requested for: ${reminder.dueText}, but scheduling failed.`
      : '';
  return [
    {
      role: 'system',
      content: `${targetPrompt}\n\nYou are replying publicly in a Telegram group. If you are clearly being addressed, assume a short reaction has already been sent before your text reply. Reply in Vietnamese. Confirm the assignment, say the first action, and stay concise and in-character.`,
    },
    {
      role: 'user',
      content: `Original user request:\n${userText}\n\n${caller.name} assigns ${target.name} this task:\n${taskText}${reminderLine}\n\nReply as ${target.name} only. Confirm ownership, say what you will do first. If reminderStatus is scheduled, mention that you set the reminder. If reminderStatus is failed, say you got the task but reminder setup failed.`,
    },
  ];
}

async function maybeReact(accountId, chatId, messageId, cfg, logger, reactionCache) {
  if (!chatId || !messageId) return;
  try {
    const cacheKey = `${accountId}:${chatId}`;
    let reactionEmoji = reactionCache.get(cacheKey);
    if (!reactionEmoji) {
      const chatInfo = await fetchTelegramChatInfo(cfg, accountId, chatId, logger);
      reactionEmoji = pickAvailableReaction(chatInfo);
      if (reactionEmoji) reactionCache.set(cacheKey, reactionEmoji);
    }
    if (!reactionEmoji) return false;

    const result = await reactMessageTelegram(cfg, accountId, chatId, messageId, reactionEmoji, logger);
    if (!result?.ok && String(result?.warning || '').includes('REACTION_INVALID')) {
      reactionCache.delete(cacheKey);
    }
    return result?.ok === true;
  } catch (error) {
    logger.debug?.(`relay reaction failed for ${accountId}: ${String(error)}`);
    return false;
  }
}

async function runRelayFlow(api, event, relayIntent, reminderManager, reactionCache) {
  const cfg = api.config;
  const logger = api.logger;
  const chatId = String(event.conversationId || '');
  const messageId = Number(event.messageId || 0) || undefined;
  const messageThreadId = event.threadId ? Number(event.threadId) : undefined;
  const senderUsername = String(event.senderUsername || '').trim();
  const recipientMention = senderUsername ? `@${senderUsername.replace(/^@+/, '')}` : '';

  const caller = relayIntent.caller;
  const target = relayIntent.target;
  const callerReacted = await maybeReact(caller.accountId, chatId, messageId, cfg, logger, reactionCache);
  const callerPrompt = await loadWorkspacePrompt(caller.workspaceDir);
  const targetPrompt = await loadWorkspacePrompt(target.workspaceDir);
  const targetReacted = await maybeReact(target.accountId, chatId, messageId, cfg, logger, reactionCache);

  if (relayIntent.kind === 'question') {
    let questionText = relayIntent.bodyTail;
    if (isGenericQuestionRequest(questionText)) {
      questionText = await callOpenAiLikeModel(cfg, caller.model, buildQuestionPrompt(caller, target), logger);
    }
    if (!questionText.endsWith('?')) questionText += '?';

    await sendTelegramText(cfg, caller.accountId, chatId, `${callerReacted ? '' : `${ACK_FALLBACK} `}${target.name} oi, ${questionText}`, {
      replyToMessageId: messageId,
      messageThreadId,
    });

    const answerText = await callOpenAiLikeModel(
      cfg,
      target.model,
      buildAnswerPrompt(targetPrompt || callerPrompt, caller, target, String(event.content || event.body || ''), questionText),
      logger,
    );

    await sendTelegramText(cfg, target.accountId, chatId, `${targetReacted ? '' : `${ACK_FALLBACK} `}${answerText}`, {
      messageThreadId,
    });
    return;
  }

  let taskText = relayIntent.bodyTail;
  if (isGenericTaskRequest(taskText)) {
    taskText = await callOpenAiLikeModel(cfg, caller.model, buildTaskPrompt(caller, target), logger);
  }

  await sendTelegramText(cfg, caller.accountId, chatId, `${callerReacted ? '' : `${ACK_FALLBACK} `}${target.name} oi, ${taskText}`, {
    replyToMessageId: messageId,
    messageThreadId,
  });

  let reminderStatus = 'none';
  if (relayIntent.reminder) {
    try {
      await reminderManager.schedule({
        kind: Number(relayIntent.reminder.repeatEveryMs || 0) > 0 ? 'repeat' : 'one-shot',
        dueAtMs: relayIntent.reminder.dueAtMs,
        repeatEveryMs: Number(relayIntent.reminder.repeatEveryMs || 0),
        agentId: target.agentId,
        accountId: target.accountId,
        to: chatId,
        messageThreadId,
        text: buildReminderMessage(recipientMention, relayIntent.reminder.reminderBody || relayIntent.reminder.cleanedText || taskText),
      });
      reminderStatus = 'scheduled';
    } catch (error) {
      reminderStatus = 'failed';
      logger.warn(`relay reminder schedule failed: ${String(error)}`);
    }
  }

  const ackText = await callOpenAiLikeModel(
    cfg,
    target.model,
    buildTaskAckPrompt(
      targetPrompt || callerPrompt,
      caller,
      target,
      String(event.content || event.body || ''),
      relayIntent.reminder?.cleanedText || taskText,
      relayIntent.reminder,
      reminderStatus,
    ),
    logger,
  );

  await sendTelegramText(cfg, target.accountId, chatId, `${targetReacted ? '' : `${ACK_FALLBACK} `}${ackText}`, {
    messageThreadId,
  });
}

async function handleTelegramGroupTurn(api, event, ctx, agents, recentTurns, reminderManager, reactionCache) {
  const logger = api.logger;
  const content = String(event.content || event.body || '').trim();
  if (!content) return;

  const rawLower = content.toLowerCase();
  const folded = foldText(content);
  const clearReminders = detectClearRemindersIntent(content, agents);
  const cacheKey = buildTurnCacheKey({
    content,
    senderId: event.senderId || ctx.senderId,
    timestamp: event.timestamp,
    conversationId: ctx.conversationId,
  });
  const recent = recentTurns.get(cacheKey);
  const relayIntent = recent?.relayIntent || detectRelayIntent(folded, agents);
  logger.info(
    `relay dispatch account=${ctx.accountId || 'default'} text="${content.slice(0, 180)}" relay=${relayIntent ? `${relayIntent.kind}:${relayIntent.caller.accountId}->${relayIntent.target.accountId}` : 'none'}`,
  );

  if (relayIntent) {
    if (ctx.accountId !== relayIntent.caller.accountId) {
      logger.info(`relay dispatch suppress non-caller account=${ctx.accountId || 'default'} expected=${relayIntent.caller.accountId}`);
      return { handled: true };
    }

    try {
      logger.info(`relay dispatch handling caller=${relayIntent.caller.accountId} target=${relayIntent.target.accountId}`);
      await runRelayFlow(api, {
        ...event,
        content,
        conversationId: ctx.conversationId,
        threadId: ctx.threadId,
        senderUsername: event.senderUsername || ctx.senderUsername,
      }, relayIntent, reminderManager, reactionCache);
    } catch (error) {
      logger.warn(`relay flow failed: ${String(error)}`);
    }
    return { handled: true };
  }

  const exactMentionMatches = agents.filter((agent) => agent.username && rawLower.includes(`@${String(agent.username).toLowerCase()}`));
  const ownerAccountId = exactMentionMatches.length === 1
    ? exactMentionMatches[0].accountId
    : (recent?.ownerAccountId || detectOwner({ ...event, content }, ctx.accountId || 'default', agents));
  logger.info(`relay dispatch owner current=${ctx.accountId || 'default'} owner=${ownerAccountId || 'none'}`);
  if (ownerAccountId && ownerAccountId !== ctx.accountId) {
    logger.info(`relay dispatch suppress non-owner current=${ctx.accountId || 'default'} owner=${ownerAccountId}`);
    return { handled: true };
  }

  if (clearReminders) {
    try {
      const result = clearReminders.targetAccountId
        ? await reminderManager.clearByAccount(clearReminders.targetAccountId)
        : await reminderManager.clearAll();
      const reacted = await maybeReact(ctx.accountId || 'default', String(ctx.conversationId || ''), Number(event.messageId || 0) || undefined, api.config, logger, reactionCache);
      const prefix = reacted ? '' : `${ACK_FALLBACK} `;
      const targetAgent = clearReminders.targetAccountId
        ? agents.find((agent) => agent.accountId === clearReminders.targetAccountId)
        : null;
      const text = result.removed > 0
        ? `${prefix}Da xoa ${result.removed} lich nhac dang chay${targetAgent ? ` cua ${targetAgent.name}` : ''}.`
        : `${prefix}Khong con lich nhac nao dang chay${targetAgent ? ` cua ${targetAgent.name}` : ''} de xoa.`;
      await sendTelegramText(api.config, ctx.accountId || 'default', String(ctx.conversationId || ''), text, {
        replyToMessageId: Number(event.messageId || 0) || undefined,
        messageThreadId: ctx.threadId ? Number(ctx.threadId) : undefined,
      });
    } catch (error) {
      logger.warn(`relay clear reminders failed: ${String(error)}`);
    }
    return { handled: true };
  }

  return undefined;
}

const plugin = definePluginEntry({
  id: 'telegram-multibot-relay',
  name: 'Telegram Multibot Relay',
  description: 'Relay Telegram multibot turns, task delegation, reminders, and suppress wrong-account replies.',
  kind: 'runtime',
  configSchema: emptyPluginConfigSchema,
  register(api) {
    const logger = api.logger;
    let agents = buildAgentState(api.config);
    let usernamesReady = false;
    const recentTurns = new Map();
    const reactionCache = new Map();
    const reminderManager = createReminderManager(logger, api.runtime);

    api.registerService({
      id: 'telegram-multibot-relay-reminders',
      async start() {
        await reminderManager.start();
      },
      async stop() {
        await reminderManager.stop();
      },
    });

    api.on('gateway_start', async () => {
      agents = buildAgentState(api.config, agents);
      await resolveTelegramUsernames(api.config, agents);
      usernamesReady = true;
      for (const agent of agents) {
        logger.info(`relay account map agent=${agent.agentId} account=${agent.accountId} username=${agent.username || 'none'}`);
      }
      logger.info(`telegram relay loaded for ${agents.length} agent(s)`);
    });

    api.on('inbound_claim', async (event, ctx) => {
      if (event.channel !== 'telegram') return;
      if (!event.isGroup) return;

      agents = buildAgentState(api.config, agents);
      await reminderManager.ensureStarted();
      if (!usernamesReady) {
        await resolveTelegramUsernames(api.config, agents);
        usernamesReady = true;
      }

      const content = String(event.content || event.body || '').trim();
      const cacheKey = buildTurnCacheKey({
        content,
        senderId: event.senderId,
        timestamp: event.timestamp,
        conversationId: event.conversationId,
      });
      recentTurns.set(cacheKey, {
        ownerAccountId: detectOwner(event, ctx.accountId || 'default', agents),
        relayIntent: detectRelayIntent(foldText(content), agents),
        createdAt: Date.now(),
      });
      for (const [key, value] of recentTurns.entries()) {
        if (Date.now() - Number(value?.createdAt || 0) > RECENT_TURN_TTL_MS) {
          recentTurns.delete(key);
        }
      }

      const ownerAccountId = detectOwner(event, ctx.accountId || 'default', agents);
      if (ownerAccountId && ownerAccountId === ctx.accountId) {
        await maybeReact(ownerAccountId, String(event.conversationId || ''), Number(event.messageId || 0) || undefined, api.config, logger, reactionCache);
      }
      return;
    }, { priority: 200 });

    api.on('before_dispatch', async (event, ctx) => {
      if (event.channel !== 'telegram') return;
      if (!event.isGroup) return;

      agents = buildAgentState(api.config, agents);
      await reminderManager.ensureStarted();
      if (!usernamesReady) {
        await resolveTelegramUsernames(api.config, agents);
        usernamesReady = true;
      }

      return await handleTelegramGroupTurn(api, event, ctx, agents, recentTurns, reminderManager, reactionCache);
    }, { priority: 200 });

    api.on('message_sending', async (event) => {
      if (!String(event.to || '').startsWith('telegram:')) return;
      const content = String(event.content || '');
      if (!content.trim()) return;
      if (content.trimStart().startsWith(ACK_FALLBACK)) return;
      return { content: `${ACK_FALLBACK} ${content}` };
    }, { priority: 50 });
  },
});

export default plugin;
