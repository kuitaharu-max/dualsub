(function () {
  'use strict';
  var C = DualSubCore, G = DualSubGemini, L = DualSubListening;
  var $ = function (id) { return document.getElementById(id); };
  var storage;
  try { storage = window.localStorage; } catch (_) { storage = null; }
  function readSettings() {
    try { return JSON.parse(storage.getItem('dualsub.settings')) || {}; } catch (_) { return {}; }
  }
  var settings = readSettings();
  if (settings.model === 'gemini-flash-lite-latest' && settings.fallback === 'gemini-3.5-flash-lite' && !settings.version) { settings.model = G.DEFAULT_MODEL; settings.fallback = G.DEFAULT_FALLBACK; }
  $('api-key').value = typeof settings.key === 'string' ? settings.key : '';
  $('model').value = settings.model || G.DEFAULT_MODEL;
  $('fallback').value = settings.fallback || G.DEFAULT_FALLBACK;
  settings = { key: $('api-key').value, model: $('model').value, fallback: $('fallback').value };
  $('show-key').addEventListener('click', function () {
    var show = $('api-key').type === 'password';
    $('api-key').type = show ? 'text' : 'password';
    $('show-key').textContent = show ? '隠す' : '表示';
    $('show-key').setAttribute('aria-pressed', String(show));
  });
  $('settings-form').addEventListener('submit', function (event) {
    event.preventDefault();
    settings = { version: 2, key: $('api-key').value.trim(), model: $('model').value.trim(), fallback: $('fallback').value.trim() };
    try {
      storage.setItem('dualsub.settings', JSON.stringify(settings));
      $('settings-status').textContent = '保存しました。';
    } catch (_) { $('settings-status').textContent = '保存できませんでした。この画面を開いている間だけ使用します。'; }
    if (!busy) resumeTranslation(true);
  });
  $('export').addEventListener('click', function () {
    var videos = C.recentVideos(storage);
    if (cache) videos = videos.filter(function (v) { return v.id !== cache.id; }).concat([cache]);
    var blob = new Blob([C.exportSubtitles(videos)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'dualsub-subtitles.json'; document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    $('backup-status').textContent = '字幕を書き出しました。API キーは含まれません。';
  });
  $('import').addEventListener('change', async function () {
    var file = $('import').files[0]; if (!file) return;
    try {
      var videos = C.importSubtitles(await file.text()), failed = 0;
      videos.forEach(function (v) {
        var existing = cache && cache.id === v.id ? cache : C.readCache(storage, v.id);
        existing.sentences = C.mergeImportedSentences(existing.sentences, v.sentences, existing.ranges.concat(v.ranges).reduce(function (joins, r) { return joins.concat(r); }, []), existing.ranges);
        v.ranges.forEach(function (r) { existing.ranges = C.addRange(existing.ranges, r[0], r[1]); });
        existing.boundaries = existing.boundaries.filter(function (b) { return !v.boundaries.some(function (n) { return n.at === b.at; }); }).concat(v.boundaries);
        existing.title = v.title || existing.title; existing.updated = Date.now();
        existing.duration = v.duration || existing.duration;
        if (!C.writeCache(storage, existing)) failed++;
        if (cache && cache.id === v.id) { cache = existing; render(); }
      });
      renderRecents();
      $('backup-status').textContent = videos.length + '動画を読み込みました。' + (failed ? failed + '動画は永続保存できませんでした。' : '');
    } catch (error) { $('backup-status').textContent = '読み込めませんでした：' + error.message; }
    $('import').value = '';
  });
  function openVideo(id, position) {
    var url = new URL(location.href);
    url.search = ''; url.hash = '';
    url.searchParams.set('v', id);
    url.searchParams.set('t', String(Math.floor(position || 0)));
    location.assign(url.href);
  }
  $('open-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var id = C.videoId($('video-url').value);
    if (!id) { $('url-error').textContent = '対応する YouTube URL を入力してください。'; return; }
    openVideo(id, C.readCache(storage, id).position);
  });
  function renderRecents() {
    var recents = C.recentVideos(storage);
    $('recent').replaceChildren();
    if (!recents.length) $('recent').textContent = 'まだ動画を開いていません。';
    recents.forEach(function (item) {
    var li = document.createElement('li'), a = document.createElement('a'), small = document.createElement('small');
    var url = new URL(location.href); url.search = ''; url.hash = '';
    url.searchParams.set('v', item.id); url.searchParams.set('t', String(Math.floor(item.position)));
    a.href = url.href; a.textContent = item.title || item.id;
    small.textContent = '続き ' + formatTime(item.position) + ' · ' + item.sentences.length + '文を保存';
    li.append(a, small); $('recent').append(li);
    });
  }
  renderRecents();
  var params = new URLSearchParams(location.search), id = C.videoId(params.get('v') || '');
  var player = null, ready = false, busy = false, halted = false, embeddedError = false;
  var cache = id ? C.readCache(storage, id) : null;
  var position = id ? (C.parseTime(params.get('t')) ?? cache.position) : 0;
  var active = -1, lastScrolled = -1, manualUntil = 0, lastSaved = 0;
  var skipped = [], attempts = { network: 0, server: 0 }, retryAt = 0, recoveryError = null, foregroundRetried = false;
  var subtitleSaved = true, positionSaved = true;
  var wakeLock = null, wakePending = false, pausedSkipOrigin = null, pausedSkipBlocked = false;
  var listeningSettings = L.readSettings(storage), listeningState = L.initial(), listeningTimers = {}, pagePauseExpected = false, playbackRate = 1;
  $('listen').checked = listeningSettings.enabled; $('listen-count').value = String(listeningSettings.repeats); $('listen-gap').value = String(listeningSettings.gap);
  var daily = { date: '', count: 0 };
  try { daily = JSON.parse(storage.getItem('dualsub.requests')) || daily; } catch (_) { daily = { date: '', count: 0 }; }
  updateCount(false);
  if (!id) {
    if (params.has('v')) $('url-error').textContent = '動画 ID が正しくありません。URL を貼り直してください。';
    return;
  }
  $('home').hidden = true; $('watch').hidden = false;
  $('youtube-link').href = 'https://www.youtube.com/watch?v=' + id;
  $('video-title').textContent = cache.title || '英語ポッドキャスト';
  $('hide-ja').addEventListener('change', function () { $('sentences').classList.toggle('hide-ja', $('hide-ja').checked); });
  $('speed').addEventListener('change', function () { if (ready) { playbackRate = Number($('speed').value); player.setPlaybackRate(playbackRate); listeningEvent({ type: 'tick' }); } });
  ['listen', 'listen-count', 'listen-gap'].forEach(function (id) { $(id).addEventListener('change', function () {
    listeningSettings = L.settings({ enabled: $('listen').checked, repeats: $('listen-count').value, gap: $('listen-gap').value });
    if (!L.writeSettings(storage, listeningSettings)) $('listening-progress').title = '設定を保存できません。この画面の間だけ使用します。';
    listeningEvent({ type: 'reset' });
  }); });
  $('listening-continue').addEventListener('click', function () { listeningEvent({ type: 'continue' }); });
  $('repeat').disabled = true;
  $('repeat').addEventListener('click', function () { var t = C.repeatTarget(cache.sentences, active, position); if (t !== null) seek(t); });
  $('resume').addEventListener('click', function () { resumeTranslation(true); });
  ['touchstart', 'touchmove', 'wheel', 'pointerdown'].forEach(function (type) {
    window.addEventListener(type, function () { manualUntil = Date.now() + 5000; }, { passive: true });
  });
  window.addEventListener('keydown', function (event) {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) manualUntil = Date.now() + 5000;
  });
  function formatTime(t) {
    t = Math.max(0, Math.floor(t));
    return Math.floor(t / 3600) + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  function status(message, error) { $('status').textContent = message; $('status').classList.toggle('error', !!error); }
  function savePosition() {
    if (!cache) return;
    cache.position = position;
    positionSaved = C.writePosition(storage, id, position, Date.now());
    $('storage-warning').hidden = subtitleSaved && positionSaved;
    var url = new URL(location.href);
    url.searchParams.set('v', id); url.searchParams.set('t', String(Math.floor(position)));
    history.replaceState(null, '', url.href);
    lastSaved = Date.now();
  }
  function saveSubtitles() { cache.updated = Date.now(); subtitleSaved = C.writeCache(storage, cache); $('storage-warning').hidden = subtitleSaved && positionSaved; }
  function knownDuration() {
    var measured = player.getDuration();
    if (Number.isFinite(measured) && measured > 0 && measured !== cache.duration) { cache.duration = measured; saveSubtitles(); }
    return cache.duration;
  }
  function resetPausedSkip() { pausedSkipOrigin = null; pausedSkipBlocked = false; }
  function readPlaybackPosition(state) {
    if (!C.shouldReadPosition(state)) return;
    var next = player.getCurrentTime();
    if (Math.abs(next - position) > 1.5 || (state !== 1 && Math.abs(next - position) > 0.05)) resetPausedSkip();
    position = next;
  }
  function listeningContext() { return { now: Date.now(), position: position, playerState: player.getPlayerState(), rate: playbackRate, duration: cache.duration, sentences: cache.sentences, ranges: cache.ranges }; }
  function clearListeningTimers() { Object.keys(listeningTimers).forEach(function (key) { clearTimeout(listeningTimers[key]); }); listeningTimers = {}; }
  function scheduleListening() {
    clearListeningTimers();
    var context = listeningContext(), timers = L.timers(listeningState, context);
    Object.keys(timers).forEach(function (key) { listeningTimers[key] = setTimeout(function () {
      if (!ready || embeddedError) return;
      readPlaybackPosition(player.getPlayerState());
      listeningEvent({ type: 'tick' }); highlight();
    }, Math.min(2147483647, timers[key])); });
    $('listening-status').hidden = !listeningSettings.enabled;
    $('listening-progress').textContent = L.label(listeningState, listeningSettings, Date.now());
    $('listening-continue').hidden = listeningState.phase !== 'blocked';
  }
  function listeningEvent(event) {
    if (!ready || embeddedError) return;
    if (listeningSettings.enabled && event.type !== 'seek') readPlaybackPosition(player.getPlayerState());
    var result = L.step(listeningState, event, listeningContext(), listeningSettings);
    listeningState = result.state;
    clearListeningTimers();
    result.commands.forEach(function (command) {
      if (command.type === 'pause') { pagePauseExpected = true; player.pauseVideo(); }
      else if (command.type === 'play') {
        position = command.target; resetPausedSkip(); player.seekTo(position, true); player.playVideo(); savePosition(); highlight();
      }
    });
    scheduleListening();
  }
  function updateCount(increment) {
    var now = new Date(), date = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    if (daily.date !== date) daily = { date: date, count: 0 };
    if (!Number.isFinite(daily.count) || daily.count < 0) daily.count = 0;
    if (increment) {
      daily.count++;
      try { storage.setItem('dualsub.requests', JSON.stringify(daily)); } catch (_) { $('today-count').title = '保存不可：この画面で数えた送信回数'; }
    }
    $('today-count').textContent = '今日の送信：' + daily.count + '回';
  }
  function resumeTranslation(reset) {
    if (reset) { attempts = { network: 0, server: 0 }; foregroundRetried = false; }
    retryAt = 0; recoveryError = null; halted = false; $('resume').hidden = true;
    translateAhead();
  }
  async function syncWakeLock() {
    if (!navigator.wakeLock) return;
    var playing = ready && !embeddedError && player.getPlayerState() === 1 && !document.hidden;
    if (!playing) {
      if (wakeLock) { var old = wakeLock; wakeLock = null; try { await old.release(); } catch (_) { $('watch').dataset.wakeLock = 'release-failed'; } }
      return;
    }
    if (wakeLock || wakePending) return;
    wakePending = true;
    try {
      var lock = await navigator.wakeLock.request('screen');
      if (document.hidden || embeddedError || player.getPlayerState() !== 1) await lock.release();
      else { wakeLock = lock; lock.addEventListener('release', function () { if (wakeLock === lock) wakeLock = null; }); }
    } catch (_) { $('watch').dataset.wakeLock = 'unavailable'; }
    finally { wakePending = false; }
  }
  function seek(t) {
    if (!ready || embeddedError) return;
    position = C.clampPosition(t, knownDuration());
    resetPausedSkip();
    if (listeningSettings.enabled) listeningEvent({ type: 'seek', target: position });
    else { player.seekTo(position, true); player.playVideo(); }
    lastScrolled = -1;
    savePosition();
    highlight();
    translateAhead();
  }
  function appendEnglish(target, sentence) {
    var text = sentence.en;
    var ranges = sentence.glosses.map(function (g) { return { start: text.toLowerCase().indexOf(g.word.toLowerCase()), word: g.word, ja: g.ja }; }).sort(function (a, b) { return a.start - b.start; });
    var cursor = 0;
    ranges.forEach(function (g) {
      if (g.start < cursor) return;
      target.append(document.createTextNode(text.slice(cursor, g.start)));
      var ruby = document.createElement('ruby'), rt = document.createElement('rt');
      ruby.append(document.createTextNode(text.slice(g.start, g.start + g.word.length)));
      rt.textContent = g.ja; ruby.append(rt); target.append(ruby);
      cursor = g.start + g.word.length;
    });
    target.append(document.createTextNode(text.slice(cursor)));
  }
  function render() {
    var fragment = document.createDocumentFragment();
    cache.sentences.forEach(function (sentence) {
      var li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'sentence';
      var time = document.createElement('span'), en = document.createElement('span'), ja = document.createElement('span');
      time.className = 'time'; time.textContent = formatTime(sentence.seconds);
      en.className = 'en'; appendEnglish(en, sentence);
      ja.className = 'ja'; ja.textContent = sentence.ja;
      button.append(time, en, ja); button.addEventListener('click', function () { seek(sentence.seconds); });
      li.append(button); fragment.append(li);
    });
    $('sentences').replaceChildren(fragment);
    active = -1; lastScrolled = -1; highlight();
    if (ready) listeningEvent({ type: 'tick' });
  }
  function highlight() {
    var index = C.currentSentence(cache.sentences, position);
    // Do not highlight a cached sentence belonging to a different translated island.
    var range = cache.ranges.find(function (r) { return position >= r[0] && position < r[1]; });
    if (!range || (index >= 0 && cache.sentences[index].seconds < range[0] - 5)) index = -1;
    var buttons = $('sentences').children;
    if (index !== active) {
      if (active >= 0 && buttons[active]) { buttons[active].firstChild.classList.remove('active'); buttons[active].firstChild.removeAttribute('aria-current'); }
      active = index;
      if (active >= 0) { buttons[active].firstChild.classList.add('active'); buttons[active].firstChild.setAttribute('aria-current', 'true'); }
    }
    $('repeat').disabled = active < 0 || !ready;
    if (active >= 0 && active !== lastScrolled && Date.now() >= manualUntil) {
      var rect = buttons[active].getBoundingClientRect();
      var top = $('sticky-player').getBoundingClientRect().bottom + 16;
      if (rect.top < top || rect.bottom > window.innerHeight - 30) window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - top), behavior: 'auto' });
      lastScrolled = active;
    }
  }
  async function translateAhead() {
    if (!ready || busy || halted || embeddedError) return;
    var duration = knownDuration(), state = player.getPlayerState();
    if (state === 1) resetPausedSkip();
    if (!duration && state === 1) { status('動画の長さを確認中です。長さが取得できないライブ配信には対応していません。'); return; }
    if (state !== 1 && pausedSkipBlocked) { status('停止中の区間スキップを止めました。シークまたは再生すると続けます。'); return; }
    var planningState = listeningSettings.enabled && listeningState.phase === 'awaiting' ? 1 : state;
    var chunk = C.nextChunk(cache.ranges, skipped, position, duration, planningState, pausedSkipBlocked);
    if (!chunk) { status('現在位置は翻訳済み、またはこの画面でスキップ済みです。'); return; }
    if (chunk.skip) { applyOutput({ segments: [], skipped: [[chunk.a, chunk.b]] }, duration, chunk); status('15秒未満の隙間は、この画面の間だけスキップします。'); return; }
    if (!settings.key) { status('設定に Gemini API キーを入力してください。保存済みの字幕は表示できます。'); return; }
    busy = true;
    try {
      var output = await G.processChunk({ id: id, key: settings.key, model: settings.model, fallback: settings.fallback, chunk: chunk, onRequest: function () { updateCount(true); }, onStatus: function (message) { if (!embeddedError) status(message + ' · ' + formatTime(chunk.a) + '〜' + formatTime(chunk.b)); } });
      applyOutput(output, duration, chunk);
      attempts = { network: 0, server: 0 }; foregroundRetried = false; recoveryError = null;
      if (!embeddedError) status(output.segments.length ? '字幕を保存しました。' : 'この区間は保存せず、この画面の間だけスキップします。');
    } catch (error) {
      if (error.partial) applyOutput(error.partial, duration, chunk);
      halted = true; recoveryError = error; $('resume').hidden = embeddedError;
      var plan = C.recoveryPlan(error, attempts);
      if (plan.delay !== null && !embeddedError) { if (plan.counter) attempts[plan.counter]++; retryAt = Date.now() + plan.delay * 1000; showCountdown(); }
      else if (!embeddedError) status(error.message, true);
    } finally { busy = false; }
  }
  function applyOutput(output, duration, requestedChunk) {
    output.segments.forEach(function (segment) {
      var result = segment.result, chunk = segment.chunk;
      cache.sentences = C.mergeSentences(cache.sentences, result.accepted, [chunk.a, chunk.b]);
      var next = Math.min(duration > 0 ? duration : chunk.requestEnd, chunk.requestEnd, result.next);
      cache.ranges = C.addRange(cache.ranges, chunk.a, next);
    });
    if (output.skipped.length && player.getPlayerState() !== 1) {
      if (pausedSkipOrigin === null) pausedSkipOrigin = requestedChunk.a;
      else if (requestedChunk.a > pausedSkipOrigin) pausedSkipBlocked = true;
    }
    output.skipped.forEach(function (r) { skipped = C.addRange(skipped, r[0], r[1]); });
    if (output.segments.length) saveSubtitles();
    if (skipped.length) { $('skipped').hidden = false; $('skipped').textContent = '作れなかった区間（この画面の間だけスキップ）：' + skipped.map(function (r) { return formatTime(r[0]) + '〜' + formatTime(r[1]); }).join('、'); }
    render(); savePosition();
  }
  function showCountdown() {
    status(recoveryError.message + ' ' + Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) + '秒後に自動再開' + (recoveryError.status === 503 || recoveryError.status === 500 ? '（' + attempts.server + '/3）' : ''), true);
  }
  render(); saveSubtitles(); savePosition();
  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('player', {
      videoId: id,
      playerVars: { playsinline: 1, start: Math.floor(position), origin: location.origin },
      events: {
        onReady: function () {
          ready = true;
          var data = player.getVideoData();
          if (data && data.title) { cache.title = data.title; $('video-title').textContent = data.title; }
          var duration = knownDuration();
          if (duration > 0) position = Math.min(position, Math.max(0, duration - 1));
          saveSubtitles(); savePosition(); highlight(); listeningEvent({ type: 'tick' }); translateAhead(); syncWakeLock();
        },
        onStateChange: function (event) {
          if (event.data === 1) resetPausedSkip();
          if (ready && !embeddedError && C.shouldReadPosition(event.data)) { readPlaybackPosition(event.data); highlight(); }
          var source = event.data === 2 && pagePauseExpected ? 'page' : 'user';
          if (event.data === 2) pagePauseExpected = false;
          listeningEvent({ type: 'state', value: event.data, source: source });
          syncWakeLock();
        },
        onPlaybackRateChange: function (event) { $('speed').value = String(event.data); playbackRate = event.data; listeningEvent({ type: 'tick' }); },
        onError: function (event) {
          embeddedError = true; halted = true; $('resume').hidden = true;
          clearListeningTimers(); $('listening-continue').hidden = true;
          retryAt = 0; syncWakeLock();
          var message = [101, 150].includes(event.data) ? 'この動画は埋め込み再生が禁止されています。' : 'YouTube の埋め込みを再生できません（エラー ' + event.data + '）。';
          status(message + '「YouTube で開く」リンクを使用してください。', true);
        }
      }
    });
  };
  var script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = function () { status('YouTube プレーヤーを読み込めません。ネットワークを確認してください。', true); };
  document.head.append(script);
  setInterval(function () {
    if (!ready || embeddedError) return;
    updateCount(false);
    // Before playback starts, Safari can report 0 despite a queued initial seek.
    var state = player.getPlayerState();
    readPlaybackPosition(state);
    highlight(); listeningEvent({ type: 'tick' });
    if (Date.now() - lastSaved >= 10000) savePosition();
    if (retryAt) { if (Date.now() >= retryAt && !busy) resumeTranslation(false); else showCountdown(); }
    translateAhead();
  }, 500);
  window.addEventListener('pagehide', function () { clearListeningTimers(); listeningState.phase = 'paused'; savePosition(); if (wakeLock) wakeLock.release().catch(function () { $('watch').dataset.wakeLock = 'release-failed'; }); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) savePosition();
    else if (!busy && !retryAt && recoveryError && (recoveryError.kind === 'network' || recoveryError.kind === 'empty') && !foregroundRetried) { foregroundRetried = true; resumeTranslation(false); }
    if (!document.hidden && ready) listeningEvent({ type: 'state', value: player.getPlayerState(), source: 'user' });
    syncWakeLock();
  });
})();
