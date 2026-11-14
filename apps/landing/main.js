const scenarios = {
  health: {
    title: ['A little heads-up.', 'A lot less worry.'],
    body: 'Your Rhea loan is nearing your limit. You have idle USDC on Base that could help.',
    pill: 'Fix prepared',
    sign: 'You choose. You sign.',
  },
  balance: {
    title: ['A wider view.', 'A clearer next move.'],
    body: 'Your stablecoin mix is below the target you set. I’ve prepared a rebalance across your wallets.',
    pill: 'Plan prepared',
    sign: 'Your goals. Your call.',
  },
  privacy: {
    title: ['The whole picture.', 'For your eyes only.'],
    body: 'Wallets stay separate on-chain. Your agent brings the context together, with local checks and private AI.',
    pill: 'Private by design',
    sign: 'Your keys stay yours.',
  },
};

const message = document.querySelector('.agent-message');
const scene = document.querySelector('.demo-scene');
const scenarioButtons = [...document.querySelectorAll('.scenario-button')];
let activeScenario = 'health';

function setScenario(key) {
  if (!scenarios[key] || activeScenario === key) return;
  activeScenario = key;
  const data = scenarios[key];
  scene.dataset.scenario = key;
  for (const button of scenarioButtons) button.setAttribute('aria-pressed', String(button.dataset.scenario === key));
  const title = document.querySelector('.message-title');
  title.replaceChildren(document.createTextNode(`${data.title[0]} `), document.createElement('br'), document.createTextNode(data.title[1]));
  document.querySelector('.message-body').textContent = data.body;
  document.querySelector('.message-pill').lastChild.textContent = ` ${data.pill}`;
  document.querySelector('.message-sign').textContent = data.sign;
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && !document.body.classList.contains('motion-paused')) {
    message.animate([{ opacity: .25, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 330, easing: 'ease-out' });
  }
}

for (const button of scenarioButtons) button.addEventListener('click', () => setScenario(button.dataset.scenario));

const motionButton = document.querySelector('.motion-toggle');
motionButton.addEventListener('click', () => {
  const paused = document.body.classList.toggle('motion-paused');
  motionButton.setAttribute('aria-pressed', String(paused));
  motionButton.setAttribute('aria-label', paused ? 'Resume animation' : 'Pause animation');
  motionButton.querySelector('use').setAttribute('href', paused ? '#icon-play' : '#icon-pause');
});

const setupDialog = document.querySelector('#setup-dialog');
const privacyDialog = document.querySelector('#privacy-dialog');
function openDialog(dialog) {
  if (dialog.open) return;
  document.body.classList.add('modal-open');
  dialog.showModal();
}
for (const button of document.querySelectorAll('[data-open-setup]')) button.addEventListener('click', () => openDialog(setupDialog));
document.querySelector('[data-open-privacy]').addEventListener('click', () => openDialog(privacyDialog));
for (const dialog of [setupDialog, privacyDialog]) {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => document.body.classList.remove('modal-open'));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

const copyButton = document.querySelector('.copy-button');
copyButton.addEventListener('click', async () => {
  const status = document.querySelector('.copy-status');
  try {
    await navigator.clipboard.writeText(document.querySelector('#setup-code').textContent);
    copyButton.textContent = 'Copied ✓';
    status.textContent = 'Commands copied. Paste them into your terminal to try the demo.';
  } catch {
    status.textContent = 'Select the commands above and copy them to your terminal.';
  }
});

// No wallet APIs, tracking, financial data, or external agent connections run on this page.
