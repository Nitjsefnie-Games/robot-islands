import { applyStyle, COLOR, FONT, RADIUS, SHADOW, SPACE, Z } from './ui-tokens.js';

export interface MountAuthScreenOptions {
  onAuthed: () => void;
  fetchImpl?: typeof fetch;
}

export function mountAuthScreen(opts: MountAuthScreenOptions): HTMLElement {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onAuthed = opts.onAuthed;

  let mode: 'login' | 'signup' = 'login';

  const root = document.createElement('div');
  root.className = 'auth-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Authentication');
  applyStyle(root,
    'position:fixed',
    'inset:0',
    `z-index:${Z.modal}`,
    `background:${COLOR.scrim}`,
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'font-family:' + FONT.sans,
  );

  const title = document.createElement('h2');
  title.textContent = 'Log in';
  applyStyle(title,
    `color:${COLOR.accent}`,
    `font:${FONT.weight.bold} ${FONT.size.xxl}/1.2 ${FONT.sans}`,
    'text-align:center',
    'margin:0 0 ' + SPACE.px4,
  );

  const errorEl = document.createElement('div');
  errorEl.setAttribute('role', 'alert');
  applyStyle(errorEl,
    `color:${COLOR.danger}`,
    'min-height:1.4em',
    `font-size:${FONT.size.md}`,
    'text-align:center',
    'margin-bottom:' + SPACE.px3,
  );

  const inputStyle = [
    'width:100%',
    'box-sizing:border-box',
    `background:${COLOR.elev}`,
    `color:${COLOR.fg1}`,
    `border:1px solid ${COLOR.border}`,
    `border-radius:${RADIUS.sm}`,
    'padding:8px 10px',
    `font-size:${FONT.size.lg}`,
    'font-family:' + FONT.sans,
    'outline:none',
  ].join(';');

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'Email';
  emailInput.setAttribute('aria-label', 'Email');
  emailInput.required = true;
  emailInput.style.cssText = inputStyle;

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.setAttribute('aria-label', 'Password');
  passwordInput.required = true;
  passwordInput.style.cssText = inputStyle;

  const submitButton = document.createElement('button');
  submitButton.setAttribute('aria-label', 'Submit');
  submitButton.type = 'submit';
  submitButton.textContent = 'Log in';
  applyStyle(submitButton,
    'width:100%',
    'box-sizing:border-box',
    `background:${COLOR.accentDim}`,
    `color:${COLOR.fg1}`,
    `border:1px solid ${COLOR.accent}`,
    `border-radius:${RADIUS.sm}`,
    'padding:10px 14px',
    `font:${FONT.weight.bold} ${FONT.size.lg}/1 ${FONT.sans}`,
    'cursor:pointer',
    'margin-top:' + SPACE.px2,
  );

  const toggleButton = document.createElement('button');
  toggleButton.setAttribute('aria-label', 'Switch to sign up');
  toggleButton.type = 'button';
  toggleButton.textContent = 'Create account';
  applyStyle(toggleButton,
    'width:100%',
    'box-sizing:border-box',
    `background:${COLOR.panelSolid}`,
    `color:${COLOR.fg2}`,
    `border:1px solid ${COLOR.borderStrong}`,
    `border-radius:${RADIUS.sm}`,
    'padding:8px 12px',
    `font-size:${FONT.size.md}`,
    'font-family:' + FONT.sans,
    'cursor:pointer',
    'margin-top:' + SPACE.px2,
  );

  const form = document.createElement('form');
  applyStyle(form,
    'width:min(360px, 90vw)',
    `background:${COLOR.panelSolid}`,
    `border:1px solid ${COLOR.borderStrong}`,
    `border-radius:${RADIUS.lg}`,
    `padding:${SPACE.px6}`,
    `box-shadow:${SHADOW.pop}`,
    'display:flex',
    'flex-direction:column',
    'gap:' + SPACE.px2,
  );
  form.appendChild(errorEl);
  form.appendChild(emailInput);
  form.appendChild(passwordInput);
  form.appendChild(submitButton);
  form.appendChild(toggleButton);

  root.appendChild(title);
  root.appendChild(form);

  function updateLabels(): void {
    const isLogin = mode === 'login';
    title.textContent = isLogin ? 'Log in' : 'Sign up';
    submitButton.textContent = isLogin ? 'Log in' : 'Sign up';
    toggleButton.textContent = isLogin ? 'Create account' : 'Already have an account? Log in';
    toggleButton.setAttribute('aria-label', isLogin ? 'Switch to sign up' : 'Switch to log in');
  }

  toggleButton.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    errorEl.textContent = '';
    updateLabels();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.textContent = '';

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      errorEl.textContent = 'Email and password are required.';
      return;
    }

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      if (response.ok) {
        onAuthed();
      } else {
        const text = await response.text();
        errorEl.textContent = text || `Request failed (${response.status})`;
      }
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Network error';
    }
  });

  updateLabels();
  return root;
}
