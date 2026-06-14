// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAuthScreen } from './auth-ui.js';

function getInput(root: HTMLElement, label: string): HTMLInputElement {
  const input = root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  return input!;
}

function getButton(root: HTMLElement, label: string): HTMLButtonElement {
  const button = root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  return button!;
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('mountAuthScreen', () => {
  let container: HTMLElement;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let onAuthed: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchImpl = vi.fn();
    onAuthed = vi.fn();
  });

  afterEach(() => {
    container.remove();
    vi.resetAllMocks();
  });

  function mount(): HTMLElement {
    const root = mountAuthScreen({ onAuthed, fetchImpl });
    container.appendChild(root);
    return root;
  }

  it('submits login credentials to /api/auth/login and calls onAuthed on 2xx', async () => {
    fetchImpl.mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    const root = mount();
    typeInto(getInput(root, 'Email'), 'user@example.com');
    typeInto(getInput(root, 'Password'), 'secret123');
    getButton(root, 'Submit').click();

    await vi.waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'user@example.com',
      password: 'secret123',
    });
  });

  it('submits signup credentials to /api/auth/signup and calls onAuthed on 2xx', async () => {
    fetchImpl.mockResolvedValue({ ok: true, status: 201, text: async () => '' } as Response);

    const root = mount();
    getButton(root, 'Switch to sign up').click();

    typeInto(getInput(root, 'Email'), 'new@example.com');
    typeInto(getInput(root, 'Password'), 'hunter2');
    getButton(root, 'Submit').click();

    await vi.waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/signup');
  });

  it('shows a 401 error and does not call onAuthed', async () => {
    // The server returns a JSON error body ({ error: '…' }); the banner must
    // render that message, not the raw JSON string.
    fetchImpl.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid credentials' }),
    } as unknown as Response);

    const root = mount();
    typeInto(getInput(root, 'Email'), 'bad@example.com');
    typeInto(getInput(root, 'Password'), 'wrong');
    getButton(root, 'Submit').click();

    await vi.waitFor(() => {
      const errorEl = root.querySelector('[role="alert"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toContain('Invalid credentials');
    });

    expect(onAuthed).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    fetchImpl.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    const root = mount();
    typeInto(getInput(root, 'Email'), 'bad@example.com');
    typeInto(getInput(root, 'Password'), 'wrong');
    getButton(root, 'Submit').click();

    await vi.waitFor(() => {
      const errorEl = root.querySelector('[role="alert"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toContain('Request failed (500)');
    });

    expect(onAuthed).not.toHaveBeenCalled();
  });

  it('toggles between login and signup endpoints', async () => {
    fetchImpl.mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    const root = mount();
    typeInto(getInput(root, 'Email'), 'u@example.com');
    typeInto(getInput(root, 'Password'), 'pw');

    // Default is login.
    getButton(root, 'Submit').click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/auth/login');

    // Switch to signup and submit again.
    fetchImpl.mockClear();
    getButton(root, 'Switch to sign up').click();
    getButton(root, 'Submit').click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/auth/signup');
  });
});
