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

  const title = document.createElement('h2');
  title.textContent = 'Log in';

  const errorEl = document.createElement('div');
  errorEl.setAttribute('role', 'alert');
  errorEl.style.color = '#ff6b6b';
  errorEl.style.minHeight = '1.2em';

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'Email';
  emailInput.setAttribute('aria-label', 'Email');
  emailInput.required = true;

  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'Password';
  passwordInput.setAttribute('aria-label', 'Password');
  passwordInput.required = true;

  const submitButton = document.createElement('button');
  submitButton.setAttribute('aria-label', 'Submit');
  submitButton.type = 'submit';
  submitButton.textContent = 'Log in';

  const toggleButton = document.createElement('button');
  toggleButton.setAttribute('aria-label', 'Switch to sign up');
  toggleButton.type = 'button';
  toggleButton.textContent = 'Create account';

  const form = document.createElement('form');
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
