/**
 * VoiceMind TTS Proxy Worker
 * Cloudflare Worker that proxies TTS requests to xAI and ElevenLabs APIs.
 * API keys are supplied per-request by the client — nothing is stored server-side.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(body, { ...init, headers });
}

function jsonError(message, status = 400) {
  return corsResponse(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Route: POST /tts/xai ────────────────────────────────────────────────────
async function handleXaiTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const { text, voice, apiKey } = body;
  if (!text)   return jsonError('Missing required field: text');
  if (!voice)  return jsonError('Missing required field: voice');
  if (!apiKey) return jsonError('Missing required field: apiKey');

  const upstream = await fetch('https://api.x.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-2-aurora',
      input: text,
      voice: voice,
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return jsonError(`xAI API error (${upstream.status}): ${errText}`, upstream.status);
  }

  // Stream audio back to client
  return corsResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
    },
  });
}

// ── Route: POST /tts/elevenlabs ─────────────────────────────────────────────
async function handleElevenLabsTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const { text, voiceId, apiKey } = body;
  if (!text)    return jsonError('Missing required field: text');
  if (!voiceId) return jsonError('Missing required field: voiceId');
  if (!apiKey)  return jsonError('Missing required field: apiKey');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.75,
        similarity_boost: 0.85,
      },
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return jsonError(`ElevenLabs API error (${upstream.status}): ${errText}`, upstream.status);
  }

  // Stream audio back to client
  return corsResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
    },
  });
}

// ── Route: POST /parse ───────────────────────────────────────────────────────
async function handleParse(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const { transcript, openaiKey } = body;
  if (!transcript) return jsonError('Missing required field: transcript');
  if (!openaiKey)  return jsonError('Missing required field: openaiKey');

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a task extraction engine. Given a voice transcript, extract individual tasks and categorize them. Return ONLY a JSON array: [{task: string, category: string}] where category is one of: TASKS, WORK, ERRANDS, PERSONAL, IDEAS. Keep each task concise: verb + noun + essential context only. Remove filler words, stutters, and repetitions. Never merge multiple distinct tasks into one.',
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return jsonError(`OpenAI API error (${upstream.status}): ${errText}`, upstream.status);
  }

  const data = await upstream.json();
  let items;
  try {
    const raw = data.choices[0].message.content.trim();
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    items = JSON.parse(cleaned);
  } catch (e) {
    return jsonError(`Failed to parse OpenAI response as JSON: ${e.message}`);
  }

  return corsResponse(JSON.stringify(items), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Route: GET /health ───────────────────────────────────────────────────────
function handleHealth() {
  return corsResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route dispatch
    if (method === 'POST' && path === '/tts/xai') {
      return handleXaiTts(request);
    }

    if (method === 'POST' && path === '/tts/elevenlabs') {
      return handleElevenLabsTts(request);
    }

    if (method === 'POST' && path === '/parse') {
      return handleParse(request);
    }

    if (method === 'GET' && path === '/health') {
      return handleHealth();
    }

    return jsonError(`Not found: ${method} ${path}`, 404);
  },
};
