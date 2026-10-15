(function (root) {
  'use strict';
  var C = root.DualSubCore;
  if (typeof module !== 'undefined') C = require('./core.js');
  var GAPS = [0, 0.5, 1, 1.5, 2, 3, 5, 10], KEY = 'dualsub.listening';
  function settings(value) {
    value = value || {};
    return { enabled: value.enabled === true, repeats: Number.isInteger(Number(value.repeats)) && Number(value.repeats) >= 1 && Number(value.repeats) <= 5 ? Number(value.repeats) : 3, gap: GAPS.includes(Number(value.gap)) && value.gap !== null && value.gap !== undefined ? Number(value.gap) : 1.5 };
  }
  function readSettings(storage) { try { return settings(JSON.parse(storage.getItem(KEY))); } catch (_) { return settings(); } }
  function writeSettings(storage, value) { try { storage.setItem(KEY, JSON.stringify(settings(value))); return true; } catch (_) { return false; } }
  function initial() { return { phase: 'idle', sentence: null, completed: 0, passComplete: false, waitUntil: 0, launchUntil: 0, target: null, sample: null }; }
  function sentenceWindow(sentences, ranges, duration, start) {
    var index = C.currentSentence(sentences, start);
    if (index < 0 || sentences[index].seconds !== start) return null;
    var next = sentences[index + 1], range = ranges.find(function (r) { return start >= r[0] - 5 && start < r[1]; });
    var end = Math.min(duration > 0 ? duration : Infinity, range ? range[1] : Infinity, next ? next.seconds - 0.2 : Infinity);
    return Number.isFinite(end) ? { start: start, end: Math.max(start, end), next: next ? next.seconds : null, final: !next && duration > 0 && end >= duration - 0.01 } : null;
  }
  function remainingMs(position, end, rate) { return Math.max(0, (end - position) / (Number.isFinite(rate) && rate > 0 ? rate : 1) * 1000); }
  function unexpectedSeek(sample, context) {
    if (!sample) return false;
    var expected = sample.position + (sample.playing ? Math.max(0, context.now - sample.now) / 1000 * sample.rate : 0);
    return Math.abs(context.position - expected) >= 2;
  }
  function sample(context) { return { position: context.position, now: context.now, rate: context.rate || 1, playing: context.playerState === 1 }; }
  function anchor(context, position) {
    var index = C.currentSentence(context.sentences, position);
    var range = context.ranges.find(function (r) { return position >= r[0] && position < r[1]; });
    return index >= 0 && range && context.sentences[index].seconds >= range[0] - 5 ? context.sentences[index].seconds : null;
  }
  function reset(context) { return Object.assign(initial(), { phase: context.playerState === 1 ? 'playing' : 'paused', sentence: anchor(context, context.position), sample: sample(context) }); }
  function step(previous, event, context, options) {
    var config = settings(options), state = Object.assign({}, previous), commands = [];
    function output() { state.sample = sample(context); return { state: state, commands: commands }; }
    function launch(target, next) {
      if (next) { state.sentence = target; state.completed = 0; }
      state.phase = 'starting'; state.target = target; state.launchUntil = context.now + 3500;
      state.waitUntil = 0; state.passComplete = false;
      commands.push({ type: 'play', target: target });
    }
    if (!config.enabled) return { state: initial(), commands: [] };
    if (event.type === 'reset') { state = reset(context); return output(); }
    if (event.type === 'seek') {
      state = reset(context); state.sentence = anchor(context, event.target + 0.5);
      launch(event.target, false); return output();
    }
    if (event.type === 'continue' && state.phase === 'blocked') { launch(state.target, false); return output(); }
    if (event.type === 'state' && event.value === 2) {
      if (event.source !== 'page') { if (unexpectedSeek(state.sample, context)) state = reset(context); state.phase = 'paused'; state.waitUntil = 0; state.launchUntil = 0; }
      return output();
    }
    if (state.phase !== 'starting' && unexpectedSeek(state.sample, context)) state = reset(context);
    if (state.phase === 'idle') state = reset(context);
    if (state.phase === 'starting') {
      var began = context.playerState === 1 && (event.type === 'state' && event.value === 1 || context.position >= state.target - 0.05 && context.position > state.target + 0.03 && context.position <= state.target + (context.now - (state.launchUntil - 3500)) / 1000 * (context.rate || 1) + 1.5);
      if (began) { state.phase = 'playing'; state.launchUntil = 0; }
      else if (context.now >= state.launchUntil) { state.phase = 'blocked'; return output(); }
      else return output();
    }
    if (event.type === 'state' && event.value === 1 && ['paused', 'blocked', 'done'].includes(state.phase)) { state.phase = 'playing'; state.waitUntil = 0; }
    if (state.phase === 'paused' || state.phase === 'blocked' || state.phase === 'done') return output();
    var window = state.sentence === null ? null : sentenceWindow(context.sentences, context.ranges, context.duration, state.sentence);
    if (!window && state.sentence !== null) {
      // Joining a newer transcript can replace a fragment with an earlier full sentence.
      var prior = C.currentSentence(context.sentences, state.sentence);
      if (prior >= 0 && state.sentence - context.sentences[prior].seconds <= 8) {
        state.sentence = context.sentences[prior].seconds;
        window = sentenceWindow(context.sentences, context.ranges, context.duration, state.sentence);
      } else if (state.phase === 'playing') { state.sentence = null; state.completed = 0; state.passComplete = false; }
    }
    if (state.phase === 'waiting' || state.phase === 'awaiting') {
      var userPlay = event.type === 'state' && event.value === 1;
      if (state.phase === 'waiting' && context.now < state.waitUntil && !userPlay) return output();
      if (state.completed < config.repeats && window) launch(window.start, false);
      else if (window && window.next !== null) launch(window.next, true);
      else state.phase = window && window.final ? 'done' : 'awaiting';
      return output();
    }
    if (state.sentence === null) { state.sentence = anchor(context, context.position); window = state.sentence === null ? null : sentenceWindow(context.sentences, context.ranges, context.duration, state.sentence); }
    if (window && (context.playerState === 1 || context.playerState === 0) && context.position >= window.end - 0.005) {
      if (!state.passComplete) state.completed++;
      state.passComplete = true; state.phase = 'waiting'; state.waitUntil = context.now + config.gap * 1000;
      if (context.playerState === 1) commands.push({ type: 'pause' });
    }
    return output();
  }
  function timers(state, context) {
    if (state.phase === 'waiting') return { wait: Math.max(0, state.waitUntil - context.now) };
    if (state.phase === 'starting') return { launch: Math.max(0, state.launchUntil - context.now) };
    if (state.phase === 'playing' && context.playerState === 1 && state.sentence !== null) {
      var window = sentenceWindow(context.sentences, context.ranges, context.duration, state.sentence);
      if (window) return { end: remainingMs(context.position, window.end, context.rate) };
    }
    return {};
  }
  function label(state, options, now) {
    var config = settings(options);
    if (!config.enabled) return '';
    var count = Math.min(config.repeats, state.completed + (state.passComplete ? 0 : 1));
    var text = '精聴 ' + Math.max(1, count) + '/' + config.repeats + ' 回目';
    if (state.phase === 'waiting') text += ' · ' + (state.completed >= config.repeats ? '次まで ' : '再聴まで ') + (Math.ceil(Math.max(0, state.waitUntil - now) / 100) / 10) + '秒';
    if (state.phase === 'paused') text += ' · 一時停止';
    if (state.phase === 'awaiting' || state.sentence === null) text += ' · 次の字幕を待っています';
    if (state.phase === 'done') text += ' · 最後の文を聞き終えました';
    if (state.phase === 'blocked') text += ' · 「タップで続ける」または動画をタップしてください';
    return text;
  }
  var api = { settings: settings, readSettings: readSettings, writeSettings: writeSettings, initial: initial, sentenceWindow: sentenceWindow, remainingMs: remainingMs, unexpectedSeek: unexpectedSeek, step: step, timers: timers, label: label };
  if (typeof module !== 'undefined') module.exports = api;
  root.DualSubListening = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
