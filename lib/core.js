(function (root) {
  'use strict';
  function videoId(input) {
    if (typeof input !== 'string') return null;
    var value = input.trim();
    if (/^[\w-]{11}$/.test(value)) return value;
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      var host = url.hostname.toLowerCase();
      var id = null;
      if (host === 'youtu.be') id = url.pathname.split('/')[1];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else if (/^\/(shorts|live)\//.test(url.pathname)) id = url.pathname.split('/')[2];
      }
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch (_) { return null; }
  }
  function parseTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    var s = value.trim();
    if (/^\d+(\.\d+)?s?$/.test(s)) return Number(s.replace(/s$/, ''));
    if (!/^\d+:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(s)) return null;
    var parts = s.split(':').map(Number);
    if (parts[parts.length - 1] >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
    return parts.reduce(function (total, n) { return total * 60 + n; }, 0);
  }
  function planChunk(start, duration, first, ranges) {
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 0 || start < 0 || (duration > 0 && start >= duration)) return null;
    var limit = duration > 0 ? duration : Infinity;
    var end = Math.min(limit, start + (first || !duration ? 120 : 240));
    var following = (ranges || []).filter(function (r) { return r[0] > start; }).reduce(function (limit, r) { return Math.min(limit, r[0]); }, Infinity);
    if (following >= end && following - end < 15) end = Math.min(limit, following);
    end = Math.min(end, following);
    if (end - start < 15) return { a: start, b: end, requestEnd: end, skip: true };
    return { a: start, b: end, requestEnd: Math.min(limit, following, end + 20) };
  }
  function normalizeEnglish(s) {
    return s.toLowerCase().normalize('NFKC').replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function validateGlosses(en, glosses) {
    if (!Array.isArray(glosses)) return [];
    var seen = new Set();
    return glosses.filter(function (g) {
      if (!g || typeof g.word !== 'string' || typeof g.ja !== 'string' || !g.word.trim() || !g.ja.trim()) return false;
      var word = g.word.trim().toLowerCase();
      var index = en.toLowerCase().indexOf(word);
      if (index < 0 || seen.has(word)) return false;
      // Do not annotate "he" inside "the", or overlapping phrases.
      var before = en[index - 1] || '', after = en[index + word.length] || '';
      if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) return false;
      seen.add(word);
      return true;
    }).slice(0, 3).map(function (g) { return { word: g.word.trim(), ja: g.ja.trim() }; });
  }
  function mergeSentences(existing, incoming, joins) {
    var merged = existing.slice(), used = new Set();
    incoming.forEach(function (s) {
      // Compare against the original existing batch only, never another new sentence.
      var duplicate = existing.findIndex(function (old, index) {
        return !used.has(index) && Math.abs(old.seconds - s.seconds) <= 8 && (joins || []).some(function (join) { return Math.abs(old.seconds - join) <= 8 && Math.abs(s.seconds - join) <= 8; }) && Math.min(wordCount(old.en), wordCount(s.en)) >= 4 && wordOverlap(old.en, s.en, true) >= 0.8;
      });
      if (duplicate < 0) merged.push(s);
      else {
        used.add(duplicate);
        var old = existing[duplicate], chosen = wordCount(s.en) > wordCount(old.en) ? s : old;
        var earlier = s.seconds < old.seconds ? s : old;
        merged[duplicate] = Object.assign({}, chosen, { seconds: earlier.seconds, t: earlier.t });
      }
    });
    return merged.sort(function (x, y) { return x.seconds - y.seconds; });
  }
  function mergeImportedSentences(existing, incoming, joins, ranges) {
    // Identical backup records are copies, not a fresh transcription batch.
    // Count them so repeated utterances within either backup remain intact.
    var copies = new Map();
    function key(s) { return JSON.stringify([s.seconds, s.en]); }
    existing.forEach(function (s) { var k = key(s); copies.set(k, (copies.get(k) || 0) + 1); });
    var fresh = incoming.filter(function (s) {
      if ((ranges || []).some(function (r) { return s.seconds >= r[0] + 8 && s.seconds <= r[1] - 8; })) return false;
      var k = key(s), count = copies.get(k) || 0;
      if (!count) return true;
      copies.set(k, count - 1); return false;
    });
    return mergeSentences(existing, fresh, joins);
  }
  function acceptSentences(rows, chunk, existing) {
    if (!Array.isArray(rows)) throw new Error('文の配列が返されませんでした。');
    var valid = rows.map(function (row) {
      if (!row || typeof row.en !== 'string' || typeof row.ja !== 'string' || !row.en.trim() || !row.ja.trim()) return null;
      var t = parseTime(row.t);
      if (t === null || t < chunk.a - 5 || t > chunk.b + 25) return null;
      return { t: String(row.t), seconds: t, en: row.en.trim(), ja: row.ja.trim(), glosses: validateGlosses(row.en, row.glosses) };
    }).filter(Boolean).sort(function (x, y) { return x.seconds - y.seconds; });
    var accepted = valid.filter(function (s) { return s.seconds < chunk.b; });
    var rejected = valid.find(function (s) { return s.seconds >= chunk.b; });
    var next = rejected ? Math.max(chunk.a + 1, rejected.seconds - 1) : chunk.b;
    return { sentences: mergeSentences(existing || [], accepted, [chunk.a, chunk.b]), accepted: accepted, next: next, handoff: !!rejected, validCount: valid.length };
  }
  function wordCount(en) { var text = normalizeEnglish(en); return text ? text.split(/\s+/).length : 0; }
  function wordOverlap(a, b, shorter) {
    var wordsA = normalizeEnglish(a).split(/\s+/).filter(Boolean), wordsB = normalizeEnglish(b).split(/\s+/).filter(Boolean);
    var counts = new Map(), overlap = 0;
    wordsA.forEach(function (w) { counts.set(w, (counts.get(w) || 0) + 1); });
    wordsB.forEach(function (w) { if (counts.get(w) > 0) { overlap++; counts.set(w, counts.get(w) - 1); } });
    return wordsA.length && wordsB.length ? overlap / (shorter ? Math.min(wordsA.length, wordsB.length) : Math.max(wordsA.length, wordsB.length)) : 0;
  }
  function responseQuality(result, chunk) {
    var words = mergeSentences([], result.accepted).reduce(function (total, s) { return total + wordCount(s.en); }, 0);
    return { words: words, thin: words < (chunk.b - chunk.a) * 0.8 || (!!result.accepted.length && result.accepted[0].seconds - chunk.a >= 30) };
  }
  function nextChunk(ranges, skipped, time, duration, state, pausedBlocked) {
    if (state !== 1 && pausedBlocked) return null;
    var effective = ranges.slice();
    (skipped || []).forEach(function (r) { effective = addRange(effective, r[0], r[1]); });
    var end = coverageEnd(effective, time);
    if (duration > 0 && end >= duration) return null;
    if (state === 1) { if (end - time >= 150) return null; }
    else if (end > time) {
      // A failed current interval may be bypassed once to the next useful interval.
      var skippedEnd = coverageEnd(skipped || [], time);
      if (skippedEnd === time || end > skippedEnd) return null;
    }
    return planChunk(end, duration, end === time, effective);
  }
  function repeatTarget(sentences, index, time) {
    if (index < 0 || !sentences[index]) return null;
    if (index > 0 && time - sentences[index].seconds <= 1.5 && time - sentences[index - 1].seconds <= 30) index--;
    return Math.max(0, sentences[index].seconds - 0.5);
  }
  function shouldReadPosition(state) { return state === 1 || state === 2 || state === 0; }
  function clampPosition(time, duration) { return duration > 0 && Number.isFinite(duration) ? Math.min(Math.max(0, time), duration) : Math.max(0, time); }
  function shouldPauseSentence(previousIndex, index, previousPosition, position) { return previousIndex >= 0 && index === previousIndex + 1 && position > previousPosition && position - previousPosition <= 1.5; }
  function recoveryPlan(error, attempts) {
    if (error.kind === 'network' || error.kind === 'empty') return attempts.network < 1 ? { delay: 10, counter: 'network' } : { delay: null, foreground: true };
    if (error.status === 500 || error.status === 503) return attempts.server < 3 ? { delay: 60, counter: 'server' } : { delay: null };
    if (error.status === 429 && error.quota && error.quota.kind === 'minute') return { delay: error.quota.retryDelay || 60 };
    return { delay: null };
  }
  function currentSentence(sentences, time) {
    var lo = 0, hi = sentences.length - 1, answer = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (sentences[mid].seconds <= time) { answer = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return answer;
  }
  function addRange(ranges, start, end) {
    var result = [];
    ranges.concat([[start, end]]).sort(function (x, y) { return x[0] - y[0]; }).forEach(function (r) {
      var last = result[result.length - 1];
      if (last && r[0] <= last[1] + 0.05) last[1] = Math.max(last[1], r[1]);
      else result.push(r.slice());
    });
    return result;
  }
  function coverageEnd(ranges, time) {
    var range = ranges.find(function (r) { return time >= r[0] && time < r[1]; });
    return range ? range[1] : time;
  }
  function emptyCache(id) { return { version: 1, id: id, title: '', updated: 0, position: 0, duration: 0, ranges: [], sentences: [], boundaries: [] }; }
  function decodeCache(raw, id) {
    try {
      var v = JSON.parse(raw);
      if (!v || v.version !== 1 || v.id !== id || !Array.isArray(v.ranges) || !Array.isArray(v.sentences)) return emptyCache(id);
      var out = emptyCache(id);
      out.title = typeof v.title === 'string' ? v.title : '';
      out.position = parseTime(v.position) || 0;
      out.updated = Number.isFinite(v.updated) ? v.updated : 0;
      out.duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      out.boundaries = Array.isArray(v.boundaries) ? v.boundaries.filter(function (b) { return b && Number.isFinite(b.at) && b.at >= 0 && typeof b.dropLeading === 'boolean'; }).map(function (b) { return { at: b.at, dropLeading: b.dropLeading }; }) : [];
      v.ranges.forEach(function (r) { if (Array.isArray(r) && r.length === 2 && r.every(function (n) { return Number.isFinite(n) && n >= 0; }) && r[1] > r[0]) out.ranges = addRange(out.ranges, r[0], r[1]); });
      out.sentences = mergeSentences([], v.sentences.filter(function (s) { return s && Number.isFinite(s.seconds) && s.seconds >= 0 && typeof s.en === 'string' && s.en.trim() && typeof s.ja === 'string'; }).map(function (s) { return { t: String(s.t), seconds: s.seconds, en: s.en, ja: s.ja, glosses: validateGlosses(s.en, s.glosses) }; }));
      return out;
    } catch (_) { return emptyCache(id); }
  }
  var PREFIX = 'dualsub.video.';
  var POSITION_PREFIX = 'dualsub.position.';
  function readPosition(storage, id, fallback) {
    try {
      var value = JSON.parse(storage.getItem(POSITION_PREFIX + id));
      return value && parseTime(value.position) !== null ? { position: parseTime(value.position), updated: Number(value.updated) || 0 } : { position: fallback || 0, updated: 0 };
    } catch (_) { return { position: fallback || 0, updated: 0 }; }
  }
  function readCache(storage, id) {
    var cache;
    try { cache = decodeCache(storage.getItem(PREFIX + id), id); } catch (_) { cache = emptyCache(id); }
    var position = readPosition(storage, id, cache.position);
    cache.position = position.position; cache.updated = Math.max(cache.updated, position.updated);
    return cache;
  }
  function recentVideos(storage) {
    try {
      var list = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key && key.startsWith(PREFIX)) {
          var id = key.slice(PREFIX.length);
          if (videoId(id)) list.push(readCache(storage, id));
        }
      }
      return list.sort(function (a, b) { return b.updated - a.updated; });
    } catch (_) { return []; }
  }
  function isQuotaError(error) { return error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014); }
  function writeValue(storage, key, serialized, id) {
    var victims = null;
    for (;;) {
      try { storage.setItem(key, serialized); return true; }
      catch (error) {
        if (!isQuotaError(error)) return false;
        if (victims === null) victims = recentVideos(storage).filter(function (v) { return v.id !== id; }).reverse();
        if (!victims.length) return false;
        var victim = victims.shift().id;
        try { storage.removeItem(PREFIX + victim); storage.removeItem(POSITION_PREFIX + victim); } catch (_) { return false; }
      }
    }
  }
  function subtitleDocument(cache) {
    var clean = decodeCache(JSON.stringify(cache), cache.id);
    return { version: 1, id: clean.id, title: clean.title, updated: clean.updated, duration: clean.duration, ranges: clean.ranges, sentences: clean.sentences, boundaries: clean.boundaries };
  }
  function writeCache(storage, cache) { return writeValue(storage, PREFIX + cache.id, JSON.stringify(subtitleDocument(cache)), cache.id); }
  function writePosition(storage, id, position, updated) { return writeValue(storage, POSITION_PREFIX + id, JSON.stringify({ position: position, updated: updated }), id); }
  function exportSubtitles(videos) { return JSON.stringify({ format: 'dualsub-subtitles', version: 1, videos: videos.map(subtitleDocument) }, null, 2); }
  function importSubtitles(raw) {
    var data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error('字幕 JSON が壊れています。'); }
    if (!data || data.format !== 'dualsub-subtitles' || data.version !== 1 || !Array.isArray(data.videos)) throw new Error('DualSub の字幕バックアップではありません。');
    var ids = new Set();
    return data.videos.map(function (v) {
      if (!v || typeof v.id !== 'string' || videoId(v.id) !== v.id || ids.has(v.id) || v.version !== 1 || !Array.isArray(v.ranges) || !Array.isArray(v.sentences)) throw new Error('字幕データの動画 ID または形式が不正です。');
      ids.add(v.id);
      if (v.ranges.some(function (r) { return !Array.isArray(r) || r.length !== 2 || !r.every(function (n) { return Number.isFinite(n) && n >= 0; }) || r[1] <= r[0]; }) || v.sentences.some(function (s) { return !s || !Number.isFinite(s.seconds) || s.seconds < 0 || typeof s.en !== 'string' || !s.en.trim() || typeof s.ja !== 'string'; })) throw new Error('字幕の時刻・英文・区間が不正です。');
      return decodeCache(JSON.stringify(subtitleDocument(v)), v.id);
    });
  }
  var api = { videoId: videoId, parseTime: parseTime, planChunk: planChunk, normalizeEnglish: normalizeEnglish, validateGlosses: validateGlosses, mergeSentences: mergeSentences, mergeImportedSentences: mergeImportedSentences, acceptSentences: acceptSentences, wordCount: wordCount, wordOverlap: wordOverlap, responseQuality: responseQuality, nextChunk: nextChunk, repeatTarget: repeatTarget, shouldReadPosition: shouldReadPosition, clampPosition: clampPosition, shouldPauseSentence: shouldPauseSentence, recoveryPlan: recoveryPlan, currentSentence: currentSentence, addRange: addRange, coverageEnd: coverageEnd, emptyCache: emptyCache, decodeCache: decodeCache, readCache: readCache, writeCache: writeCache, recentVideos: recentVideos, readPosition: readPosition, writePosition: writePosition, exportSubtitles: exportSubtitles, importSubtitles: importSubtitles };
  if (typeof module !== 'undefined') module.exports = api;
  root.DualSubCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
