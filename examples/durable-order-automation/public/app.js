const source = document.querySelector('#source');
const runButton = document.querySelector('#run');
const statusBadge = document.querySelector('#status');
const runIdLabel = document.querySelector('#run-id');
const emptyState = document.querySelector('#empty-state');
const approval = document.querySelector('#approval');
const result = document.querySelector('#result');
const message = document.querySelector('#message');
const themeToggle = document.querySelector('#theme-toggle');

let current = null;
let pollTimer;
let renderedApprovalKey = null;

const setTheme = (theme, persist = false) => {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.setAttribute(
    'aria-label',
    `Switch to ${isDark ? 'light' : 'dark'} theme`,
  );
  themeToggle.textContent = `${isDark ? 'Light' : 'Dark'} theme`;

  if (persist) {
    try {
      window.localStorage.setItem(
        'durable-order-theme',
        isDark ? 'dark' : 'light',
      );
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }
};

setTheme(document.documentElement.dataset.theme);
themeToggle.addEventListener('click', () => {
  setTheme(
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark',
    true,
  );
});

const setTimeline = (...complete) => {
  for (const item of document.querySelectorAll('.timeline li')) {
    item.classList.toggle('complete', complete.includes(item.dataset.event));
  }
};

const setStatus = (value, label = value) => {
  statusBadge.className = `status ${value}`;
  statusBadge.textContent = label;
};

const showMessage = text => {
  message.textContent = text;
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    message.textContent = '';
  }, 4000);
};

const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed.');
  return body;
};

const renderApproval = state => {
  approval.replaceChildren();
  approval.hidden = false;
  emptyState.hidden = true;
  result.hidden = true;

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = `APPROVAL ROUND ${state.round}`;
  approval.append(eyebrow);

  const heading = document.createElement('h3');
  heading.textContent =
    state.requests.length === 1
      ? 'Refund requested'
      : `${state.requests.length} refunds requested`;
  approval.append(heading);

  const decisions = new Map();
  for (const approvalRequest of state.requests) {
    const card = document.createElement('fieldset');
    card.className = 'approval-card';

    const legend = document.createElement('legend');
    legend.textContent = `${approvalRequest.orderId} · $${approvalRequest.amount.toFixed(2)}`;
    card.append(legend);

    const detail = document.createElement('p');
    detail.textContent = approvalRequest.hostFunctionName;
    card.append(detail);

    const choices = document.createElement('div');
    choices.className = 'choice-row';
    for (const [label, approved] of [
      ['Reject', false],
      ['Approve', true],
    ]) {
      const choice = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = approvalRequest.id;
      input.addEventListener('change', () => {
        decisions.set(approvalRequest.id, approved);
        submit.disabled = decisions.size !== state.requests.length;
      });
      choice.append(input, document.createTextNode(label));
      choices.append(choice);
    }
    card.append(choices);
    approval.append(card);
  }

  const submit = document.createElement('button');
  submit.className = 'primary approval-submit';
  submit.disabled = true;
  submit.textContent =
    state.requests.length === 1
      ? 'Submit decision'
      : `Submit ${state.requests.length} decisions`;
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      await request(`/api/automations/${current.automationId}/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-demo-role': 'approver',
        },
        body: JSON.stringify({
          decisions: [...decisions].map(([interruptionId, approved]) => ({
            interruptionId,
            approved,
          })),
        }),
      });
      approval.hidden = true;
      setStatus('running', 'Resuming');
      setTimeline('started', 'sandbox', 'approval', 'resumed');
      showMessage('Decision accepted. The durable workflow is resuming.');
      await poll();
    } catch (error) {
      submit.disabled = false;
      showMessage(error.message);
    }
  });
  approval.append(submit);
};

const renderState = state => {
  if (state.status === 'waiting_for_approval') {
    setStatus('waiting', 'Waiting for approval');
    setTimeline('started', 'sandbox', 'approval');
    const approvalKey = `${state.round}:${state.requests
      .map(request => request.id)
      .join(',')}`;
    if (renderedApprovalKey !== approvalKey) {
      renderedApprovalKey = approvalKey;
      renderApproval(state);
    }
    return true;
  }

  renderedApprovalKey = null;
  approval.hidden = true;
  emptyState.hidden = true;
  if (state.status === 'completed') {
    setStatus('completed', 'Completed');
    setTimeline('started', 'sandbox', 'approval', 'resumed', 'completed');
    result.hidden = false;
    result.textContent = JSON.stringify(state.result, null, 2);
    return false;
  }
  if (state.status === 'failed' || state.status === 'cancelled') {
    setStatus('failed', state.status);
    result.hidden = false;
    result.textContent = state.error
      ? `${state.error.code}: ${state.error.message}`
      : 'The durable workflow did not complete.';
    return false;
  }

  setStatus('running', 'Running');
  setTimeline('started', 'sandbox');
  return true;
};

const poll = async () => {
  window.clearTimeout(pollTimer);
  if (!current) return;
  let shouldContinuePolling = true;
  try {
    const state = await request(
      `/api/automations/${current.automationId}?runId=${encodeURIComponent(current.runId)}`,
      { headers: { 'x-demo-role': 'tenant-user' } },
    );
    shouldContinuePolling = renderState(state);
  } catch (error) {
    showMessage(error.message);
  }
  if (shouldContinuePolling) {
    pollTimer = window.setTimeout(poll, 1000);
  }
};

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  renderedApprovalKey = null;
  result.hidden = true;
  approval.hidden = true;
  emptyState.hidden = false;
  emptyState.textContent = 'Starting the durable workflow…';
  setStatus('running', 'Starting');
  setTimeline();

  try {
    current = await request('/api/automations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-demo-role': 'tenant-user',
      },
      body: JSON.stringify({ source: source.value }),
    });
    runIdLabel.textContent = current.runId;
    const url = new URL(window.location.href);
    url.searchParams.set('automation', current.automationId);
    url.searchParams.set('run', current.runId);
    window.history.replaceState(null, '', url);
    await poll();
  } catch (error) {
    setStatus('failed', 'Failed');
    emptyState.textContent = error.message;
  } finally {
    runButton.disabled = false;
  }
});

const initialize = async () => {
  const data = await request('/api/example-source');
  source.value = data.source.trim();

  const url = new URL(window.location.href);
  const automationId = url.searchParams.get('automation');
  const runId = url.searchParams.get('run');
  if (automationId && runId) {
    current = { automationId, runId };
    runIdLabel.textContent = runId;
    await poll();
  }
};

initialize().catch(error => showMessage(error.message));
