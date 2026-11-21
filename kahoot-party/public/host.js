(() => {
  const $ = id => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  let currentState = null;
  let timerFrame = null;
  let questionsLoaded = false;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function setLoggedIn(value) {
    $('loginPanel').classList.toggle('hidden', value);
    $('hostApp').classList.toggle('hidden', !value);
    $('hostUser').classList.toggle('hidden', !value);
    if (value) {
      // 登入 cookie 已更新，重新連線讓 Socket.IO 握手重新驗證主持人身分。
      if (socket.connected) socket.disconnect();
      socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }
  }

  async function checkLogin() {
    try {
      const result = await api('/api/host/me');
      if (result.authenticated) {
        setLoggedIn(true);
        await loadQuestions();
      }
    } catch { /* 顯示登入表單即可 */ }
  }

  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('loginError').textContent = '';
    try {
      await api('/api/host/login', { method: 'POST', body: JSON.stringify({ password: $('hostPassword').value }) });
      $('hostPassword').value = '';
      setLoggedIn(true);
      await loadQuestions();
    } catch (error) { $('loginError').textContent = error.message; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/host/logout', { method: 'POST', body: '{}' }); } catch {}
    setLoggedIn(false);
  });

  async function loadQuestions() {
    const data = await api('/api/host/questions');
    renderEditor(data.questions);
    questionsLoaded = true;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function renderEditor(questions) {
    $('questionEditor').innerHTML = questions.map((q, index) => `
      <article class="edit-card ${index === 0 ? 'warmup' : ''}" data-question="${index}">
        <div class="edit-card-head"><strong>${index === 0 ? '暖身題' : `正式題 ${index}`} · 第 ${index + 1} 題</strong><span>10 秒作答</span></div>
        <label>題目</label><textarea class="q-text" maxlength="180">${escapeHtml(q.question)}</textarea>
        <label>四個選項（請全部填寫）</label>
        <div class="edit-options">
          ${q.options.map((option, optIndex) => `<div class="edit-option"><input type="radio" name="correct-${index}" value="${optIndex}" ${q.correctIndex === optIndex ? 'checked' : ''} aria-label="選項 ${optIndex + 1} 為正確答案"><input type="text" class="q-option" data-option="${optIndex}" maxlength="70" value="${escapeHtml(option)}" placeholder="選項 ${optIndex + 1}"></div>`).join('')}
        </div>
        <div class="correct-select-hint">點選左側圓鈕，指定正確答案。</div>
        <label>答案說明（選填，公布答案時顯示）</label><input type="text" class="q-explanation" maxlength="240" value="${escapeHtml(q.explanation || '')}" placeholder="例如：簡短說明正確答案的原因">
      </article>`).join('');
  }

  $('saveQuestionsBtn').addEventListener('click', async () => {
    const cards = [...document.querySelectorAll('.edit-card')];
    const questions = cards.map(card => ({
      question: card.querySelector('.q-text').value,
      options: [...card.querySelectorAll('.q-option')].map(input => input.value),
      correctIndex: Number(card.querySelector('input[type=radio]:checked')?.value ?? -1),
      explanation: card.querySelector('.q-explanation').value
    }));
    $('saveMessage').textContent = '儲存中…';
    $('saveMessage').style.color = '#c6b6ef';
    try {
      const result = await api('/api/host/questions', { method: 'PUT', body: JSON.stringify({ questions }) });
      $('saveMessage').textContent = result.message;
      $('saveMessage').style.color = '#83e8bd';
    } catch (error) {
      $('saveMessage').textContent = error.message;
      $('saveMessage').style.color = '#ff8eae';
    }
  });

  $('createRoomBtn').addEventListener('click', createRoom);
  $('startQuestionBtn').addEventListener('click', async () => {
    if (currentState?.phase === 'finished') return createRoom();
    try {
      await api('/api/host/start-question', { method: 'POST', body: '{}' });
    } catch (error) { $('hostNotice').textContent = error.message; }
  });

  async function createRoom() {
    try {
      const result = await api('/api/host/create-game', { method: 'POST', body: '{}' });
      $('hostNotice').textContent = '房間已建立，請讓賓客掃描 QR Code 或輸入 PIN。';
      await loadQr(result.pin);
    } catch (error) { $('hostNotice').textContent = error.message; }
  }

  async function loadQr(pin) {
    try {
      const data = await api(`/api/host/qr?pin=${encodeURIComponent(pin)}`);
      $('qrImage').src = data.dataUrl;
      $('joinLink').textContent = data.joinUrl;
    } catch (error) { $('hostNotice').textContent = error.message; }
  }

  $('copyLinkBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('joinLink').textContent);
      $('copyLinkBtn').textContent = '已複製 ✓';
      setTimeout(() => $('copyLinkBtn').textContent = '複製連結', 1400);
    } catch { $('hostNotice').textContent = '瀏覽器不允許複製，請手動複製加入連結。'; }
  });

  socket.on('connect', () => {
    if (!$('hostApp').classList.contains('hidden')) socket.emit('host:watch');
  });

  socket.on('game:state', state => {
    if ($('hostApp').classList.contains('hidden')) return;
    currentState = state;
    renderState(state);
  });

  socket.on('game:error', message => { $('hostNotice').textContent = message; });

  function renderState(state) {
    $('playerCount').textContent = state.playerCount || 0;
    $('saveQuestionsBtn').disabled = state.phase !== 'no-game' && state.phase !== 'finished';
    $('saveQuestionsBtn').title = $('saveQuestionsBtn').disabled ? '遊戲進行中不可修改題目' : '';

    const exists = state.phase !== 'no-game';
    $('noRoom').classList.toggle('hidden', exists);
    $('roomActive').classList.toggle('hidden', !exists);
    if (!exists) {
      $('phaseTag').textContent = '尚未建立';
      $('livePanel').classList.add('hidden');
      return;
    }
    $('roomPin').textContent = state.pin;
    if (!$('qrImage').src || !$('joinLink').textContent.includes(state.pin)) loadQr(state.pin);

    const phaseLabels = { lobby: '等待加入', question: '答題進行中', leaderboard: '本題結算', ready: '等待下一題', finished: '遊戲結束' };
    $('phaseTag').textContent = phaseLabels[state.phase] || state.phase;
    const startBtn = $('startQuestionBtn');
    startBtn.disabled = state.phase === 'question' || state.phase === 'leaderboard';
    if (state.phase === 'lobby') startBtn.textContent = '開始暖身題 →';
    else if (state.phase === 'ready') startBtn.textContent = `開始第 ${state.questionIndex + 2} 題 →`;
    else if (state.phase === 'finished') { startBtn.disabled = false; startBtn.textContent = '建立下一場新遊戲 ↻'; }
    else if (state.phase === 'question') startBtn.textContent = '答題中…';
    else if (state.phase === 'leaderboard') startBtn.textContent = '排行榜展示中…';

    const notices = {
      lobby: '等待賓客加入。確認大家都進房後，按「開始暖身題」。',
      question: '計時由伺服器控制，時間到自動結算。',
      leaderboard: '正在展示本題結算與更新後的前 10 名。',
      ready: '本題已結算，按下按鈕即可開始下一題。',
      finished: '8 題正式題已完成，最終排行榜已公布。'
    };
    $('hostNotice').textContent = notices[state.phase] || '';
    $('livePanel').classList.toggle('hidden', state.phase === 'lobby');
    if (state.phase !== 'lobby') renderLive(state);
  }

  function renderLive(state) {
    const final = state.phase === 'finished';
    const q = state.question;
    const index = state.questionIndex;
    $('liveTitle').textContent = final ? '最終結果' : state.phase === 'ready' ? '本題結算完成' : index === 0 ? '暖身題' : `正式題 ${index} / 7`;
    $('answerCount').textContent = `${state.answeredCount || 0} / ${state.playerCount || 0} 已作答`;
    $('liveQuestion').textContent = q?.question || '等待下一題…';
    $('hostTimerWrap').classList.toggle('hidden', state.phase !== 'question');
    if (state.phase === 'question') startHostTimer(state.endsAt);
    else if (timerFrame) cancelAnimationFrame(timerFrame);

    $('hostOptions').innerHTML = '';
    if (q?.options) q.options.forEach((option, i) => {
      const div = document.createElement('div');
      div.className = `host-option ${(state.phase === 'leaderboard' || final) && q.correctIndex === i ? 'correct' : ''}`;
      const key = document.createElement('span');
      key.className = 'opt-id';
      key.textContent = ['A', 'B', 'C', 'D'][i];
      const label = document.createElement('span');
      label.textContent = option;
      div.append(key, label);
      $('hostOptions').appendChild(div);
    });
    const showCorrect = state.phase === 'leaderboard' || final;
    $('hostCorrect').classList.toggle('hidden', !showCorrect);
    if (showCorrect && q) {
      $('hostCorrect').textContent = `正確答案：${['A', 'B', 'C', 'D'][q.correctIndex]}｜${q.options[q.correctIndex]}${q.explanation ? `。${q.explanation}` : ''}`;
    }
    renderRows(state.leaderboard || []);
  }

  function startHostTimer(endsAt) {
    if (timerFrame) cancelAnimationFrame(timerFrame);
    const tick = () => {
      if (currentState?.phase !== 'question') return;
      const remaining = Math.max(0, endsAt - Date.now());
      $('hostTimer').textContent = Math.ceil(remaining / 1000);
      $('hostTimerBar').style.width = `${remaining / 10_000 * 100}%`;
      timerFrame = remaining > 0 ? requestAnimationFrame(tick) : null;
    };
    tick();
  }

  function renderRows(rows) {
    const container = $('hostLeaderboard');
    container.innerHTML = '';
    if (!rows.length) {
      container.innerHTML = '<div class="rank-row"><span class="rank-number">—</span><span class="rank-name">等待參賽者得分</span><span class="rank-score">0 分</span></div>';
      return;
    }
    rows.forEach((row, index) => {
      const item = document.createElement('div');
      item.className = 'rank-row';
      item.style.setProperty('--i', index);
      const rank = document.createElement('span');
      rank.className = 'rank-number';
      rank.textContent = index === 0 ? '👑' : index === 1 ? '🥈' : index === 2 ? '🥉' : row.rank;
      const name = document.createElement('span');
      name.className = 'rank-name';
      name.textContent = row.name;
      const score = document.createElement('span');
      score.className = 'rank-score';
      score.textContent = `${row.score.toLocaleString()} 分`;
      item.append(rank, name, score);
      container.appendChild(item);
    });
  }

  checkLogin();
})();
