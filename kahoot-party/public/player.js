(() => {
  const $ = id => document.getElementById(id);
  const joinScreen = $('joinScreen');
  const gameScreen = $('gameScreen');
  const views = ['waitingView', 'questionView', 'leaderboardView', 'finishedView'];
  const socket = io({ transports: ['websocket', 'polling'] });
  const params = new URLSearchParams(location.search);
  const pinInput = $('pinInput');
  const nameInput = $('nameInput');
  const joinError = $('joinError');
  let playerId = localStorage.getItem('kahoot-player-id');
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('kahoot-player-id', playerId);
  }
  nameInput.value = localStorage.getItem('kahoot-player-name') || '';
  if (/^\d{6}$/.test(params.get('pin') || '')) pinInput.value = params.get('pin');

  let activePin = '';
  let activeName = '';
  let currentState = null;
  let lastQuestionIndex = -99;
  let selectedChoice = null;
  let timerFrame = null;
  let joined = false;

  function showOnly(id) {
    views.forEach(view => $(view).classList.toggle('hidden', view !== id));
  }

  function enterGame(pin, name) {
    activePin = pin;
    activeName = name;
    joined = true;
    joinScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    $('playerNameTag').textContent = `玩家：${name}`;
    $('waitingPin').textContent = pin;
    showOnly('waitingView');
    socket.emit('player:join', { pin, name, playerId });
  }

  $('joinForm').addEventListener('submit', event => {
    event.preventDefault();
    const pin = pinInput.value.trim();
    const name = nameInput.value.trim();
    joinError.textContent = '';
    if (!/^\d{6}$/.test(pin)) { joinError.textContent = '請輸入 6 位數字的遊戲 PIN。'; return; }
    if (!name) { joinError.textContent = '請輸入暱稱。'; return; }
    localStorage.setItem('kahoot-player-name', name);
    enterGame(pin, name);
  });

  socket.on('connect', () => {
    if (joined) socket.emit('player:join', { pin: activePin, name: activeName, playerId });
  });

  socket.on('player:error', message => {
    if (!joined || !gameScreen.classList.contains('hidden')) {
      joined = false;
      gameScreen.classList.add('hidden');
      joinScreen.classList.remove('hidden');
      joinError.textContent = message;
    }
  });

  socket.on('player:joined', ({ name }) => {
    activeName = name;
    $('playerNameTag').textContent = `玩家：${name}`;
  });

  socket.on('player:private', data => {
    $('playerScoreTag').textContent = `${data.score.toLocaleString()} 分`;
    if (data.answerIndex !== null && data.answerIndex !== undefined) selectedChoice = data.answerIndex;
    if (currentState?.phase === 'question') markSelected();
  });

  socket.on('player:answer-accepted', ({ choice }) => {
    selectedChoice = choice;
    markSelected();
    $('answerStatus').textContent = '答案已送出！等待本題結算…';
  });

  socket.on('game:error', message => { joinError.textContent = message; });

  socket.on('game:state', state => {
    currentState = state;
    if (!joined) return;
    if (state.phase === 'lobby' || state.phase === 'no-game') {
      showOnly('waitingView');
    } else if (state.phase === 'question') {
      if (lastQuestionIndex !== state.questionIndex) {
        lastQuestionIndex = state.questionIndex;
        selectedChoice = null;
      }
      renderQuestion(state);
    } else if (state.phase === 'leaderboard') {
      renderLeaderboard(state, false);
    } else if (state.phase === 'ready') {
      showOnly('waitingView');
      $('waitingView').querySelector('h1').textContent = '本題已結算';
      $('waitingView').querySelector('.muted').textContent = '休息一下，下一題即將開始！';
    } else if (state.phase === 'finished') {
      renderLeaderboard(state, true);
    }
  });

  function renderQuestion(state) {
    showOnly('questionView');
    const q = state.question;
    $('questionBadge').textContent = state.isWarmup ? '暖身題' : '正式題';
    $('questionNumber').textContent = `第 ${state.questionIndex + 1} / 9 題`;
    $('questionText').textContent = q.question;
    $('answerStatus').textContent = selectedChoice === null ? '選出你認為正確的答案！' : '答案已送出！等待本題結算…';
    document.querySelectorAll('.answer-option').forEach((button, index) => {
      button.querySelector('.option-label').textContent = q.options[index];
      button.disabled = selectedChoice !== null;
      button.classList.toggle('selected', selectedChoice === index);
    });
    startTimer(state.endsAt);
  }

  function markSelected() {
    document.querySelectorAll('.answer-option').forEach((button, index) => {
      button.disabled = selectedChoice !== null;
      button.classList.toggle('selected', selectedChoice === index);
    });
  }

  document.querySelectorAll('.answer-option').forEach(button => {
    button.addEventListener('click', () => {
      if (!currentState || currentState.phase !== 'question' || selectedChoice !== null) return;
      const choice = Number(button.dataset.choice);
      selectedChoice = choice;
      markSelected();
      $('answerStatus').textContent = '答案已送出！等待本題結算…';
      socket.emit('player:answer', { choice });
    });
  });

  function startTimer(endsAt) {
    if (timerFrame) cancelAnimationFrame(timerFrame);
    const tick = () => {
      if (!currentState || currentState.phase !== 'question') return;
      const remaining = Math.max(0, endsAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      $('timerText').textContent = seconds;
      $('timerBar').style.width = `${Math.max(0, remaining / 10_000 * 100)}%`;
      $('timerText').style.color = seconds <= 3 ? '#ff718f' : '#ffcb52';
      if (remaining > 0) timerFrame = requestAnimationFrame(tick);
      else $('answerStatus').textContent = selectedChoice === null ? '時間到！等待公布答案…' : '時間到！答案即將公布…';
    };
    tick();
  }

  function renderLeaderboard(state, final) {
    if (timerFrame) cancelAnimationFrame(timerFrame);
    showOnly(final ? 'finishedView' : 'leaderboardView');
    const q = state.question;
    if (!final) {
      $('leaderEyebrow').textContent = state.isWarmup ? 'WARM-UP RESULT' : `QUESTION ${state.questionIndex} RESULT`;
      $('leaderTitle').textContent = '本題排行榜';
      if (q) $('correctReveal').innerHTML = `正確答案：<strong class="correct-answer">${escapeHtml(q.options[q.correctIndex])}</strong>${q.explanation ? ` ・ ${escapeHtml(q.explanation)}` : ''}`;
      $('myRoundResult').textContent = myRankText(state.leaderboard);
      renderRows($('leaderboardList'), state.leaderboard);
    } else {
      $('finalMyResult').textContent = myRankText(state.leaderboard);
      renderRows($('finalLeaderboardList'), state.leaderboard);
    }
  }

  function myRankText(rows) {
    const myRank = (rows || []).find(row => row.id === playerId);
    if (!myRank) return '本場排名：目前未進入前 10 名';
    return `目前排名第 ${myRank.rank} 名　｜　累積 ${myRank.score.toLocaleString()} 分`;
  }

  function renderRows(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.innerHTML = '<div class="rank-row"><span class="rank-number">—</span><span class="rank-name">尚無得分</span><span class="rank-score">0</span></div>';
      return;
    }
    rows.forEach((row, index) => {
      const item = document.createElement('div');
      item.className = 'rank-row';
      item.style.setProperty('--i', index);
      const medal = index === 0 ? '👑' : index === 1 ? '🥈' : index === 2 ? '🥉' : row.rank;
      item.innerHTML = `<span class="rank-number">${medal}</span><span class="rank-name"></span><span class="rank-score">${row.score.toLocaleString()} 分</span>`;
      item.querySelector('.rank-name').textContent = row.name;
      container.appendChild(item);
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
})();
