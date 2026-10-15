(function (root) {
  'use strict';
  var C = root.DualSubCore;
  if (typeof module !== 'undefined') C = require('./core.js');
  var DEFAULT_MODEL = 'gemini-3.5-flash-lite', DEFAULT_FALLBACK = 'gemini-3.1-flash-lite';
  var prompt = 'Transcribe ALL English speech in this clip verbatim, from the very first second to the end, including narration or voice-over over background music and any cold-open teaser, as natural sentences, one item per sentence, in order. Do not skip any speech. t = the timestamp H:MM:SS of where the sentence starts, measured from the start of the whole video (not the clip). Translate each sentence into concise natural Japanese. Write ja and the ja of each gloss in Japanese only: do not mix in words from Spanish or any other language, except names of people, companies, products and models (e.g. OpenAI, o1). glosses: 0-3 difficult English words or phrases per sentence (exact substrings of en) with short Japanese meanings. Return an empty array only if there is no speech.';
  var schema = { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'STRING' }, en: { type: 'STRING' }, ja: { type: 'STRING' }, glosses: { type: 'ARRAY', maxItems: 3, items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, ja: { type: 'STRING' } }, required: ['word', 'ja'] } } }, required: ['t', 'en', 'ja', 'glosses'] } };
  function buildRequest(id, chunk) {
    return {
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + id }, videoMetadata: { startOffset: Math.floor(chunk.a) + 's', endOffset: Math.ceil(chunk.requestEnd) + 's', fps: 0.2 } },
        { text: prompt }
      ] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 32768, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
    };
  }
  function quotaInfo(data) {
    var details = data && data.error && data.error.details;
    var ids = [], delay = null;
    if (Array.isArray(details)) details.forEach(function (d) {
      if (!d || typeof d !== 'object') return;
      if (Array.isArray(d.violations)) d.violations.forEach(function (v) { if (v && typeof v.quotaId === 'string') ids.push(v.quotaId); });
      if (typeof d.retryDelay === 'string' && /^\d+(\.\d+)?s$/.test(d.retryDelay)) delay = Math.max(delay || 0, Math.ceil(Number(d.retryDelay.slice(0, -1))));
    });
    var kind = ids.some(function (id) { return /perday/i.test(id); }) ? 'day' : ids.length && ids.every(function (id) { return /perminute/i.test(id); }) ? 'minute' : 'unknown';
    return { kind: kind, retryDelay: delay, quotaIds: ids };
  }
  function unreadableVideo(data) {
    var message = data && data.error && data.error.message;
    if (typeof message !== 'string') return false;
    return /(?:video|youtube).*(?:unavailable|not available|private|age.?restrict|not accessible|cannot|can not|could not|failed|unsupported|not found|permission|access denied)/i.test(message) || /(?:cannot|can not|could not|unable|failed).*(?:access|read|fetch|process|download).*(?:video|youtube)/i.test(message);
  }
  function apiError(status, data) {
    var message;
    var quota = status === 429 ? quotaInfo(data) : null;
    if (status === 429) message = quota.kind === 'minute' ? '1分あたりの上限です。待機後に自動再開します。' : '本日の上限の可能性があります。翻訳を停止しました。時間をおいて再開してください。';
    else if (status === 400 && unreadableVideo(data)) message = 'この動画は Gemini で読めません。非公開・年齢制限などを確認してください。';
    else if ([400, 401, 403].includes(status)) message = 'API キー・権限またはリクエスト設定を確認してください。';
    else if (status === 404) message = 'モデル名を確認してください。このモデルは利用できません。';
    else if (status === 500 || status === 503) message = 'Gemini が混雑しています。';
    else message = 'Gemini API に接続できませんでした。';
    var error = new Error(message + '（HTTP ' + status + '）');
    error.status = status; error.kind = 'api';
    if (quota) error.quota = quota;
    return error;
  }
  function finishError(reason) {
    var error = new Error('Gemini の応答が未完了です。');
    error.kind = 'finish'; error.finishReason = reason;
    return error;
  }
  function parseResponse(data) {
    var candidate = data && data.candidates && data.candidates[0];
    if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') throw finishError(candidate.finishReason);
    if (data && data.promptFeedback && data.promptFeedback.blockReason) throw finishError(data.promptFeedback.blockReason);
    if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) throw new Error('Gemini の応答が空です。');
    var text = candidate.content.parts.filter(function (p) { return typeof p.text === 'string' && !p.thought; }).map(function (p) { return p.text; }).join('');
    if (!text.trim()) throw new Error('Gemini の応答が空です。');
    var rows;
    try { rows = JSON.parse(text); } catch (_) { throw new Error('Gemini の JSON 応答が壊れています。再開して再試行してください。'); }
    if (!Array.isArray(rows)) throw new Error('Gemini の応答が文の配列ではありません。');
    return rows;
  }
  function networkError() { var error = new Error('ネットワークに接続できません。通信環境を確認してください。'); error.kind = 'network'; return error; }
  async function request(options, fetcher, model) {
    var Controller = options.AbortController || root.AbortController;
    var controller = new Controller();
    var schedule = options.setTimeout || root.setTimeout.bind(root), cancel = options.clearTimeout || root.clearTimeout.bind(root);
    var timedOut = false;
    var timer = schedule(function () { timedOut = true; controller.abort(); }, 180000);
    try {
      var response;
      try {
        response = await fetcher('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.key }, body: JSON.stringify(buildRequest(options.id, options.chunk)), signal: controller.signal
        });
      } catch (_) { throw networkError(); }
      var data = null;
      if (response.ok || ((response.status === 400 || response.status === 429) && typeof response.json === 'function')) {
        try { data = await response.json(); }
        catch (error) {
          if (timedOut || error.name === 'AbortError' || error instanceof TypeError) throw networkError();
          if (response.ok) throw new Error('Gemini の JSON 応答が壊れています。');
          data = null; // Keep the HTTP status when an error body is malformed.
        }
      }
      return { response: response, data: data };
    } finally { cancel(timer); }
  }
  async function generate(options) {
    var fetcher = options.fetch || root.fetch.bind(root);
    var sleep = options.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    var models = [options.model || DEFAULT_MODEL];
    var fallback = options.fallback || DEFAULT_FALLBACK;
    if (fallback !== models[0]) models.push(fallback);
    for (var m = 0; m < models.length; m++) {
      for (var attempt = 0; attempt < 3; attempt++) {
        if (options.onStatus) options.onStatus('翻訳中：' + models[m] + (attempt ? '（再試行 ' + attempt + '）' : ''));
        if (options.onRequest) options.onRequest();
        var received = await request(options, fetcher, models[m]), response = received.response;
        if (response.ok) return parseResponse(received.data);
        // Only selected safe fields leave this function; response text is never displayed.
        var error = apiError(response.status, received.data);
        if (response.status !== 500 && response.status !== 503) throw error;
        if (attempt < 2) {
          var delay = attempt === 0 ? 5000 : 15000;
          if (options.onStatus) options.onStatus('Gemini が混雑しています。' + delay / 1000 + '秒後に再試行します。');
          await sleep(delay);
        } else if (m === models.length - 1) throw error;
      }
    }
  }
  async function generateWithQuality(options) {
    var rows = await generate(options), result = C.acceptSentences(rows, options.chunk, []);
    var quality = C.responseQuality(result, options.chunk);
    if (quality.thin) {
      if (options.onStatus) options.onStatus('発話が少ないため、この区間を1回だけ取り直します。');
      try {
        var secondRows = await generate(options), second = C.acceptSentences(secondRows, options.chunk, []);
        if (!result.accepted.length && !second.accepted.length) {
          if ((rows.length && !result.validCount) || (secondRows.length && !second.validCount)) throw emptyError();
          result.skip = true;
          return result;
        }
        if (C.responseQuality(second, options.chunk).words > quality.words) result = second;
        else if (!result.validCount && second.validCount) result = second;
      } catch (error) {
        if (!result.accepted.length) {
          if (error.kind === 'network' || error.kind === 'empty' || error.status) throw error;
          throw emptyError();
        }
        result.retakeFailed = true;
        if (options.onStatus) options.onStatus('取り直しに失敗したため、初回の有効な結果を使用します。');
      }
    }
    if (rows.length && !result.validCount) throw new Error('区間内の有効な英文がありません。時刻または応答形式を確認して再開してください。');
    return result;
  }
  function emptyError() { var error = new Error('区間内の有効な英文が0件です。保存せず再試行します。'); error.kind = 'empty'; return error; }
  function chunkOutput(chunk, result) { return result.skip ? { segments: [], skipped: [[chunk.a, chunk.b]] } : { segments: [{ chunk: chunk, result: result }], skipped: [] }; }
  async function processChunk(options) {
    try { return chunkOutput(options.chunk, await generateWithQuality(options)); }
    catch (error) {
      if (error.kind !== 'finish') throw error;
      if (options.onStatus) options.onStatus('応答が未完了のため、区間を半分に分けて1回試します。');
      var chunk = options.chunk, mid = (chunk.a + chunk.b) / 2;
      var halves = [Object.assign({}, chunk, { b: mid, requestEnd: Math.min(chunk.requestEnd, mid + 20) }), Object.assign({}, chunk, { a: mid, dropLeading: true })];
      var output = { segments: [], skipped: [] };
      for (var i = 0; i < halves.length; i++) {
        try {
          var result = await generateWithQuality(Object.assign({}, options, { chunk: halves[i] }));
          var child = chunkOutput(halves[i], result);
          output.segments = output.segments.concat(child.segments); output.skipped = output.skipped.concat(child.skipped);
          if (i === 0 && !result.skip && result.handoff && result.next < chunk.b) { halves[1].a = Math.min(result.next, halves[0].requestEnd); halves[1].dropLeading = halves[1].a !== result.next; }
        } catch (childError) {
          if (childError.kind !== 'finish') { childError.partial = output; throw childError; }
          output.skipped.push([halves[i].a, halves[i].b]);
          if (i === 0) halves[1].dropLeading = false;
        }
      }
      return output;
    }
  }
  var api = { DEFAULT_MODEL: DEFAULT_MODEL, DEFAULT_FALLBACK: DEFAULT_FALLBACK, prompt: prompt, schema: schema, buildRequest: buildRequest, quotaInfo: quotaInfo, apiError: apiError, parseResponse: parseResponse, generate: generate, generateWithQuality: generateWithQuality, processChunk: processChunk };
  if (typeof module !== 'undefined') module.exports = api;
  root.DualSubGemini = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
